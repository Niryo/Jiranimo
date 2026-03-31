/**
 * E2E tests for the Chrome extension UI.
 * Uses Playwright to render a mock Jira board, inject extension scripts,
 * and take real PNG screenshots of the config modal and badges.
 */

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
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
      if (req.url?.startsWith('/ext/')) {
        try {
          const content = readFileSync(join(EXTENSION_DIR, req.url.slice(5)), 'utf-8');
          res.writeHead(200, { 'Content-Type': req.url.endsWith('.css') ? 'text/css' : 'application/javascript' });
          res.end(content);
        } catch { res.writeHead(404); res.end(); }
        return;
      }
      // Mock Jira search API for label fetching
      if (req.url?.includes('/rest/api/3/search')) {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          // Return labels for mock issues
          const issues = [
            { key: 'JTEST-101', fields: { labels: ['ai-ready', 'frontend'] } },
            { key: 'JTEST-102', fields: { labels: [] } },
            { key: 'JTEST-103', fields: { labels: ['ai-ready', 'bug'] } },
            { key: 'JTEST-100', fields: { labels: ['ai-ready'] } },
          ];
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
        res.end(JSON.stringify({
          issues: [
            { key: 'JTEST-101', fields: { summary: 'Add user authentication flow', labels: ['ai-ready', 'frontend'] } },
            { key: 'JTEST-102', fields: { summary: 'Update README with setup instructions', labels: [] } },
            { key: 'JTEST-103', fields: { summary: 'Fix pagination bug on search results', labels: ['ai-ready', 'bug'] } },
            { key: 'JTEST-100', fields: { summary: 'Set up CI/CD pipeline', labels: ['ai-ready'] } },
          ],
        }));
        return;
      }
      // Mock individual Jira issue details (used by fetchIssueDetails on badge click)
      const issueMatch = req.url?.match(/\/rest\/api\/3\/issue\/(JTEST-\d+)/);
      if (issueMatch) {
        const key = issueMatch[1];
        const summaries: Record<string, string> = {
          'JTEST-100': 'Set up CI/CD pipeline',
          'JTEST-101': 'Add user authentication flow',
          'JTEST-102': 'Update README with setup instructions',
          'JTEST-103': 'Fix pagination bug on search results',
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          key,
          fields: {
            summary: summaries[key] || key,
            description: null,
            priority: { name: 'Medium' },
            issuetype: { name: 'Task' },
            labels: [],
            comment: { comments: [] },
            status: { name: 'To Do' },
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
      boardId: '1', projectKey: 'JTEST', triggerLabel: 'ai-ready',
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
  serverPort = await startMockServer();
  browser = await chromium.launch({ headless: process.env.PWHEADLESS !== 'false' });
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

  it('injects implement badges on cards with ai-ready label', async () => {
    stepCounter = 0;
    const page = await setupPage({ presetConfig: true });

    await page.waitForSelector('[data-jiranimo]', { timeout: 5000 });
    await page.screenshot({ path: screenshotPath('badges', 'badges-injected'), fullPage: true });

    const badgeKeys = await page.locator('[data-jiranimo]').evaluateAll(
      els => els.map(el => el.getAttribute('data-jiranimo'))
    );
    await page.screenshot({ path: screenshotPath('badges', `found-${badgeKeys.length}-badges`), fullPage: true });

    expect(badgeKeys).toContain('JTEST-101');
    expect(badgeKeys).toContain('JTEST-103');
    expect(badgeKeys).toContain('JTEST-100');
    expect(badgeKeys).not.toContain('JTEST-102');
    expect(badgeKeys.length).toBe(3);

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

  it('detects labels via API even when card DOM has no label text', async () => {
    // Bug: Jira board cards don't render label text in the DOM.
    // The extension must use the Jira API to check labels, not DOM scanning.
    stepCounter = 0;
    const page = await setupPage({ presetConfig: true });
    await page.waitForSelector('[data-jiranimo]', { timeout: 5000 });

    // JTEST-102 has NO label text in the mock DOM but the API says it has no ai-ready label
    // JTEST-101 has label text in the DOM AND the API confirms ai-ready
    // The key test: even if we remove all label text from the DOM, badges still appear
    // because they come from the API, not DOM text
    await page.evaluate(() => {
      // Remove all visible label elements from cards
      document.querySelectorAll('[data-testid="label"]').forEach(el => el.remove());
    });

    // Re-scan (trigger MutationObserver by adding a dummy element)
    await page.evaluate(() => {
      const div = document.createElement('div');
      document.body.appendChild(div);
      div.remove();
    });
    await page.waitForTimeout(1000);

    // Badges should STILL be present because labels come from API, not DOM
    const badgeKeys = await page.locator('[data-jiranimo]').evaluateAll(
      els => els.map(el => el.getAttribute('data-jiranimo'))
    );
    await page.screenshot({ path: screenshotPath('api-label-detection', 'badges-from-api-not-dom'), fullPage: true });

    expect(badgeKeys).toContain('JTEST-101');
    expect(badgeKeys).toContain('JTEST-103');
    expect(badgeKeys).toContain('JTEST-100');
    expect(badgeKeys).not.toContain('JTEST-102');

    const card = page.locator('[data-rbd-draggable-id="JTEST-101"]');
    await card.screenshot({ path: screenshotPath('api-label-detection', 'badge-closeup-no-dom-labels') });

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

  it('shows about overlay when cmd+e is pressed', async () => {
    stepCounter = 0;
    const page = await setupPage({ presetConfig: true });
    await page.waitForSelector('[data-jiranimo]', { timeout: 5000 });

    // No overlay initially
    expect(await page.$('.jiranimo-about-overlay')).toBeNull();
    await page.screenshot({ path: screenshotPath('about-overlay', 'before-shortcut'), fullPage: true });

    // Press cmd+e to open about overlay
    await page.keyboard.press('Meta+e');
    await page.waitForSelector('.jiranimo-about-overlay', { timeout: 3000 });
    await page.screenshot({ path: screenshotPath('about-overlay', 'overlay-shown'), fullPage: true });

    const title = await page.locator('.jiranimo-about-title').textContent();
    expect(title?.trim()).toBe('Jiranimo');

    const tagline = await page.locator('.jiranimo-about-tagline').textContent();
    expect(tagline).toContain('Claude Code');

    // Press Esc to close
    await page.keyboard.press('Escape');
    await page.waitForSelector('.jiranimo-about-overlay', { state: 'hidden', timeout: 3000 });
    expect(await page.$('.jiranimo-about-overlay')).toBeNull();
    await page.screenshot({ path: screenshotPath('about-overlay', 'after-close'), fullPage: true });

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
});
