import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StateStore } from '../state/store.js';
import { PipelineManager } from '../pipeline/manager.js';
import { createApp } from './server.js';
import type { ServerConfig } from '../config/types.js';

vi.mock('../claude/executor.js', () => ({
  executeClaudeCode: vi.fn().mockResolvedValue({
    success: true, resultText: 'Done', sessionId: 's', costUsd: 0.5, durationMs: 1000,
  }),
}));
vi.mock('../repo-picker.js', () => ({
  pickRepo: vi.fn().mockResolvedValue('/tmp/test-repo'),
}));
vi.mock('../mcp/server.js', () => ({
  createMcpHandler: vi.fn().mockReturnValue(vi.fn()),
  writeMcpConfig: vi.fn(),
  deleteMcpConfig: vi.fn(),
}));

const testConfig: ServerConfig = {
  claude: { maxBudgetUsd: 2.0 },
  pipeline: { concurrency: 1 },
  git: { branchPrefix: 'jiranimo/', defaultBaseBranch: 'main', pushRemote: 'origin', createDraftPr: true },
  web: { port: 3456, host: '127.0.0.1' },
};
const testRepoTarget = { kind: 'repo-root' as const, reposRoot: '/tmp/repos' };

const validTask = {
  key: 'PROJ-1',
  summary: 'Test task',
  description: 'A test task',
  priority: 'High',
  issueType: 'Story',
  labels: ['ai-ready'],
  jiraUrl: 'https://test.atlassian.net/browse/PROJ-1',
  boardId: 'board-1',
  boardType: 'scrum',
  projectKey: 'PROJ',
};

let tmpDir: string;
let store: StateStore;
let pipeline: PipelineManager;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  vi.clearAllMocks();
  tmpDir = mkdtempSync(join(tmpdir(), 'jiranimo-api-test-'));
  store = new StateStore({ filePath: join(tmpDir, 'state.json'), flushDelayMs: 0 });
  pipeline = new PipelineManager(store, testConfig, testRepoTarget);
  app = createApp(store, pipeline);
});

afterEach(() => {
  store.destroy();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('CORS', () => {
  it('returns CORS headers on API responses', async () => {
    const res = await request(app).get('/api/tasks');
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });

  it('handles preflight OPTIONS request', async () => {
    const res = await request(app).options('/api/tasks');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['access-control-allow-methods']).toContain('POST');
  });
});

describe('POST /api/tasks', () => {
  it('creates a task and returns 201', async () => {
    const res = await request(app).post('/api/tasks').send(validTask);
    expect(res.status).toBe(201);
    expect(res.body.key).toBe('PROJ-1');
    expect(res.body.status).toBe('queued');
  });

  it('returns 400 for missing required fields', async () => {
    const res = await request(app).post('/api/tasks').send({ key: 'PROJ-1' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Missing required fields');
  });

  it('returns 409 for duplicate task that is still queued', async () => {
    store.upsertTask({
      key: 'PROJ-1', summary: 'Test', description: 'Test',
      priority: 'High', issueType: 'Story', labels: [], jiraUrl: 'https://test.atlassian.net/browse/PROJ-1',
      status: 'queued', trackedBoards: ['test.atlassian.net:board-1'], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    store.flushSync();

    const res = await request(app).post('/api/tasks').send(validTask);
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('already');
  });
});

describe('GET /api/tasks', () => {
  it('returns empty array when no tasks', async () => {
    const res = await request(app).get('/api/tasks');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('returns all tasks', async () => {
    await request(app).post('/api/tasks').send(validTask);
    const res = await request(app).get('/api/tasks');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].key).toBe('PROJ-1');
  });
});

describe('GET /api/sync', () => {
  it('returns server epoch, revision, tasks, and pending effects', async () => {
    store.beginServerEpoch();
    store.createEffect({
      id: 'effect-1',
      type: 'pipeline-status-sync',
      taskKey: 'PROJ-1',
      jiraHost: 'test.atlassian.net',
      payload: { issueKey: 'PROJ-1', pipelineStatus: 'in-progress' },
    });

    const res = await request(app).get('/api/sync?jiraHost=test.atlassian.net');
    expect(res.status).toBe(200);
    expect(res.body.serverEpoch).toBe(1);
    expect(Array.isArray(res.body.tasks)).toBe(true);
    expect(res.body.pendingEffects).toHaveLength(1);
  });
});

describe('GET /api/tasks/:key', () => {
  it('returns task by key', async () => {
    await request(app).post('/api/tasks').send(validTask);
    const res = await request(app).get('/api/tasks/PROJ-1');
    expect(res.status).toBe(200);
    expect(res.body.key).toBe('PROJ-1');
  });

  it('returns 404 for unknown key', async () => {
    const res = await request(app).get('/api/tasks/NOPE-1');
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/tasks/:key', () => {
  it('deletes an existing task', async () => {
    store.upsertTask({
      key: 'PROJ-1', summary: 'Delete me', description: 'Test',
      priority: 'High', issueType: 'Story', labels: [], jiraUrl: 'https://test.atlassian.net/browse/PROJ-1',
      status: 'completed', trackedBoards: ['test.atlassian.net:board-1'], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    store.flushSync();

    const res = await request(app).delete('/api/tasks/PROJ-1');
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);

    const getRes = await request(app).get('/api/tasks/PROJ-1');
    expect(getRes.status).toBe(404);
  });

  it('returns 404 for unknown key', async () => {
    const res = await request(app).delete('/api/tasks/NOPE-1');
    expect(res.status).toBe(404);
  });
});

describe('POST /api/tasks/:key/retry', () => {
  it('returns 404 for unknown key', async () => {
    const res = await request(app).post('/api/tasks/NOPE-1/retry');
    expect(res.status).toBe(404);
  });

  it('returns 400 for non-failed task', async () => {
    // Insert a queued task directly (bypass async processing) to test state validation
    store.upsertTask({
      key: 'PROJ-1', summary: 'Test', description: 'Test',
      priority: 'High', issueType: 'Story', labels: [], jiraUrl: 'https://test.atlassian.net/browse/PROJ-1',
      status: 'queued', trackedBoards: ['test.atlassian.net:board-1'], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    store.flushSync();

    const res = await request(app).post('/api/tasks/PROJ-1/retry');
    expect(res.status).toBe(400);
  });
});

describe('POST /api/tasks/:key/fix-comments', () => {
  it('returns 404 for unknown key', async () => {
    const res = await request(app).post('/api/tasks/NOPE-1/fix-comments');
    expect(res.status).toBe(404);
  });

  it('returns 400 for task without a PR', async () => {
    store.upsertTask({
      key: 'PROJ-1', summary: 'Test', description: 'Test',
      priority: 'High', issueType: 'Story', labels: [], jiraUrl: 'https://test.atlassian.net/browse/PROJ-1',
      status: 'completed', trackedBoards: ['test.atlassian.net:board-1'], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    store.flushSync();

    const res = await request(app).post('/api/tasks/PROJ-1/fix-comments');
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('no PR');
  });

  it('queues a completed task with a PR for fix-comments', async () => {
    store.upsertTask({
      key: 'PROJ-1', summary: 'Test', description: 'Test',
      priority: 'High', issueType: 'Story', labels: [], jiraUrl: 'https://test.atlassian.net/browse/PROJ-1',
      status: 'completed', prUrl: 'https://github.com/org/repo/pull/42', prNumber: 42, branchName: 'jiranimo/PROJ-1-test',
      trackedBoards: ['test.atlassian.net:board-1'], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    store.flushSync();

    const res = await request(app).post('/api/tasks/PROJ-1/fix-comments');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('queued');
    expect(res.body.taskMode).toBe('fix-comments');
  });
});

describe('POST /api/tasks/:key/cancel-resume', () => {
  it('cancels a pending resume', async () => {
    store.upsertTask({
      key: 'PROJ-INT', summary: 'Interrupted', description: 'Test',
      priority: 'High', issueType: 'Story', labels: [], jiraUrl: 'https://test.atlassian.net/browse/PROJ-INT',
      status: 'interrupted', trackedBoards: ['test.atlassian.net:board-1'], recoveryState: 'resume-pending', resumeAfter: new Date(Date.now() + 30_000).toISOString(),
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    store.flushSync();

    const res = await request(app).post('/api/tasks/PROJ-INT/cancel-resume');
    expect(res.status).toBe(200);
    expect(res.body.recoveryState).toBe('resume-cancelled');
  });
});

describe('Effects APIs', () => {
  it('claims and acknowledges an effect', async () => {
    store.beginServerEpoch();
    store.createEffect({
      id: 'effect-123',
      type: 'plan-comment',
      taskKey: 'PROJ-1',
      jiraHost: 'test.atlassian.net',
      payload: { issueKey: 'PROJ-1', body: 'hello', hash: 'hash' },
    });

    const claimRes = await request(app).post('/api/effects/effect-123/claim').send({ clientId: 'client-1' });
    expect(claimRes.status).toBe(200);
    expect(claimRes.body.claimedBy).toBe('client-1');

    const ackRes = await request(app).post('/api/effects/effect-123/ack');
    expect(ackRes.status).toBe(200);
    expect(ackRes.body.acked).toBe(true);
  });

  it('treats acking a missing effect as an idempotent no-op', async () => {
    const ackRes = await request(app).post('/api/effects/missing-effect/ack');
    expect(ackRes.status).toBe(200);
    expect(ackRes.body.acked).toBe(false);
  });
});

describe('PUT /api/boards/:boardId/presence', () => {
  it('stores board presence and updates tracked boards for matching tasks', async () => {
    await request(app).post('/api/tasks').send(validTask);

    const res = await request(app)
      .put('/api/boards/board-2/presence')
      .send({
        jiraHost: 'test.atlassian.net',
        boardType: 'kanban',
        projectKey: 'PROJ',
        issueKeys: ['PROJ-1'],
      });

    expect(res.status).toBe(200);
    expect(res.body.deletedTaskKeys).toEqual([]);
    expect(store.getTask('PROJ-1')?.trackedBoards).toEqual([
      'test.atlassian.net:board-1',
      'test.atlassian.net:board-2',
    ]);
  });

  it('deletes a task when its last tracked board reports it absent', async () => {
    await request(app).post('/api/tasks').send(validTask);

    const res = await request(app)
      .put('/api/boards/board-1/presence')
      .send({
        jiraHost: 'test.atlassian.net',
        boardType: 'scrum',
        projectKey: 'PROJ',
        issueKeys: [],
      });

    expect(res.status).toBe(200);
    expect(res.body.deletedTaskKeys).toEqual(['PROJ-1']);
    expect(store.getTask('PROJ-1')).toBeUndefined();
  });
});

describe('GET /api/tasks/:key/logs', () => {
  it('returns 404 for unknown task', async () => {
    const res = await request(app).get('/api/tasks/NOPE-1/logs');
    expect(res.status).toBe(404);
  });

  it('returns 404 when task has no logs', async () => {
    store.upsertTask({
      key: 'PROJ-2', summary: 'No logs', description: 'Test',
      priority: 'High', issueType: 'Story', labels: [], jiraUrl: 'https://test.atlassian.net/browse/PROJ-2',
      status: 'queued', trackedBoards: ['test.atlassian.net:board-1'], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    store.flushSync();

    const res = await request(app).get('/api/tasks/PROJ-2/logs');
    expect(res.status).toBe(404);
    expect(res.body.error).toContain('No logs');
  });
});
