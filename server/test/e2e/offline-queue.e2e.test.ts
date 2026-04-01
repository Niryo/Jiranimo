/**
 * Black-box E2E: Offline queue — server queues messages while browser is gone
 *
 * Scenario:
 * 1. Start real Jiranimo server + git repo
 * 2. Launch browser #1, configure extension, navigate to board
 * 3. Create a Jira ticket and click the Implement badge
 * 4. Immediately close browser #1 (WebSocket disconnects → server queues all events)
 * 5. Wait for Claude to complete the task (poll /api/tasks)
 * 6. Relaunch browser #2 with the same persistent profile (still logged into Jira)
 * 7. Extension reconnects → server drains the offline queue
 * 8. Extension receives update-jira-status → transitions Jira ticket to Done
 * 9. Assert: Jira issue status is Done via REST API
 */

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { resolve, join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { StateStore } from '../../src/state/store.js';
import { PipelineManager } from '../../src/pipeline/manager.js';
import { createApp } from '../../src/web/server.js';
import { attachWebSocket } from '../../src/web/ws-handler.js';
import type { ServerConfig } from '../../src/config/types.js';
import {
  verifyConnection,
  jiraRequest,
  createTestIssue,
  getTransitions,
  getIssue,
  cleanupTestIssues,
  cleanupStaleTestIssues,
} from './jira-helpers.js';

const JIRA_HOST = process.env.JIRA_HOST ?? 'jiranimoapp.atlassian.net';
const EXTENSION_DIR = resolve(import.meta.dirname, '..', '..', '..', 'extension');
const PROFILE_DIR = resolve(homedir(), '.jiranimo', 'playwright-e2e-profile');

// ─── Helpers (shared with full-flow) ─────────────────────────────────────────

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

function createPlaygroundRepo(parentDir: string): string {
  const repoPath = mkdtempSync(join(parentDir, 'playground-'));
  git(repoPath, 'init', '-b', 'main');
  git(repoPath, 'config', 'user.email', 'test@jiranimo.dev');
  git(repoPath, 'config', 'user.name', 'Jiranimo Test');
  writeFileSync(join(repoPath, 'README.md'), '# Playground\n');
  git(repoPath, 'add', '-A');
  git(repoPath, 'commit', '-m', 'Initial commit');
  const remotePath = mkdtempSync(join(parentDir, 'remote-'));
  execFileSync('git', ['init', '--bare'], { cwd: remotePath });
  git(repoPath, 'remote', 'add', 'origin', remotePath);
  git(repoPath, 'push', '-u', 'origin', 'main');
  return repoPath;
}

async function startJiranimoServer(reposRoot: string): Promise<{ port: number; stop: () => Promise<void> }> {
  const stateDir = mkdtempSync(join(tmpdir(), 'jiranimo-oq-state-'));
  const store = new StateStore({ filePath: join(stateDir, 'state.json'), flushDelayMs: 0 });
  const config: ServerConfig = {
    claude: { maxBudgetUsd: 2.0 },
    pipeline: { concurrency: 1 },
    git: { branchPrefix: 'jiranimo/', defaultBaseBranch: 'main', pushRemote: 'origin', createDraftPr: false },
    web: { port: 0, host: '127.0.0.1' },
  };
  const pipeline = new PipelineManager(store, config, { kind: 'repo-root', reposRoot });
  const app = createApp(store, pipeline);
  const httpServer = createServer(app as (req: IncomingMessage, res: ServerResponse) => void);
  attachWebSocket(httpServer, pipeline);
  const port = await new Promise<number>(res => {
    httpServer.listen(0, '127.0.0.1', () => res((httpServer.address() as { port: number }).port));
  });
  return {
    port,
    stop: async () => {
      store.destroy();
      await new Promise<void>(res => httpServer.close(() => res()));
      rmSync(stateDir, { recursive: true, force: true });
    },
  };
}

async function getJtestBoardId(): Promise<number> {
  const res = await jiraRequest('GET', '/rest/agile/1.0/board?projectKeyOrId=JTEST');
  const data = await res.json();
  return data.values[0].id as number;
}

function launchBrowser(): Promise<BrowserContext> {
  return chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    slowMo: Number(process.env.PWSLOWMO ?? 0),
    args: [
      `--disable-extensions-except=${EXTENSION_DIR}`,
      `--load-extension=${EXTENSION_DIR}`,
    ],
  });
}

async function closeBrowserSafely(ctx: BrowserContext): Promise<void> {
  await Promise.race([ctx.close(), new Promise<void>(r => setTimeout(r, 15_000))]);
  // Give the OS a moment to release the profile SingletonLock
  await new Promise(r => setTimeout(r, 2_000));
}

// Navigate to the board, handle Jira "view does not exist" redirect, handle login
async function navigateToBoard(page: Page, boardUrl: string): Promise<string> {
  await page.goto(boardUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});

  // Handle login redirect
  if (!page.url().includes('atlassian.net/jira/')) {
    console.log('[TEST] Not logged into Jira — waiting for login...');
    await page.waitForURL('**/jira/**', { timeout: 120_000 });
  }

  // Handle Jira "view does not exist" (boards/2 → boards/2/not-found)
  if (page.url().includes('/not-found')) {
    const boardBase = page.url().replace(/\/not-found.*$/, '');
    for (const view of ['board', 'backlog', '']) {
      const tryUrl = view ? `${boardBase}/${view}` : boardBase;
      await page.goto(tryUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});
      if (!page.url().includes('/not-found')) break;
    }
  }

  return page.url();
}

// ─── Globals ──────────────────────────────────────────────────────────────────

let reposRoot: string;
let stopServer: () => Promise<void>;

beforeAll(async () => {
  const connected = await verifyConnection();
  expect(connected, 'Jira connection required — check .env.test').toBe(true);
  mkdirSync(PROFILE_DIR, { recursive: true });
  // Remove stale SingletonLock so Chrome can launch fresh
  const lockFile = `${PROFILE_DIR}/SingletonLock`;
  if (existsSync(lockFile)) unlinkSync(lockFile);
});

afterAll(async () => {
  await Promise.race([stopServer?.(), new Promise<void>(r => setTimeout(r, 15_000))]);
  if (reposRoot) rmSync(reposRoot, { recursive: true, force: true });
  await Promise.allSettled([cleanupTestIssues(), cleanupStaleTestIssues()]);
}, 60_000);

// ─── Test ─────────────────────────────────────────────────────────────────────

describe('Offline Queue E2E', () => {
  it('server queues events while browser is closed, extension processes them on reconnect', async () => {
    const screenshotsDir = resolve(import.meta.dirname, 'screenshots', 'offline-queue');
    mkdirSync(screenshotsDir, { recursive: true });

    // ── 1. Set up git repo + server ────────────────────────────────────────
    reposRoot = mkdtempSync(join(tmpdir(), 'jiranimo-oq-repos-'));
    createPlaygroundRepo(reposRoot);

    const { port: serverPort, stop } = await startJiranimoServer(reposRoot);
    stopServer = stop;
    const serverUrl = `http://127.0.0.1:${serverPort}`;
    console.log(`[TEST] Server: ${serverUrl}`);

    // ── 2. Get board ID + transitions ──────────────────────────────────────
    const boardId = await getJtestBoardId();
    const boardUrl = `https://${JIRA_HOST}/jira/software/projects/JTEST/boards/${boardId}`;

    const tempKey = await createTestIssue({ summary: 'temp — transitions probe' });
    const transitions = await getTransitions(tempKey);
    const inProgress = transitions.find(t => t.name === 'In Progress');
    const done = transitions.find(t => t.name === 'Done');

    // ── 3. Launch browser #1, configure extension, navigate to board ───────
    console.log('[TEST] Launching browser #1...');
    let ctx = await launchBrowser();

    const sw = ctx.serviceWorkers()[0]
      ?? await ctx.waitForEvent('serviceworker', { timeout: 10_000 }).catch(() => null);
    const extId = sw?.url().match(/chrome-extension:\/\/([^/]+)/)?.[1];

    if (extId) {
      const optionsPage = await ctx.newPage();
      await optionsPage.goto(`chrome-extension://${extId}/options/options.html`);
      await optionsPage.evaluate(
        (data: Record<string, unknown>) => (window as any).chrome.storage.local.set(data),
        {
          serverUrl,
          [`boardConfig_${boardId}`]: {
            boardId: String(boardId),
            projectKey: 'JTEST',
            boardType: 'scrum',
            triggerLabel: 'ai-ready',
            transitions: {
              inProgress: inProgress ? { id: inProgress.id, name: inProgress.name } : null,
              inReview: done ? { id: done.id, name: done.name } : null,
            },
          },
        },
      );
      await optionsPage.close();
      console.log(`[TEST] Extension configured (ext: ${extId})`);
    }

    // ── 4. Create Jira issue in active sprint ──────────────────────────────
    const issueKey = await createTestIssue({
      summary: 'Create a file named success.txt',
      labels: ['ai-ready'],
      boardId,
    });
    console.log(`[TEST] Created issue: ${issueKey}`);

    // ── 5. Navigate to board and click the Implement badge ─────────────────
    const page = await ctx.newPage();
    await page.setViewportSize({ width: 1440, height: 900 });
    const resolvedBoardUrl = await navigateToBoard(page, boardUrl);
    console.log(`[TEST] On board: ${resolvedBoardUrl}`);
    await page.waitForTimeout(2_000);

    await page.screenshot({ path: join(screenshotsDir, '01-board-before-click.png'), fullPage: true });

    // Wait for extension to inject the badge
    await page.waitForSelector(`[data-jiranimo="${issueKey}"]`, { timeout: 60_000 });
    console.log(`[TEST] Badge visible for ${issueKey} — clicking`);
    await page.screenshot({ path: join(screenshotsDir, '02-badge-visible.png'), fullPage: true });

    await page.click(`[data-jiranimo="${issueKey}"]`);
    await page.waitForTimeout(1_000);
    await page.screenshot({ path: join(screenshotsDir, '03-badge-clicked.png'), fullPage: true });

    // Verify task was accepted by server
    const taskRes = await fetch(`${serverUrl}/api/tasks/${issueKey}`);
    if (taskRes.ok) {
      const task = await taskRes.json();
      console.log(`[TEST] Task status after click: ${task.status}`);
    }

    // ── 6. Close browser #1 — server will now queue all events ────────────
    console.log('[TEST] Closing browser #1 (simulating disconnect)...');
    await closeBrowserSafely(ctx);
    console.log('[TEST] Browser #1 closed. Server queueing events...');

    // ── 7. Wait for Claude to finish (poll server while browser is closed) ──
    console.log('[TEST] Waiting for Claude to complete (up to 10 min)...');
    let task: any;
    for (let i = 0; i < 120; i++) {
      await new Promise(r => setTimeout(r, 5_000));
      const res = await fetch(`${serverUrl}/api/tasks/${issueKey}`);
      if (!res.ok) continue;
      task = await res.json();
      console.log(`[TEST] Poll ${i + 1}/120: status = ${task.status}`);
      if (task.status === 'completed' || task.status === 'failed') break;
    }

    expect(task?.status, `Task did not complete: ${task?.errorMessage ?? 'unknown'}`).toBe('completed');
    console.log('[TEST] Task completed. Offline queue should have queued events.');

    // ── 8. Relaunch browser #2 with same profile ───────────────────────────
    console.log('[TEST] Launching browser #2 (reconnecting extension)...');
    ctx = await launchBrowser();

    const page2 = await ctx.newPage();
    await page2.setViewportSize({ width: 1440, height: 900 });
    await navigateToBoard(page2, resolvedBoardUrl);
    await page2.waitForTimeout(2_000);
    await page2.screenshot({ path: join(screenshotsDir, '04-reconnected-board.png'), fullPage: true });
    console.log('[TEST] Browser #2 on board — extension reconnecting to WebSocket...');

    // ── 9. Wait for extension to process queued events and transition Jira ──
    // The extension receives update-jira-status → calls transitionIssue via session cookies
    console.log('[TEST] Waiting for Jira transition (up to 30s)...');
    let jiraStatus = '';
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 1_000));
      const issueData = await getIssue(issueKey);
      const fields = issueData.fields as Record<string, any>;
      jiraStatus = fields.status?.name ?? '';
      console.log(`[TEST] Jira status check ${i + 1}/30: ${jiraStatus}`);
      if (jiraStatus === 'Done' || jiraStatus === 'In Review') break;
    }

    await page2.screenshot({ path: join(screenshotsDir, '05-after-reconnect.png'), fullPage: true });

    // ── 10. Assert Jira issue was transitioned ─────────────────────────────
    expect(jiraStatus, 'Jira issue should be Done or In Review after extension processes offline queue')
      .toMatch(/Done|In Review/);
    console.log(`[TEST] ✓ Jira issue ${issueKey} is "${jiraStatus}" after offline queue drain`);

    // Cleanup
    await closeBrowserSafely(ctx);
  }, 12 * 60 * 1000);
});
