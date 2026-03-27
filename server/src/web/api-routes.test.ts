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
vi.mock('../git/worktree.js', () => ({
  findGitRepo: vi.fn().mockResolvedValue('/tmp/test-repo'),
  createWorktree: vi.fn().mockResolvedValue('/tmp/test-repo/.jiranimo-worktrees/PROJ-1'),
  removeWorktree: vi.fn().mockResolvedValue(undefined),
  detectDefaultBranch: vi.fn().mockResolvedValue('main'),
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
  web: { port: 3456, host: '127.0.0.1' },
};

const validTask = {
  key: 'PROJ-1',
  summary: 'Test task',
  description: 'A test task',
  priority: 'High',
  issueType: 'Story',
  labels: ['ai-ready'],
  jiraUrl: 'https://test.atlassian.net/browse/PROJ-1',
};

let tmpDir: string;
let store: StateStore;
let pipeline: PipelineManager;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  vi.clearAllMocks();
  tmpDir = mkdtempSync(join(tmpdir(), 'jiranimo-api-test-'));
  store = new StateStore({ filePath: join(tmpDir, 'state.json'), flushDelayMs: 0 });
  pipeline = new PipelineManager(store, testConfig);
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
    // Manually put a task in queued state to avoid race with async processing
    store.upsertTask({
      key: 'PROJ-1', summary: 'Test', description: 'Test',
      priority: 'High', issueType: 'Story', labels: [], jiraUrl: 'https://test.atlassian.net/browse/PROJ-1',
      status: 'queued', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
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
      status: 'completed', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    store.flushSync();

    const res = await request(app).delete('/api/tasks/PROJ-1');
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);

    // Verify it's gone
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
    await request(app).post('/api/tasks').send(validTask);
    const res = await request(app).post('/api/tasks/PROJ-1/retry');
    expect(res.status).toBe(400);
  });
});

describe('GET /api/tasks/:key/logs', () => {
  it('returns 404 for unknown task', async () => {
    const res = await request(app).get('/api/tasks/NOPE-1/logs');
    expect(res.status).toBe(404);
  });

  it('returns 404 when task has no logs', async () => {
    // Manually create a task with no logPath to avoid async processing setting one
    store.upsertTask({
      key: 'PROJ-2', summary: 'No logs', description: 'Test',
      priority: 'High', issueType: 'Story', labels: [], jiraUrl: 'https://test.atlassian.net/browse/PROJ-2',
      status: 'queued', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    store.flushSync();

    const res = await request(app).get('/api/tasks/PROJ-2/logs');
    expect(res.status).toBe(404);
    expect(res.body.error).toContain('No logs');
  });
});
