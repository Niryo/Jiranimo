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
    success: true, resultText: 'Done', sessionId: 's', costUsd: 0.5, durationMs: 1000,
  }),
}));
vi.mock('../git/worktree.js', () => ({
  findGitRepo: vi.fn().mockResolvedValue('/tmp/test-repo'),
  createWorktree: vi.fn().mockResolvedValue('/tmp/test-repo/.jiranimo-worktrees/PROJ-1'),
  removeWorktree: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../git/branch.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../git/branch.js')>();
  return { ...original, commitAndPush: vi.fn().mockResolvedValue(undefined) };
});

const testConfig: ServerConfig = {
  repoPath: '/tmp/test-repo',
  claude: { maxBudgetUsd: 2.0 },
  pipeline: { concurrency: 1 },
  git: { branchPrefix: 'jiranimo/', defaultBaseBranch: 'main', pushRemote: 'origin', createDraftPr: true },
  web: { port: 0, host: '127.0.0.1' },
};

let tmpDir: string;
let store: StateStore;
let pipeline: PipelineManager;
let server: ReturnType<typeof createServer>;
let wsHandler: ReturnType<typeof attachWebSocket>;
let port: number;

beforeEach(async () => {
  vi.clearAllMocks();
  tmpDir = mkdtempSync(join(tmpdir(), 'jiranimo-ws-test-'));
  store = new StateStore({ filePath: join(tmpDir, 'state.json'), flushDelayMs: 0 });
  pipeline = new PipelineManager(store, testConfig);
  const app = createApp(store, pipeline);
  server = createServer(app);
  wsHandler = attachWebSocket(server, pipeline);

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve();
    });
  });
});

afterEach(async () => {
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

function collectMessages(ws: WebSocket, count: number, timeoutMs = 3000): Promise<Record<string, unknown>[]> {
  return new Promise((resolve) => {
    const msgs: Record<string, unknown>[] = [];
    const timer = setTimeout(() => resolve(msgs), timeoutMs);
    ws.on('message', (data) => {
      msgs.push(JSON.parse(data.toString()));
      if (msgs.length >= count) {
        clearTimeout(timer);
        resolve(msgs);
      }
    });
  });
}

describe('WebSocket handler', () => {
  it('receives task-created event on task submission', async () => {
    const ws = await connectWs();
    const msgPromise = collectMessages(ws, 1);

    pipeline.submitTask({
      key: 'PROJ-1', summary: 'Test', description: 'Test',
      priority: 'High', issueType: 'Story', labels: [], comments: [],
      jiraUrl: 'https://test.atlassian.net/browse/PROJ-1',
    });

    const msgs = await msgPromise;
    expect(msgs[0].type).toBe('task-created');
    ws.close();
  });

  it('receives task-status-changed events during processing', async () => {
    const ws = await connectWs();
    const msgs: Record<string, unknown>[] = [];
    ws.on('message', (data) => msgs.push(JSON.parse(data.toString())));

    pipeline.submitTask({
      key: 'PROJ-2', summary: 'Test2', description: 'Test',
      priority: 'High', issueType: 'Story', labels: [], comments: [],
      jiraUrl: 'https://test.atlassian.net/browse/PROJ-2',
    });

    await new Promise(r => setTimeout(r, 300));
    const types = msgs.map(m => m.type);
    expect(types).toContain('task-created');
    expect(types).toContain('task-status-changed');
    ws.close();
  });

  it('queues messages when no clients are connected', async () => {
    // No client connected — submit a task
    pipeline.submitTask({
      key: 'PROJ-3', summary: 'Offline', description: 'Test',
      priority: 'High', issueType: 'Story', labels: [], comments: [],
      jiraUrl: 'https://test.atlassian.net/browse/PROJ-3',
    });

    // Wait for processing
    await new Promise(r => setTimeout(r, 300));

    // Queue should have messages
    expect(wsHandler.queueLength).toBeGreaterThan(0);
  });

  it('delivers queued messages when client reconnects', async () => {
    // Submit task with no client connected
    pipeline.submitTask({
      key: 'PROJ-4', summary: 'Queued', description: 'Test',
      priority: 'High', issueType: 'Story', labels: [], comments: [],
      jiraUrl: 'https://test.atlassian.net/browse/PROJ-4',
    });

    await new Promise(r => setTimeout(r, 300));
    const queuedBefore = wsHandler.queueLength;
    expect(queuedBefore).toBeGreaterThan(0);

    // Connect with message listener set BEFORE open completes
    const msgs: Record<string, unknown>[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws.on('message', (data) => msgs.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve) => ws.on('open', () => resolve()));

    // Give time for queued messages to arrive
    await new Promise(r => setTimeout(r, 200));

    expect(msgs.length).toBe(queuedBefore);
    expect(msgs.some(m => m.type === 'task-created')).toBe(true);
    expect(wsHandler.queueLength).toBe(0);

    ws.close();
  });

  it('delivers queued messages after disconnect and reconnect', async () => {
    // Connect then disconnect
    const ws1 = await connectWs();
    ws1.close();
    await new Promise(r => setTimeout(r, 200));

    // Submit task while disconnected
    pipeline.submitTask({
      key: 'PROJ-5', summary: 'Reconnect', description: 'Test',
      priority: 'High', issueType: 'Story', labels: [], comments: [],
      jiraUrl: 'https://test.atlassian.net/browse/PROJ-5',
    });

    await new Promise(r => setTimeout(r, 300));
    expect(wsHandler.queueLength).toBeGreaterThan(0);

    // Reconnect with listener attached before open
    const msgs: Record<string, unknown>[] = [];
    const ws2 = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws2.on('message', (data) => msgs.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve) => ws2.on('open', () => resolve()));
    await new Promise(r => setTimeout(r, 200));

    expect(msgs.some(m => m.type === 'task-created')).toBe(true);
    expect(msgs.some(m => (m as any).task?.key === 'PROJ-5')).toBe(true);
    expect(wsHandler.queueLength).toBe(0);

    ws2.close();
  });

  it('sends update-jira-status messages on task transitions', async () => {
    const ws = await connectWs();
    const msgs: Record<string, unknown>[] = [];
    ws.on('message', (data) => msgs.push(JSON.parse(data.toString())));

    pipeline.submitTask({
      key: 'PROJ-6', summary: 'Status update', description: 'Test',
      priority: 'High', issueType: 'Story', labels: [], comments: [],
      jiraUrl: 'https://test.atlassian.net/browse/PROJ-6',
    });

    await new Promise(r => setTimeout(r, 500));

    const jiraUpdates = msgs.filter(m => m.type === 'update-jira-status');
    expect(jiraUpdates.length).toBeGreaterThan(0);

    // Should have an "in-progress" update
    expect(jiraUpdates.some(m => m.pipelineStatus === 'in-progress')).toBe(true);

    // Should have a "completed" update
    expect(jiraUpdates.some(m => m.pipelineStatus === 'completed')).toBe(true);

    ws.close();
  });

  it('does not queue task-output messages (too noisy)', async () => {
    // Emit a task-output event with no clients
    pipeline.emit('task-output', 'PROJ-7', '{"type":"test"}');

    expect(wsHandler.queueLength).toBe(0);
  });
});
