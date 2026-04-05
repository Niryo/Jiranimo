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
  listRepos: vi.fn().mockReturnValue([
    { name: 'test-repo', hint: 'test-repo', path: '/tmp/test-repo' },
  ]),
}));
vi.mock('../mcp/server.js', () => ({
  createMcpHandler: vi.fn().mockReturnValue(vi.fn()),
  writeMcpConfig: vi.fn(),
  deleteMcpConfig: vi.fn(),
}));
vi.mock('../github/review-comments.js', () => ({
  fetchPendingGithubReviewComments: vi.fn().mockResolvedValue([]),
}));

const testConfig: ServerConfig = {
  claude: { maxBudgetUsd: 2.0 },
  pipeline: { concurrency: 1, repoConfirmationTimeoutMs: 0 },
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

describe('server root', () => {
  it('does not expose the removed dashboard UI', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(404);
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

describe('POST /api/tasks/:key/repo-confirmation', () => {
  it('lets the client override the detected repo before implementation starts', async () => {
    const { pickRepo, listRepos } = await import('../repo-picker.js');
    pipeline.shutdown();

    vi.mocked(listRepos).mockReturnValueOnce([
      { name: 'frontend-app', hint: 'frontend-app - React UI', path: '/tmp/frontend-app' },
      { name: 'api-service', hint: 'api-service - Express API', path: '/tmp/api-service' },
    ]);
    vi.mocked(pickRepo).mockResolvedValueOnce('/tmp/frontend-app');

    pipeline = new PipelineManager(store, {
      ...testConfig,
      pipeline: { concurrency: 1, repoConfirmationTimeoutMs: 10_000 },
    }, testRepoTarget);
    app = createApp(store, pipeline);

    const submitRes = await request(app)
      .post('/api/tasks')
      .send({ ...validTask, key: 'PROJ-REPO', summary: 'Confirm repo' });

    expect(submitRes.status).toBe(201);

    await vi.waitFor(() => {
      const effect = store.getPendingEffects('test.atlassian.net').find(candidate => candidate.type === 'repo-confirmation');
      expect(effect).toBeDefined();
    });

    const res = await request(app)
      .post('/api/tasks/PROJ-REPO/repo-confirmation')
      .send({ action: 'change', repoName: 'api-service' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('changed');
    expect(res.body.repoName).toBe('api-service');
    expect(res.body.repoPath).toBe('/tmp/api-service');
  });

  it('pauses repo confirmation countdown when the client starts choosing a different repo', async () => {
    const { pickRepo, listRepos } = await import('../repo-picker.js');
    pipeline.shutdown();

    vi.mocked(listRepos).mockReturnValueOnce([
      { name: 'frontend-app', hint: 'frontend-app - React UI', path: '/tmp/frontend-app' },
      { name: 'api-service', hint: 'api-service - Express API', path: '/tmp/api-service' },
    ]);
    vi.mocked(pickRepo).mockResolvedValueOnce('/tmp/frontend-app');

    pipeline = new PipelineManager(store, {
      ...testConfig,
      pipeline: { concurrency: 1, repoConfirmationTimeoutMs: 10_000 },
    }, testRepoTarget);
    app = createApp(store, pipeline);

    const submitRes = await request(app)
      .post('/api/tasks')
      .send({ ...validTask, key: 'PROJ-REPO-PAUSE', summary: 'Pause repo confirm' });

    expect(submitRes.status).toBe(201);

    await vi.waitFor(() => {
      const effect = store.getPendingEffects('test.atlassian.net').find(candidate => candidate.type === 'repo-confirmation');
      expect(effect).toBeDefined();
    });

    const res = await request(app)
      .post('/api/tasks/PROJ-REPO-PAUSE/repo-confirmation')
      .send({ action: 'pause' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('paused');

    const effect = store.getPendingEffects('test.atlassian.net').find(candidate => candidate.type === 'repo-confirmation');
    expect(effect?.payload.paused).toBe(true);
    expect(effect?.payload.expiresAt).toBeUndefined();
  });
});

describe('POST /api/tasks/:key/fix-comments', () => {
  it('returns 404 for unknown key', async () => {
    const res = await request(app).post('/api/tasks/NOPE-1/fix-comments');
    expect(res.status).toBe(404);
  });

  it('queues a completed PR task for GitHub comment fixing', async () => {
    const { fetchPendingGithubReviewComments } = await import('../github/review-comments.js');
    store.upsertTask({
      key: 'PROJ-REVIEW',
      summary: 'Needs review fixes',
      description: 'Needs review fixes',
      priority: 'High',
      issueType: 'Story',
      labels: [],
      comments: [],
      jiraUrl: 'https://test.atlassian.net/browse/PROJ-REVIEW',
      status: 'completed',
      prUrl: 'https://github.com/org/repo/pull/42',
      prNumber: 42,
      branchName: 'jiranimo/PROJ-REVIEW-feature',
      trackedBoards: ['test.atlassian.net:board-1'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    store.flushSync();

    vi.mocked(fetchPendingGithubReviewComments).mockResolvedValueOnce([{
      id: 101,
      fingerprint: 'conversation:101:2026-04-03T10:00:00Z',
      kind: 'conversation',
      author: 'reviewer',
      body: 'Please rename this helper',
    }]);

    const res = await request(app).post('/api/tasks/PROJ-REVIEW/fix-comments');

    expect(res.status).toBe(200);
    expect(res.body.pendingComments).toBe(1);
    expect(res.body.task.key).toBe('PROJ-REVIEW');
    expect(res.body.task.taskMode).toBe('fix-comments');
    expect(res.body.task.pendingGithubCommentFingerprints).toEqual(['conversation:101:2026-04-03T10:00:00Z']);
  });
});

describe('POST /api/tasks/:key/continue-work', () => {
  it('queues a continue-work run with the latest Jira comments on the existing branch', async () => {
    const { fetchPendingGithubReviewComments } = await import('../github/review-comments.js');
    store.upsertTask({
      key: 'PROJ-CONTINUE',
      summary: 'Needs follow-up work',
      description: 'Original description',
      priority: 'High',
      issueType: 'Story',
      labels: [],
      comments: [],
      jiraUrl: 'https://test.atlassian.net/browse/PROJ-CONTINUE',
      status: 'completed',
      taskMode: 'implement',
      repoPath: '/tmp/existing-repo',
      prUrl: 'https://github.com/org/repo/pull/42',
      prNumber: 42,
      branchName: 'jiranimo/PROJ-CONTINUE-feature',
      trackedBoards: ['test.atlassian.net:board-1'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    store.flushSync();

    vi.mocked(fetchPendingGithubReviewComments).mockResolvedValueOnce([{
      id: 101,
      fingerprint: 'conversation:101:2026-04-03T10:00:00Z',
      kind: 'conversation',
      author: 'reviewer',
      body: 'Please rename this helper',
    }]);

    const res = await request(app)
      .post('/api/tasks/PROJ-CONTINUE/continue-work')
      .send({
        description: 'Updated description',
        comments: [{ author: 'QA', body: 'Please verify the retry path', created: '2026-04-04T09:00:00Z' }],
      });

    expect(res.status).toBe(200);
    expect(res.body.pendingGithubComments).toBe(1);
    expect(res.body.task.key).toBe('PROJ-CONTINUE');
    expect(res.body.task.taskMode).toBe('continue-work');
    expect(res.body.task.previousTaskMode).toBe('implement');
    expect(res.body.task.comments).toEqual([{ author: 'QA', body: 'Please verify the retry path', created: '2026-04-04T09:00:00Z' }]);
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
