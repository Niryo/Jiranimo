import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WebSocket } from 'ws';
import { StateStore } from '../state/store.js';
import { PipelineManager } from '../pipeline/manager.js';
import { createApp } from './server.js';
import { attachWebSocket } from './ws-handler.js';
import type { ServerConfig } from '../config/types.js';

vi.mock('../claude/executor.js', () => ({
  executeClaudeCode: vi.fn().mockResolvedValue({
    success: true,
    resultText: 'Done',
    sessionId: 's',
    costUsd: 0.5,
    durationMs: 1000,
  }),
}));
vi.mock('../repo-picker.js', () => ({
  pickRepo: vi.fn().mockResolvedValue('/tmp/test-repo'),
  listRepos: vi.fn().mockReturnValue([
    { name: 'test-repo', hint: 'test-repo', path: '/tmp/test-repo' },
  ]),
}));
vi.mock('../mcp/server.js', () => ({
  createMcpHandler: vi.fn().mockReturnValue(vi.fn()),
  writeMcpConfig: vi.fn(),
  deleteMcpConfig: vi.fn(),
}));

const testConfig: ServerConfig = {
  claude: { maxBudgetUsd: 2.0 },
  pipeline: { concurrency: 1, repoConfirmationTimeoutMs: 0 },
  git: { branchPrefix: 'jiranimo/', defaultBaseBranch: 'main', pushRemote: 'origin', createDraftPr: true },
  web: { port: 0, host: '127.0.0.1' },
};
const testRepoTarget = { kind: 'repo-root' as const, reposRoot: '/tmp/repos' };

let tmpDir: string;
let store: StateStore;
let pipeline: PipelineManager;
let server: ReturnType<typeof createServer>;
let port: number;

beforeEach(async () => {
  vi.clearAllMocks();
  tmpDir = mkdtempSync(join(tmpdir(), 'jiranimo-ws-test-'));
  store = new StateStore({ filePath: join(tmpDir, 'state.json'), flushDelayMs: 0 });
  store.beginServerEpoch();
  pipeline = new PipelineManager(store, testConfig, testRepoTarget);
  const app = createApp(store, pipeline);
  server = createServer(app);
  attachWebSocket(server, pipeline);

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve();
    });
  });
});

afterEach(async () => {
  pipeline.shutdown();
  store.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(tmpDir, { recursive: true, force: true });
});

function connectWs(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function waitForMessages(ws: WebSocket, minCount: number, timeoutMs = 3000): Promise<Record<string, unknown>[]> {
  return new Promise((resolve) => {
    const msgs: Record<string, unknown>[] = [];
    const timer = setTimeout(() => resolve(msgs), timeoutMs);
    ws.on('message', (data) => {
      msgs.push(JSON.parse(data.toString()));
      if (msgs.length >= minCount) {
        clearTimeout(timer);
        resolve(msgs);
      }
    });
  });
}

describe('WebSocket handler', () => {
  it('broadcasts sync-needed when task state changes', async () => {
    const ws = await connectWs();
    const msgPromise = waitForMessages(ws, 1);

    pipeline.submitTask({
      key: 'PROJ-1',
      summary: 'Test',
      description: 'Test',
      priority: 'High',
      issueType: 'Story',
      labels: [],
      comments: [],
      jiraUrl: 'https://test.atlassian.net/browse/PROJ-1',
      boardId: 'board-1',
      boardType: 'scrum',
      projectKey: 'PROJ',
    });

    const msgs = await msgPromise;
    expect(msgs[0].type).toBe('sync-needed');
    expect(Number(msgs[0].serverEpoch)).toBe(1);
    expect(Number(msgs[0].revision)).toBeGreaterThan(0);
    ws.close();
  });

  it('emits monotonically increasing revisions during task processing', async () => {
    const ws = await connectWs();
    const msgsPromise = waitForMessages(ws, 3, 5000);

    pipeline.submitTask({
      key: 'PROJ-2',
      summary: 'Test2',
      description: 'Test',
      priority: 'High',
      issueType: 'Story',
      labels: [],
      comments: [],
      jiraUrl: 'https://test.atlassian.net/browse/PROJ-2',
      boardId: 'board-1',
      boardType: 'scrum',
      projectKey: 'PROJ',
    });

    const msgs = await msgsPromise;
    const revisions = msgs.map(m => Number(m.revision)).filter(n => !Number.isNaN(n));
    expect(revisions.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < revisions.length; i++) {
      expect(revisions[i]).toBeGreaterThanOrEqual(revisions[i - 1]);
    }
    ws.close();
  });
});
