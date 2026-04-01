/**
 * Full pipeline E2E test.
 *
 * Tests the complete flow:
 *   1. Create a Jira issue with "ai-ready" label
 *   2. Start the server pointing to a repos root (directory containing repos)
 *   3. Submit the task to the server (simulating extension)
 *   4. Fake Claude runs and completes the task
 *   5. Verify: task status is "completed" with results
 *   6. Clean up Jira issue
 *
 * Uses fake-claude (not real Claude) so it's fast and free.
 */

import { describe, it, expect, afterEach, afterAll, beforeAll } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
import { resolve } from 'node:path';
import {
  verifyConnection,
  createTestIssue,
  cleanupTestIssues,
  cleanupStaleTestIssues,
} from './jira-helpers.js';
import { initScreenshots, closeScreenshots, startSuite, startTest, screenshot } from './snapshots.js';
import { createTestRepo, type TestRepo } from './test-repo.js';
import { StateStore } from '../../src/state/store.js';
import { PipelineManager } from '../../src/pipeline/manager.js';
import { createApp } from '../../src/web/server.js';
import { attachWebSocket } from '../../src/web/ws-handler.js';
import type { ServerConfig } from '../../src/config/types.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let testRepo: TestRepo;
let reposRoot: string;
let store: StateStore;
let pipeline: PipelineManager;
let httpServer: HttpServer;
let serverPort: number;
let stateDir: string;

const FAKE_CLAUDE = `node ${resolve(import.meta.dirname, '..', 'fixtures', 'fake-claude.mjs')}`;

function makeConfig(reposRoot: string): ServerConfig {
  return {
    claude: {
      maxBudgetUsd: 1.0,
      command: FAKE_CLAUDE,
    },
    pipeline: { concurrency: 1 },
    git: {
      branchPrefix: 'jiranimo/',
      defaultBaseBranch: 'main',
      pushRemote: 'origin',
      createDraftPr: false,
    },
    web: { port: 0, host: '127.0.0.1' },
  };
}

async function startServer(config: ServerConfig): Promise<number> {
  stateDir = mkdtempSync(join(tmpdir(), 'jiranimo-e2e-state-'));
  store = new StateStore({ filePath: join(stateDir, 'state.json'), flushDelayMs: 0 });
  pipeline = new PipelineManager(store, config, { kind: 'repo-root', reposRoot });
  const app = createApp(store, pipeline);
  httpServer = createServer(app);
  attachWebSocket(httpServer, pipeline);

  return new Promise((resolve) => {
    httpServer.listen(0, '127.0.0.1', () => {
      const addr = httpServer.address();
      resolve(typeof addr === 'object' && addr ? addr.port : 0);
    });
  });
}

async function stopServer() {
  store?.destroy();
  await new Promise<void>((resolve) => httpServer?.close(() => resolve()));
  if (stateDir) rmSync(stateDir, { recursive: true, force: true });
}

beforeAll(async () => {
  const connected = await verifyConnection();
  expect(connected).toBe(true);
  await initScreenshots();
  startSuite('full-pipeline');
});

afterEach(async () => {
  await cleanupTestIssues();
  await stopServer();
  testRepo?.cleanup();
  if (reposRoot) rmSync(reposRoot, { recursive: true, force: true });
});

afterAll(async () => {
  await cleanupStaleTestIssues();
  await closeScreenshots();
});

describe('Full Pipeline E2E', () => {
  it('submits task and fake Claude completes it', async () => {
    startTest('submit-and-run');

    // Create a dedicated repos root with one test repo inside
    reposRoot = mkdtempSync(join(tmpdir(), 'jiranimo-e2e-repos-'));
    testRepo = createTestRepo(reposRoot);
    const config = makeConfig(reposRoot);
    serverPort = await startServer(config);

    await screenshot('step1-setup', {
      reposRoot,
      repoPath: testRepo.path,
      files: testRepo.listFiles(),
      serverPort,
    }, `Repos root: ${reposRoot}\nRepo: ${testRepo.path}\nFiles: ${testRepo.listFiles().join(', ')}\nServer: :${serverPort}`);

    const issueKey = await createTestIssue({
      summary: 'Create hello script',
      labels: ['ai-ready'],
    });

    const submitRes = await fetch(`http://127.0.0.1:${serverPort}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        key: issueKey,
        summary: 'Create hello script',
        description: 'Create a script that prints hello',
        priority: 'High',
        issueType: 'Task',
        labels: ['ai-ready'],
        jiraUrl: `https://${process.env.JIRA_HOST}/browse/${issueKey}`,
      }),
    });
    expect(submitRes.status).toBe(201);

    // Wait for completion
    let task: any;
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 500));
      const res = await fetch(`http://127.0.0.1:${serverPort}/api/tasks/${issueKey}`);
      task = await res.json();
      if (task.status === 'completed' || task.status === 'failed') break;
    }

    await screenshot('step2-result', {
      status: task.status,
      claudeCostUsd: task.claudeCostUsd,
      errorMessage: task.errorMessage,
    }, `Status: ${task.status}\nCost: $${task.claudeCostUsd || 0}\n${task.errorMessage ? `Error: ${task.errorMessage}` : 'No error'}`);

    expect(task.status).toBe('completed');
    expect(task.claudeCostUsd).toBe(0.42);
  }, 30_000);

  it('task shows on dashboard via API', async () => {
    startTest('dashboard-api');

    reposRoot = mkdtempSync(join(tmpdir(), 'jiranimo-e2e-repos-'));
    testRepo = createTestRepo(reposRoot);
    const config = makeConfig(reposRoot);
    serverPort = await startServer(config);

    const issueKey = await createTestIssue({
      summary: 'Dashboard test',
      labels: ['ai-ready'],
    });

    await fetch(`http://127.0.0.1:${serverPort}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        key: issueKey,
        summary: 'Dashboard test',
        description: 'Test task for dashboard',
        priority: 'Medium',
        issueType: 'Task',
        labels: ['ai-ready'],
        jiraUrl: `https://${process.env.JIRA_HOST}/browse/${issueKey}`,
      }),
    });

    // Wait for completion
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 500));
      const res = await fetch(`http://127.0.0.1:${serverPort}/api/tasks/${issueKey}`);
      const task = await res.json();
      if (task.status === 'completed' || task.status === 'failed') break;
    }

    // Check task list API
    const listRes = await fetch(`http://127.0.0.1:${serverPort}/api/tasks`);
    const tasks = await listRes.json();

    await screenshot('tasks-list', tasks,
      tasks.map((t: any) => `${t.key}: ${t.status} — ${t.summary}`).join('\n'));

    expect(tasks.length).toBe(1);
    expect(tasks[0].key).toBe(issueKey);
    expect(tasks[0].status).toBe('completed');
  }, 30_000);
});
