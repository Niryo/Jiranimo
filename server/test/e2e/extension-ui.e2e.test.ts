/**
 * E2E tests for the Chrome extension UI.
 * Uses Playwright to render a mock Jira board, inject extension scripts,
 * and take real PNG screenshots of the config modal and badges.
 */

import { describe, it, expect, afterAll, beforeAll, beforeEach } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { mkdirSync, rmSync, existsSync } from 'node:fs';

const EXTENSION_DIR = resolve(import.meta.dirname, '..', '..', '..', 'extension');
const FIXTURES_DIR = resolve(import.meta.dirname, 'fixtures');
const SCREENSHOTS_DIR = resolve(import.meta.dirname, 'screenshots', 'extension-ui');

let browser: Browser;
let server: Server;
let serverPort: number;
let stepCounter = 0;
let mockSprintIssues: Array<{ key: string; fields: { summary: string; labels: string[] } }> = [];
let mockIssueStatuses: Record<string, string> = {};
let mockSyncTasks: Array<Record<string, unknown>> = [];
let mockPendingEffects: Array<Record<string, unknown>> = [];
let mockServerEpoch = 0;
let mockServerRevision = 0;
let boardRequestCount = 0;
let mockBoardPresencePayloads: Array<Record<string, unknown>> = [];

function resetMockSprintIssues() {
  mockSprintIssues = [
    { key: 'JTEST-101', fields: { summary: 'Add user authentication flow', labels: ['frontend'] } },
    { key: 'JTEST-102', fields: { summary: 'Update README with setup instructions', labels: [] } },
    { key: 'JTEST-103', fields: { summary: 'Fix pagination bug on search results', labels: ['bug'] } },
    { key: 'JTEST-100', fields: { summary: 'Set up CI/CD pipeline', labels: [] } },
  ];
}

function resetMockIssueStatuses() {
  mockIssueStatuses = {
    'JTEST-100': 'In Progress',
    'JTEST-101': 'To Do',
    'JTEST-102': 'To Do',
    'JTEST-103': 'To Do',
  };
}

function resetMockSyncState() {
  mockSyncTasks = [];
  mockPendingEffects = [];
  mockServerEpoch = 0;
  mockServerRevision = 0;
  mockBoardPresencePayloads = [];
}

const BOARD_URL = () => `http://127.0.0.1:${serverPort}/jira/software/projects/JTEST/boards/1`;
const extUrl = (path: string) => `http://127.0.0.1:${serverPort}/ext/${path}`;

function screenshotPath(testName: string, phase: string): string {
  stepCounter++;
  const dir = join(SCREENSHOTS_DIR, testName);
  mkdirSync(dir, { recursive: true });
  return join(dir, `${String(stepCounter).padStart(2, '0')}-${phase}.png`);
}

function startMockServer(): Promise<number> {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      if (req.url?.startsWith('/jira/software/projects/JTEST/boards/1')) {
        boardRequestCount++;
      }
      if (req.url?.startsWith('/ext/')) {
        try {
          const content = readFileSync(join(EXTENSION_DIR, req.url.slice(5)), 'utf-8');
          res.writeHead(200, { 'Content-Type': req.url.endsWith('.css') ? 'text/css' : 'application/javascript' });
          res.end(content);
        } catch { res.writeHead(404); res.end(); }
        return;
      }
      if (req.url?.match(/\/rest\/agile\/1\.0\/board\/\d+$/)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 1,
          type: 'scrum',
          location: { projectKey: 'JTEST' },
        }));
        return;
      }
      // Mock Jira search API for label fetching
      if (req.url?.includes('/rest/api/3/search')) {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          const issues = mockSprintIssues.map(issue => ({
            key: issue.key,
            fields: { labels: issue.fields.labels },
          }));
          res.end(JSON.stringify({ issues }));
        });
        return;
      }
      // Mock Jira Agile API for active sprint
      if (req.url?.match(/\/rest\/agile\/1\.0\/board\/\d+\/sprint/)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ values: [{ id: 1, name: 'Sprint 1' }] }));
        return;
      }
      // Mock Jira Agile API for sprint issues (includes labels for filtering)
      if (req.url?.match(/\/rest\/agile\/1\.0\/sprint\/1\/issue/)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ issues: mockSprintIssues }));
        return;
      }
      if (req.method === 'GET' && req.url?.startsWith('/api/sync')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          serverEpoch: mockServerEpoch,
          revision: mockServerRevision,
          tasks: mockSyncTasks,
          pendingEffects: mockPendingEffects,
        }));
        return;
      }
      if (req.method === 'POST' && req.url?.match(/^\/api\/effects\/[^/]+\/claim$/)) {
        const effectId = req.url.match(/^\/api\/effects\/([^/]+)\/claim$/)?.[1];
        const effect = mockPendingEffects.find(candidate => candidate.id === effectId);
        if (!effect) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Effect not found' }));
          return;
        }
        effect.status = 'claimed';
        effect.claimedBy = 'test-client';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(effect));
        return;
      }
      if (req.method === 'POST' && req.url?.match(/^\/api\/effects\/[^/]+\/ack$/)) {
        const effectId = req.url.match(/^\/api\/effects\/([^/]+)\/ack$/)?.[1];
        mockPendingEffects = mockPendingEffects.filter(candidate => candidate.id !== effectId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ acked: true }));
        return;
      }
      // Mock individual Jira issue details (used by fetchIssueDetails on badge click)
      const issueMatch = req.url?.match(/\/rest\/api\/3\/issue\/(JTEST-\d+)/);
      if (issueMatch) {
        const key = issueMatch[1];
        const issue = mockSprintIssues.find(candidate => candidate.key === key);
        if (req.url?.endsWith('/transitions') && req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            transitions: [
              { id: '11', name: 'To Do' },
              { id: '21', name: 'In Progress' },
              { id: '31', name: 'Done' },
            ],
          }));
          return;
        }
        if (req.url?.endsWith('/transitions') && req.method === 'POST') {
          let body = '';
          req.on('data', chunk => body += chunk);
          req.on('end', () => {
            const transitionId = JSON.parse(body || '{}')?.transition?.id;
            mockIssueStatuses[key] = transitionId === '21' ? 'In Progress' : transitionId === '31' ? 'Done' : 'To Do';
            res.writeHead(204);
            res.end();
          });
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          key,
          fields: {
            summary: issue?.fields.summary || key,
            description: null,
            priority: { name: 'Medium' },
            issuetype: { name: 'Task' },
            labels: issue?.fields.labels || [],
            comment: { comments: [] },
            status: { name: mockIssueStatuses[key] || 'To Do' },
            subtasks: [],
            parent: null,
            issuelinks: [],
            assignee: null,
            reporter: null,
            components: [],
            attachment: [],
          },
        }));
        return;
      }
      // Mock Jiranimo server API (badge click posts task here)
      if (req.method === 'POST' && req.url === '/api/tasks') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ queued: true }));
        return;
      }
      if (req.method === 'PUT' && req.url === '/api/boards/1/presence') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
          mockBoardPresencePayloads.push(JSON.parse(body || '{}'));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            boardKey: '127.0.0.1:1',
            syncedAt: new Date().toISOString(),
            deletedTaskKeys: [],
            updatedTaskKeys: [],
          }));
        });
        return;
      }
      // Mock Jira Agile API for board configuration
      if (req.url?.match(/\/rest\/agile\/.*\/board\/\d+\/configuration/)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          columnConfig: {
            columns: [
              { name: 'To Do' },
              { name: 'In Progress' },
              { name: 'testos' },
              { name: 'in review' },
              { name: 'Done' },
            ],
          },
        }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(readFileSync(join(FIXTURES_DIR, 'mock-jira-board.html'), 'utf-8'));
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve(typeof addr === 'object' && addr ? addr.port : 0);
    });
  });
}

async function setupChromeMock(page: Page) {
  await page.evaluate(() => {
    (window as any).__jiranimoStorage = {};
    (window as any).chrome = {
      storage: {
        local: {
          get: (keys: string | string[]) => {
            const s = (window as any).__jiranimoStorage;
            const result: Record<string, unknown> = {};
            const keyList = Array.isArray(keys) ? keys : typeof keys === 'string' ? [keys] : [];
            for (const k of keyList) { if (s[k] !== undefined) result[k] = s[k]; }
            return Promise.resolve(result);
          },
          set: (items: Record<string, unknown>) => {
            Object.assign((window as any).__jiranimoStorage, items);
            return Promise.resolve();
          },
          remove: (key: string) => {
            delete (window as any).__jiranimoStorage[key];
            return Promise.resolve();
          },
        },
        onChanged: { addListener: () => {} },
      },
      runtime: {
        sendMessage: (msg: any, cb?: Function) => {
          const respond = (data: any) => { if (cb) cb(data); };
          setTimeout(() => {
            if (msg.type === 'get-board-columns') respond({ columns: ['To Do', 'In Progress', 'testos', 'in review', 'Done'] });
            else if (msg.type === 'get-transitions') respond({ transitions: [{ id: '11', name: 'To Do' }, { id: '21', name: 'In Progress' }, { id: '31', name: 'Done' }] });
            else if (msg.type === 'implement-task') respond({ success: true });
            else respond({});
          }, 50);
        },
        onMessage: { addListener: () => {} },
      },
    };
  });
}

async function presetBoardConfig(page: Page) {
  await page.evaluate(() => {
    (window as any).__jiranimoStorage['boardConfig_1'] = {
      boardId: '1', projectKey: 'JTEST', boardType: 'scrum',
      transitions: { inProgress: { name: 'In Progress', id: '21' }, inReview: { name: 'Done', id: '31' } },
    };
  });
}

async function injectScripts(page: Page) {
  await page.addStyleTag({ url: extUrl('content/content.css') });
  await page.addScriptTag({ url: extUrl('lib/adf-to-markdown.js') });
  await page.addScriptTag({ url: extUrl('lib/jira-api.js') });
  await page.addScriptTag({ url: extUrl('content/board-config.js') });
  await page.addScriptTag({ url: extUrl('content/content.js') });
}

async function setupPage(opts?: { presetConfig?: boolean }): Promise<Page> {
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto(BOARD_URL());
  await setupChromeMock(page);
  if (opts?.presetConfig) await presetBoardConfig(page);
  await injectScripts(page);
  return page;
}

beforeAll(async () => {
  if (existsSync(SCREENSHOTS_DIR)) rmSync(SCREENSHOTS_DIR, { recursive: true, force: true });
  mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  resetMockSprintIssues();
  resetMockIssueStatuses();
  resetMockSyncState();
  serverPort = await startMockServer();
  browser = await chromium.launch({ headless: process.env.PWHEADLESS !== 'false' });
});

beforeEach(() => {
  resetMockSprintIssues();
  resetMockIssueStatuses();
  resetMockSyncState();
  boardRequestCount = 0;
});

afterAll(async () => {
  await browser?.close();
  server?.close();
});

describe('Extension UI E2E', () => {
  it('shows config modal on first board visit', async () => {
    stepCounter = 0;
    const page = await browser.newPage();
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.goto(BOARD_URL());
    await page.screenshot({ path: screenshotPath('config-modal', 'bare-board'), fullPage: true });

    await setupChromeMock(page);
    await injectScripts(page);

    await page.waitForSelector('.jiranimo-config-overlay', { timeout: 5000 });
    await page.screenshot({ path: screenshotPath('config-modal', 'modal-shown'), fullPage: true });

    const modalText = await page.locator('.jiranimo-config-modal').textContent();
    expect(modalText).toContain('Configure Jiranimo');

    const options = await page.locator('#jiranimo-in-progress option').allTextContents();
    const trimmed = options.map(o => o.trim());
    expect(trimmed).toContain('In Progress');
    expect(trimmed).toContain('Done');
    expect(trimmed).toContain('testos');
    expect(trimmed).toContain('in review');

    await page.screenshot({ path: screenshotPath('config-modal', 'dropdowns-verified'), fullPage: true });
    await page.close();
  });

  it('saves config and dismisses modal', async () => {
    stepCounter = 0;
    const page = await browser.newPage();
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.goto(BOARD_URL());
    await setupChromeMock(page);
    await injectScripts(page);

    await page.waitForSelector('.jiranimo-config-overlay', { timeout: 5000 });
    await page.screenshot({ path: screenshotPath('config-save', 'before-save'), fullPage: true });

    await page.click('#jiranimo-save-config');
    await page.waitForSelector('.jiranimo-config-overlay', { state: 'hidden', timeout: 3000 });
    await page.screenshot({ path: screenshotPath('config-save', 'after-save'), fullPage: true });

    const overlay = await page.$('.jiranimo-config-overlay');
    expect(overlay).toBeNull();
    await page.close();
  });

  it('injects implement badges on every visible card', async () => {
    stepCounter = 0;
    const page = await setupPage({ presetConfig: true });

    await page.waitForSelector('[data-jiranimo]', { timeout: 5000 });
    await page.screenshot({ path: screenshotPath('badges', 'badges-injected'), fullPage: true });

    const badgeKeys = await page.locator('[data-jiranimo]').evaluateAll(
      els => els.map(el => el.getAttribute('data-jiranimo'))
    );
    await page.screenshot({ path: screenshotPath('badges', `found-${badgeKeys.length}-badges`), fullPage: true });

    expect(badgeKeys).toContain('JTEST-101');
    expect(badgeKeys).toContain('JTEST-102');
    expect(badgeKeys).toContain('JTEST-103');
    expect(badgeKeys).toContain('JTEST-100');
    expect(badgeKeys.length).toBe(4);

    await page.close();
  });

  it('badge shows correct initial state', async () => {
    stepCounter = 0;
    const page = await setupPage({ presetConfig: true });
    await page.waitForSelector('[data-jiranimo]', { timeout: 5000 });

    const badgeClass = await page.locator('[data-jiranimo="JTEST-101"]').getAttribute('class');
    expect(badgeClass).toContain('idle');

    const card = page.locator('[data-rbd-draggable-id="JTEST-101"]');
    await card.screenshot({ path: screenshotPath('badge-state', 'idle-badge-closeup') });
    await page.screenshot({ path: screenshotPath('badge-state', 'full-board-with-badges'), fullPage: true });
    await page.close();
  });

  it('clicking badge changes state to queued', async () => {
    stepCounter = 0;
    const page = await setupPage({ presetConfig: true });
    await page.waitForSelector('[data-jiranimo="JTEST-101"]', { timeout: 5000 });
    await page.screenshot({ path: screenshotPath('badge-click', 'before-click'), fullPage: true });

    await page.click('[data-jiranimo="JTEST-101"]');
    await page.waitForTimeout(500);
    await page.screenshot({ path: screenshotPath('badge-click', 'after-click'), fullPage: true });

    const badgeClass = await page.locator('[data-jiranimo="JTEST-101"]').getAttribute('class');
    expect(badgeClass).toContain('queued');

    const card = page.locator('[data-rbd-draggable-id="JTEST-101"]');
    await card.screenshot({ path: screenshotPath('badge-click', 'queued-badge-closeup') });
    await page.close();
  });

  it('keeps badge injection working even when label elements are removed', async () => {
    stepCounter = 0;
    const page = await setupPage({ presetConfig: true });
    await page.waitForSelector('[data-jiranimo]', { timeout: 5000 });

    await page.evaluate(() => {
      document.querySelectorAll('[data-testid="label"]').forEach(el => el.remove());
    });

    await page.evaluate(() => {
      const div = document.createElement('div');
      document.body.appendChild(div);
      div.remove();
    });
    await page.waitForTimeout(1000);

    const badgeKeys = await page.locator('[data-jiranimo]').evaluateAll(
      els => els.map(el => el.getAttribute('data-jiranimo'))
    );
    await page.screenshot({ path: screenshotPath('card-dom-detection', 'badges-still-present'), fullPage: true });

    expect(badgeKeys).toContain('JTEST-101');
    expect(badgeKeys).toContain('JTEST-102');
    expect(badgeKeys).toContain('JTEST-103');
    expect(badgeKeys).toContain('JTEST-100');

    const card = page.locator('[data-rbd-draggable-id="JTEST-101"]');
    await card.screenshot({ path: screenshotPath('card-dom-detection', 'badge-closeup-no-dom-labels') });

    await page.close();
  });

  it('never injects duplicate badges for the same issue', async () => {
    // Bug: Two "Implement" badges appeared on the same card because
    // multiple DOM elements matched card selectors (parent + child).
    stepCounter = 0;
    const page = await setupPage({ presetConfig: true });
    await page.waitForSelector('[data-jiranimo]', { timeout: 5000 });

    // Trigger multiple re-scans by mutating the DOM
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => {
        const div = document.createElement('div');
        document.body.appendChild(div);
        div.remove();
      });
      await page.waitForTimeout(600);
    }

    // Count badges per issue key — each key must have exactly 1 badge
    const badgeKeys = await page.locator('[data-jiranimo]').evaluateAll(
      els => els.map(el => el.getAttribute('data-jiranimo'))
    );
    const counts: Record<string, number> = {};
    for (const key of badgeKeys) {
      if (key) counts[key] = (counts[key] || 0) + 1;
    }

    await page.screenshot({ path: screenshotPath('no-duplicate-badges', 'after-multiple-scans'), fullPage: true });

    for (const [key, count] of Object.entries(counts)) {
      expect(count, `${key} should have exactly 1 badge`).toBe(1);
    }

    await page.close();
  });

  it('injects a badge for a new card added after initial load', async () => {
    stepCounter = 0;
    const page = await setupPage({ presetConfig: true });
    await page.waitForSelector('[data-jiranimo="JTEST-101"]', { timeout: 5000 });

    mockSprintIssues.push({
      key: 'JTEST-104',
      fields: { summary: 'New issue created after page load', labels: [] },
    });

    await page.evaluate(() => {
      const todoColumn = document.querySelector('.column');
      if (!todoColumn) throw new Error('To Do column not found');

      const card = document.createElement('div');
      card.className = 'card';
      card.setAttribute('data-testid', 'platform-board-kit.ui.card.card');
      card.setAttribute('data-rbd-draggable-id', 'JTEST-104');
      card.innerHTML = `
        <div class="card-summary">New issue created after page load</div>
        <div class="card-labels"></div>
        <div class="card-footer">
          <div class="card-key">JTEST-104</div>
          <div class="avatar"></div>
          <span class="priority">Medium</span>
        </div>
      `;

      todoColumn.appendChild(card);
    });

    await page.waitForSelector('[data-jiranimo="JTEST-104"]', { timeout: 5000 });
    await page.screenshot({ path: screenshotPath('dynamic-card-badges', 'new-card-badge-injected'), fullPage: true });

    const card = page.locator('[data-rbd-draggable-id="JTEST-104"]');
    await card.screenshot({ path: screenshotPath('dynamic-card-badges', 'new-card-closeup') });

    await page.close();
  });

  it('config modal shows ALL board columns including custom ones', async () => {
    // Bug: Extension only showed default columns (To Do, In Progress, Done)
    // because it fell back to hardcoded defaults when API call failed.
    // Fix: Fetch columns from Jira Agile API directly from the content script.
    stepCounter = 0;
    const page = await browser.newPage();
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.goto(BOARD_URL());
    await setupChromeMock(page);
    await injectScripts(page);

    await page.waitForSelector('.jiranimo-config-overlay', { timeout: 5000 });

    // Get ALL options from the first dropdown
    const options = await page.locator('#jiranimo-in-progress option').allTextContents();
    const trimmed = options.map(o => o.trim());

    await page.screenshot({ path: screenshotPath('all-columns-bug', 'modal-with-all-columns'), fullPage: true });

    // Must include custom columns, not just the 3 defaults
    expect(trimmed.length).toBeGreaterThan(4); // Skip + at least 4 real columns
    expect(trimmed).toContain('To Do');
    expect(trimmed).toContain('In Progress');
    expect(trimmed).toContain('testos');
    expect(trimmed).toContain('in review');
    expect(trimmed).toContain('Done');

    await page.close();
  });

  it('refreshes the board after applying a pipeline status transition', async () => {
    stepCounter = 0;
    const page = await browser.newPage();
    await page.addInitScript(() => {
      class FakeWebSocket {
        static instances = [];
        url;
        onopen;
        onmessage;
        onclose;
        onerror;

        constructor(url: string) {
          this.url = url;
          FakeWebSocket.instances.push(this);
          setTimeout(() => this.onopen?.(), 0);
        }

        close() {
          this.onclose?.();
        }

        send() {}
      }

      (window as any).__jiranimoTestEmitWsMessage = (payload: unknown) => {
        for (const socket of FakeWebSocket.instances) {
          socket.onmessage?.({ data: JSON.stringify(payload) });
        }
      };

      (window as any).WebSocket = FakeWebSocket;
    });

    await page.setViewportSize({ width: 1200, height: 800 });
    await page.goto(BOARD_URL());
    await setupChromeMock(page);
    await presetBoardConfig(page);
    await injectScripts(page);
    await page.waitForSelector('[data-jiranimo="JTEST-101"]', { timeout: 5000 });

    mockSyncTasks = [{ key: 'JTEST-101', status: 'in-progress' }];
    mockPendingEffects = [{
      id: 'effect-refresh-1',
      type: 'pipeline-status-sync',
      status: 'pending',
      taskKey: 'JTEST-101',
      jiraHost: `127.0.0.1:${serverPort}`,
      payload: { issueKey: 'JTEST-101', pipelineStatus: 'in-progress' },
    }];
    mockServerEpoch = 1;
    mockServerRevision = 1;

    await page.evaluate(() => {
      (window as any).__jiranimoTestEmitWsMessage({
        type: 'sync-needed',
        serverEpoch: 1,
        revision: 1,
      });
    });

    await expect.poll(() => boardRequestCount, { timeout: 5000 }).toBeGreaterThan(1);
    expect(mockIssueStatuses['JTEST-101']).toBe('In Progress');

    await page.close();
  });
});
