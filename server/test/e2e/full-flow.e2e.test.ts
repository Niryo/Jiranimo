/**
 * Black-box E2E: Full Jiranimo flow — real everything
 *
 * 1. Starts the real Jiranimo server against a temp git repo
 * 2. Launches a real Chromium browser with the extension loaded
 *    (persistent profile so Jira login is preserved between runs)
 * 3. Navigates to the real Jira board on jiranimoapp.atlassian.net
 * 4. Creates a real Jira ticket: "Create a file named success.txt"
 * 5. Reloads the board — the real extension injects an Implement badge
 * 6. Clicks the badge
 * 7. Waits for real Claude Code to run and commit success.txt
 * 8. Verifies success.txt was committed to a branch in the repo
 * 9. Cleans up: Jira ticket, temp repos, stops server
 */

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { chromium, type BrowserContext } from 'playwright';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
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
  cleanupTestIssues,
  cleanupStaleTestIssues,
} from './jira-helpers.js';

const JIRA_HOST = process.env.JIRA_HOST ?? 'jiranimoapp.atlassian.net';
const EXTENSION_DIR = resolve(import.meta.dirname, '..', '..', '..', 'extension');
// Persistent profile so Jira login survives between test runs
const PROFILE_DIR = resolve(homedir(), '.jiranimo', 'playwright-e2e-profile');

// ─── Git repo helpers ────────────────────────────────────────────────────────

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

  // Local bare repo as origin so Claude can push branches
  const remotePath = mkdtempSync(join(parentDir, 'remote-'));
  execFileSync('git', ['init', '--bare'], { cwd: remotePath });
  git(repoPath, 'remote', 'add', 'origin', remotePath);
  git(repoPath, 'push', '-u', 'origin', 'main');

  return repoPath;
}

// ─── Server helpers ──────────────────────────────────────────────────────────

async function startJiranimoServer(
  reposRoot: string,
): Promise<{ port: number; stop: () => Promise<void> }> {
  const stateDir = mkdtempSync(join(tmpdir(), 'jiranimo-ff-state-'));
  const store = new StateStore({ filePath: join(stateDir, 'state.json'), flushDelayMs: 0 });

  const config: ServerConfig = {
    claude: { maxBudgetUsd: 2.0 },
    pipeline: { concurrency: 1 },
    git: {
      branchPrefix: 'jiranimo/',
      defaultBaseBranch: 'main',
      pushRemote: 'origin',
      createDraftPr: false,
    },
    web: { port: 0, host: '127.0.0.1' },
  };

  const pipeline = new PipelineManager(store, config, { kind: 'repo-root', reposRoot });
  const app = createApp(store, pipeline);
  const httpServer = createServer(app as (req: IncomingMessage, res: ServerResponse) => void);
  attachWebSocket(httpServer, pipeline);

  const port = await new Promise<number>(res => {
    httpServer.listen(0, '127.0.0.1', () => {
      const addr = httpServer.address() as { port: number };
      res(addr.port);
    });
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

// ─── Jira board helpers ───────────────────────────────────────────────────────

async function getJtestBoardId(): Promise<number> {
  const res = await jiraRequest('GET', '/rest/agile/1.0/board?projectKeyOrId=JTEST');
  const data = await res.json();
  return data.values[0].id as number;
}

// ─── Globals ─────────────────────────────────────────────────────────────────

let context: BrowserContext;
let reposRoot: string;
let stopServer: () => Promise<void>;

beforeAll(async () => {
  const connected = await verifyConnection();
  expect(connected, 'Jira connection required — check .env.test').toBe(true);

  mkdirSync(PROFILE_DIR, { recursive: true });

  // Extensions require a persistent context (not a regular browser.launch)
  context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    slowMo: Number(process.env.PWSLOWMO ?? 0),
    args: [
      `--disable-extensions-except=${EXTENSION_DIR}`,
      `--load-extension=${EXTENSION_DIR}`,
    ],
  });
});

afterAll(async () => {
  // Close browser first so its WebSocket connections disconnect before server stops
  await Promise.race([
    context?.close(),
    new Promise<void>(r => setTimeout(r, 15_000)),
  ]);
  await Promise.race([
    stopServer?.(),
    new Promise<void>(r => setTimeout(r, 15_000)),
  ]);
  if (reposRoot) rmSync(reposRoot, { recursive: true, force: true });
  await Promise.allSettled([cleanupTestIssues(), cleanupStaleTestIssues()]);
}, 60_000);

// ─── Test ─────────────────────────────────────────────────────────────────────

describe('Full Flow E2E', () => {
  it('badge click → real Claude → success.txt committed to branch', async () => {
    await cleanupStaleTestIssues();

    // ── 1. Set up git repo ─────────────────────────────────────────────────
    reposRoot = mkdtempSync(join(tmpdir(), 'jiranimo-ff-repos-'));
    const repoPath = createPlaygroundRepo(reposRoot);

    // ── 2. Start real Jiranimo server ──────────────────────────────────────
    const { port: serverPort, stop } = await startJiranimoServer(reposRoot);
    stopServer = stop;
    const serverUrl = `http://127.0.0.1:${serverPort}`;
    console.log(`[TEST] Server started on ${serverUrl}`);

    // ── 3. Get board ID + transitions from Jira ────────────────────────────
    const boardId = await getJtestBoardId();
    const boardUrl = `https://${JIRA_HOST}/jira/software/projects/JTEST/boards/${boardId}`;
    console.log(`[TEST] Board ID: ${boardId} → ${boardUrl}`);

    // Fetch transitions (create a temp issue, get its transitions, delete it)
    const tempKey = await createTestIssue({ summary: 'temp — transitions probe' });
    const transitions = await getTransitions(tempKey);
    const inProgress = transitions.find(t => t.name === 'In Progress');
    const done = transitions.find(t => t.name === 'Done');

    // ── 4. Configure extension via options page ────────────────────────────
    // Service workers (MV3) go dormant immediately — evaluating on them hangs.
    // The options page runs in the full extension context, so chrome.storage works.
    const sw = context.serviceWorkers()[0]
      ?? await context.waitForEvent('serviceworker', { timeout: 10_000 }).catch(() => null);

    const extId = sw?.url().match(/chrome-extension:\/\/([^/]+)/)?.[1];
    if (extId) {
      const optionsPage = await context.newPage();
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
      console.log(`[TEST] Extension storage configured (ext: ${extId})`);
    } else {
      console.warn('[TEST] Extension not found — storage not configured');
    }

    // ── 5. Create real Jira ticket (in active sprint so it appears on board) ─
    const issueKey = await createTestIssue({
      summary: 'Create a file named success.txt',
      labels: ['ai-ready'],
      boardId,
    });
    console.log(`[TEST] Created Jira issue: ${issueKey}`);

    // ── 6. Navigate to real Jira board ─────────────────────────────────────
    const page = await context.newPage();
    page.on('console', msg => console.log(`[PAGE ${msg.type()}] ${msg.text()}`));
    page.on('pageerror', err => console.log(`[PAGEERROR] ${err.message}`));
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(boardUrl);

    // Helper: wait for login if Jira redirects to auth
    const ensureLoggedIn = async (label: string) => {
      if (!page.url().includes('atlassian.net/jira/')) {
        console.log(`\n[TEST] ⚠️  Not logged into Jira (${label}). Please log in in the browser window...`);
        await page.waitForURL('**/jira/**', { timeout: 120_000 });
        console.log('[TEST] Logged in — continuing');
      }
    };

    await ensureLoggedIn('initial navigation');

    // Let React fully render — limit to 8s (Jira has persistent XHR that never goes idle)
    await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});
    console.log(`[TEST] URL after load: ${page.url()}`);

    // If Jira shows "view does not exist" (boards/2/not-found), find the real board URL.
    // Resolved board URL is stored here so the reload below uses it directly.
    let resolvedBoardUrl = page.url();

    if (resolvedBoardUrl.includes('/not-found')) {
      console.log(`[TEST] Jira view error — resolving correct board URL`);
      // Strip /not-found suffix to get boards/{id} base, then try common view names
      const boardBase = resolvedBoardUrl.replace(/\/not-found.*$/, '');
      for (const view of ['board', 'backlog', '']) {
        const tryUrl = view ? `${boardBase}/${view}` : boardBase;
        await page.goto(tryUrl, { waitUntil: 'domcontentloaded' });
        await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});
        await ensureLoggedIn(`after navigate to ${view || 'base'}`);
        if (!page.url().includes('/not-found')) {
          resolvedBoardUrl = page.url();
          console.log(`[TEST] Resolved board URL: ${resolvedBoardUrl}`);
          break;
        }
      }
    }

    // ── 7. Ensure we're on the resolved board URL with fresh data ────────────
    if (page.url() !== resolvedBoardUrl) {
      // Not yet on the correct URL — navigate there
      await page.goto(resolvedBoardUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await ensureLoggedIn('after refresh');
      await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});
    }
    // Already on the board — just give it a moment to settle
    await page.waitForTimeout(2_000);

    const screenshotsDir = resolve(import.meta.dirname, 'screenshots', 'full-flow', issueKey);
    mkdirSync(screenshotsDir, { recursive: true });
    await page.screenshot({ path: join(screenshotsDir, '01-board-loaded.png'), fullPage: true });
    console.log(`[TEST] Board loaded — waiting for badge on ${issueKey}`);

    // ── 8. Wait for extension to inject badge on our ticket ────────────────
    // Extension fetches Jira labels via API — allow up to 60s for board + extension to load
    await page.waitForSelector(`[data-jiranimo="${issueKey}"]`, { timeout: 60_000 });
    await page.screenshot({ path: join(screenshotsDir, '02-badge-visible.png'), fullPage: true });
    console.log('[TEST] Badge visible — clicking');

    // ── 9. Click the badge ─────────────────────────────────────────────────
    await page.click(`[data-jiranimo="${issueKey}"]`);
    await page.waitForTimeout(1500);
    await page.screenshot({ path: join(screenshotsDir, '03-badge-clicked.png'), fullPage: true });

    const badgeClass = await page.locator(`[data-jiranimo="${issueKey}"]`).getAttribute('class');
    let debugState: any = null;
    for (let i = 0; i < 10; i++) {
      debugState = await page.evaluate(() => {
        const raw = document.documentElement.getAttribute('data-jiranimo-debug');
        return raw ? JSON.parse(raw) : null;
      });
      if (debugState?.stage === 'task-submitted' || debugState?.stage === 'submit-failed' || debugState?.stage === 'submit-exception' || debugState?.stage === 'fetch-issue-failed') {
        break;
      }
      await page.waitForTimeout(500);
    }
    console.log(`[TEST] Debug state after click: ${JSON.stringify(debugState)}`);
    expect(badgeClass, 'Badge should have left idle after click').not.toContain('idle');
    console.log(`[TEST] Badge state after click: ${badgeClass}`);
    if (debugState?.stage && debugState.stage !== 'task-submitted') {
      throw new Error(`Task submission failed early: ${JSON.stringify(debugState)}`);
    }

    // ── 10. Poll server until Claude completes ─────────────────────────────
    console.log('[TEST] Waiting for real Claude to complete (up to 10 min)...');
    let task: any;
    for (let i = 0; i < 120; i++) {
      await new Promise(r => setTimeout(r, 5000));
      const res = await fetch(`${serverUrl}/api/tasks/${issueKey}`);
      if (!res.ok) continue;
      task = await res.json();
      console.log(`[TEST] Poll ${i + 1}/120: status = ${task.status}`);
      if (task.status === 'completed' || task.status === 'failed') break;
    }

    await page.screenshot({ path: join(screenshotsDir, '04-task-done.png'), fullPage: true });

    // ── 11. Verify success.txt was committed ───────────────────────────────
    expect(task.status, `Task failed: ${task.errorMessage ?? ''}`).toBe('completed');

    const branches = git(repoPath, 'branch', '--list')
      .split('\n')
      .map(b => b.replace(/^\*?\s+/, '').trim())
      .filter(b => b.startsWith('jiranimo/'));

    expect(branches.length, 'Expected at least one jiranimo/ branch').toBeGreaterThan(0);
    const branch = branches[0];
    console.log(`[TEST] Verifying success.txt on branch: ${branch}`);

    const fileContent = git(repoPath, 'show', `${branch}:success.txt`);
    expect(fileContent.trim()).toBe('success');

    console.log(`[TEST] ✓ success.txt confirmed on ${branch}`);
    await page.close();
  }, 12 * 60 * 1000); // 12 minutes for real Claude
});
