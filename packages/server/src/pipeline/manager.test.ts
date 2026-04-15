import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PipelineManager } from './manager.js';
import { StateStore } from '../state/store.js';
import type { ServerConfig } from '../config/types.js';
import type { TaskInput } from '../claude/types.js';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { planFilePath } from '../claude/prompt-builder.js';

// Mock Claude executor so unit tests are fast
vi.mock('../claude/executor.js', () => ({
  executeClaudeCode: vi.fn().mockResolvedValue({
    success: true,
    resultText: 'Done',
    sessionId: 'sess-1',
    costUsd: 0.5,
    durationMs: 1000,
  }),
}));

// Mock repo picker
vi.mock('../repo-picker.js', () => ({
  pickRepo: vi.fn().mockResolvedValue('/tmp/test-repo'),
  listRepos: vi.fn().mockReturnValue([
    { name: 'test-repo', hint: 'test-repo', path: '/tmp/test-repo' },
  ]),
}));

// Mock MCP config helpers
vi.mock('../mcp/server.js', () => ({
  createMcpHandler: vi.fn(),
  writeMcpConfig: vi.fn(),
  deleteMcpConfig: vi.fn(),
}));

// Mock task classifier so it doesn't consume executor mock calls
vi.mock('../claude/task-classifier.js', () => ({
  resolveTaskMode: vi.fn().mockResolvedValue('implement'),
}));

vi.mock('../github/review-comments.js', () => ({
  fetchPendingGithubReviewComments: vi.fn().mockResolvedValue([]),
}));

// Mock compact log generator so it doesn't consume extra executeClaudeCode calls
vi.mock('../claude/compact-log-generator.js', () => ({
  generateCompactLog: vi.fn().mockResolvedValue('Compact summary'),
}));

const testConfig: ServerConfig = {
  claude: { maxBudgetUsd: 2.0 },
  pipeline: { concurrency: 1, repoConfirmationTimeoutMs: 0 },
  git: { branchPrefix: 'jiranimo/', defaultBaseBranch: 'main', pushRemote: 'origin', createDraftPr: true },
  web: { port: 3456, host: '127.0.0.1' },
};
const repoRootTarget = { kind: 'repo-root' as const, reposRoot: '/tmp/repos' };
const singleRepoTarget = { kind: 'single-repo' as const, repoPath: '/tmp/single-repo' };

const sampleInput: TaskInput = {
  key: 'PROJ-1',
  summary: 'Test task',
  description: 'A test task',
  priority: 'High',
  issueType: 'Story',
  labels: ['ai-ready'],
  comments: [],
  jiraUrl: 'https://test.atlassian.net/browse/PROJ-1',
};

let tmpDir: string;
let store: StateStore;

beforeEach(() => {
  vi.clearAllMocks();
  tmpDir = mkdtempSync(join(tmpdir(), 'jiranimo-mgr-test-'));
  store = new StateStore({ filePath: join(tmpDir, 'state.json'), flushDelayMs: 0 });
});

describe('PipelineManager', () => {
  it('submits a task and sets status to queued', () => {
    const mgr = new PipelineManager(store, testConfig, repoRootTarget);
    const task = mgr.submitTask(sampleInput);
    expect(task.status).toBe('queued');
    expect(task.key).toBe('PROJ-1');
    store.destroy();
  });

  it('emits task-created event on submit', () => {
    const mgr = new PipelineManager(store, testConfig, repoRootTarget);
    const handler = vi.fn();
    mgr.on('task-created', handler);
    mgr.submitTask(sampleInput);
    expect(handler).toHaveBeenCalledOnce();
    store.destroy();
  });

  it('rejects duplicate task submission while queued or in-progress', () => {
    const mgr = new PipelineManager(store, testConfig, repoRootTarget);
    mgr.submitTask(sampleInput);
    expect(() => mgr.submitTask(sampleInput)).toThrow('already');
    store.destroy();
  });

  it('allows resubmission of completed tasks', async () => {
    const mgr = new PipelineManager(store, testConfig, repoRootTarget);
    mgr.submitTask(sampleInput);

    await new Promise(r => setTimeout(r, 100));

    const task = store.getTask('PROJ-1');
    expect(task?.status).toBe('completed');

    const resubmitted = mgr.submitTask(sampleInput);
    expect(resubmitted.status).toBe('queued');
    store.destroy();
  });

  it('processes task through full lifecycle', async () => {
    const mgr = new PipelineManager(store, testConfig, repoRootTarget);
    const statusChanges: string[] = [];
    mgr.on('task-status-changed', (task) => statusChanges.push(task.status));

    mgr.submitTask(sampleInput);

    await new Promise(r => setTimeout(r, 200));

    const task = store.getTask('PROJ-1');
    expect(task?.status).toBe('completed');
    expect(task?.claudeCostUsd).toBe(0.5);
    expect(statusChanges).toContain('in-progress');
    expect(statusChanges).toContain('completed');
    store.destroy();
  });

  it('retries a failed task', async () => {
    const { executeClaudeCode } = await import('../claude/executor.js');

    vi.mocked(executeClaudeCode)
      .mockResolvedValueOnce({ success: false, resultText: 'Error', durationMs: 100 })
      .mockResolvedValueOnce({ success: true, resultText: 'Done', sessionId: 's', costUsd: 0.1, durationMs: 100 });

    const mgr = new PipelineManager(store, testConfig, repoRootTarget);
    mgr.submitTask(sampleInput);

    await new Promise(r => setTimeout(r, 200));
    expect(store.getTask('PROJ-1')?.status).toBe('failed');

    mgr.retryTask('PROJ-1');
    await new Promise(r => setTimeout(r, 200));
    expect(store.getTask('PROJ-1')?.status).toBe('completed');
    store.destroy();
  });

  it('throws when retrying non-failed task', () => {
    const mgr = new PipelineManager(store, testConfig, repoRootTarget);
    mgr.submitTask(sampleInput);
    expect(() => mgr.retryTask('PROJ-1')).toThrow('Invalid transition');
    store.destroy();
  });

  it('recovers in-progress tasks as interrupted resume candidates on startup', () => {
    store.beginServerEpoch();
    store.upsertTask({
      key: 'PROJ-RECOVER',
      summary: 'Resume me',
      description: 'Resume me',
      priority: 'High',
      issueType: 'Story',
      labels: [],
      comments: [],
      jiraUrl: 'https://test.atlassian.net/browse/PROJ-RECOVER',
      status: 'in-progress',
      claudeSessionId: 'sess-123',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    store.flushSync();

    const mgr = new PipelineManager(store, testConfig, repoRootTarget);
    const task = store.getTask('PROJ-RECOVER');

    expect(task?.status).toBe('interrupted');
    expect(task?.recoveryState).toBe('resume-pending');
    expect(task?.resumeMode).toBe('claude-session');
    mgr.shutdown();
    store.destroy();
  });

  it('cancelResume prevents automatic resume from remaining scheduled', () => {
    store.beginServerEpoch();
    store.upsertTask({
      key: 'PROJ-CANCEL',
      summary: 'Cancel resume',
      description: 'Cancel resume',
      priority: 'High',
      issueType: 'Story',
      labels: [],
      comments: [],
      jiraUrl: 'https://test.atlassian.net/browse/PROJ-CANCEL',
      status: 'interrupted',
      recoveryState: 'resume-pending',
      resumeAfter: new Date(Date.now() + 30_000).toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    store.flushSync();

    const mgr = new PipelineManager(store, testConfig, repoRootTarget);
    const updated = mgr.cancelResume('PROJ-CANCEL');

    expect(updated.recoveryState).toBe('resume-cancelled');
    expect(updated.resumeAfter).toBeUndefined();
    mgr.shutdown();
    store.destroy();
  });

  it('uses Claude session resume when manually resuming an interrupted task with a session id', async () => {
    const { executeClaudeCode } = await import('../claude/executor.js');
    store.beginServerEpoch();
    store.upsertTask({
      key: 'PROJ-SESSION',
      summary: 'Resume with session',
      description: 'Resume with session',
      priority: 'High',
      issueType: 'Story',
      labels: [],
      comments: [],
      jiraUrl: 'https://test.atlassian.net/browse/PROJ-SESSION',
      status: 'interrupted',
      recoveryState: 'resume-cancelled',
      claudeSessionId: 'sess-abc',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    store.flushSync();

    const mgr = new PipelineManager(store, testConfig, repoRootTarget);
    mgr.resumeTask('PROJ-SESSION');
    await new Promise(r => setTimeout(r, 200));

    expect(vi.mocked(executeClaudeCode).mock.calls.at(-1)?.[0].resumeSessionId).toBe('sess-abc');
    mgr.shutdown();
    store.destroy();
  });

  it('falls back to fresh recovery when manually resuming without a session id', async () => {
    const { executeClaudeCode } = await import('../claude/executor.js');
    store.beginServerEpoch();
    store.upsertTask({
      key: 'PROJ-FRESH',
      summary: 'Resume fresh',
      description: 'Resume fresh',
      priority: 'High',
      issueType: 'Story',
      labels: [],
      comments: [],
      jiraUrl: 'https://test.atlassian.net/browse/PROJ-FRESH',
      status: 'interrupted',
      recoveryState: 'resume-cancelled',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    store.flushSync();

    const mgr = new PipelineManager(store, testConfig, repoRootTarget);
    mgr.resumeTask('PROJ-FRESH');
    await new Promise(r => setTimeout(r, 200));

    expect(vi.mocked(executeClaudeCode).mock.calls.at(-1)?.[0].resumeSessionId).toBeUndefined();
    mgr.shutdown();
    store.destroy();
  });

  it('logs session started only once even when multiple init events arrive', async () => {
    const { executeClaudeCode } = await import('../claude/executor.js');

    vi.mocked(executeClaudeCode).mockImplementationOnce(async (opts) => {
      const onEvent = opts.onEvent!;
      onEvent({ type: 'init', raw: { type: 'system', session_id: 'sess-abc' }, sessionId: 'sess-abc' });
      onEvent({ type: 'init', raw: { type: 'system', session_id: 'sess-abc' }, sessionId: 'sess-abc' });
      onEvent({ type: 'init', raw: { type: 'system', session_id: 'sess-abc' }, sessionId: 'sess-abc' });
      return { success: true, resultText: 'Done', sessionId: 'sess-abc', costUsd: 0.1, durationMs: 100 };
    });

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const mgr = new PipelineManager(store, testConfig, repoRootTarget);
    mgr.submitTask(sampleInput);

    await new Promise(r => setTimeout(r, 200));

    const sessionLogs = consoleSpy.mock.calls
      .map(args => args[0] as string)
      .filter(msg => typeof msg === 'string' && msg.includes('Claude session ready') && msg.includes('sess-abc'));

    expect(sessionLogs).toHaveLength(1);
    consoleSpy.mockRestore();
    store.destroy();
  });

  it('writes concise lifecycle and Claude progress logs', async () => {
    const { executeClaudeCode } = await import('../claude/executor.js');
    const logsDir = join(tmpDir, 'logs');

    vi.mocked(executeClaudeCode).mockImplementationOnce(async (opts) => {
      opts.onEvent?.({ type: 'init', raw: { type: 'system', session_id: 'sess-log' }, sessionId: 'sess-log' });
      opts.onEvent?.({
        type: 'message',
        raw: {
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: 'Inspecting the repository and preparing a change.' },
              { type: 'tool_use', name: 'Read', input: { file_path: '/tmp/test-repo/src/index.ts' } },
              { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } },
            ],
          },
        },
        text: 'Inspecting the repository and preparing a change.',
        toolUse: [
          { name: 'Read', input: { file_path: '/tmp/test-repo/src/index.ts' } },
          { name: 'Bash', input: { command: 'npm test' } },
        ],
      });
      opts.onEvent?.({
        type: 'result',
        raw: { type: 'result', subtype: 'success', result: 'Done', total_cost_usd: 0.1 },
        text: 'Done',
        costUsd: 0.1,
        isError: false,
      });

      return { success: true, resultText: 'Done', sessionId: 'sess-log', costUsd: 0.1, durationMs: 100 };
    });

    const mgr = new PipelineManager(store, { ...testConfig, logsDir }, repoRootTarget);
    mgr.submitTask(sampleInput);

    await new Promise(r => setTimeout(r, 200));

    const serverLog = readFileSync(join(logsDir, 'server.log'), 'utf-8');
    expect(serverLog).toContain('Received task to implement: Test task (PROJ-1)');
    expect(serverLog).toContain('Starting task: Test task');
    expect(serverLog).toContain('Preparing workspace');
    expect(serverLog).toContain('Choosing repository to operate on');
    expect(serverLog).toContain('Repository selected: /tmp/test-repo (source: repo picker (auto-confirmed after timeout))');
    expect(serverLog).toContain('Task mode selected: implement (source: task classifier)');
    expect(serverLog).toContain('Building Claude prompt');
    expect(serverLog).toContain('Launching Claude Code');
    expect(serverLog).toContain('Claude session ready: sess-log');
    expect(serverLog).toContain('Claude progress: Inspecting the repository and preparing a change.');
    expect(serverLog).toContain('Claude action: reading /tmp/test-repo/src/index.ts');
    expect(serverLog).toContain('Claude action: running npm test');
    expect(serverLog).toContain('Claude finished successfully ($0.10)');
    expect(serverLog).not.toContain('HTTP request');

    mgr.shutdown();
    store.destroy();
  });

  it('logs resolved decisions even when they come from config or existing task state', async () => {
    const { executeClaudeCode } = await import('../claude/executor.js');
    const logsDir = join(tmpDir, 'known-decision-logs');

    vi.mocked(executeClaudeCode).mockResolvedValueOnce({
      success: true,
      resultText: 'Done',
      sessionId: 'sess-known',
      costUsd: 0.1,
      durationMs: 100,
    });

    store.beginServerEpoch();
    store.upsertTask({
      key: 'PROJ-KNOWN',
      summary: 'Known repo and mode',
      description: 'Known repo and mode',
      priority: 'High',
      issueType: 'Story',
      labels: [],
      comments: [],
      jiraUrl: 'https://test.atlassian.net/browse/PROJ-KNOWN',
      status: 'queued',
      repoPath: '/tmp/already-chosen-repo',
      taskMode: 'implement',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    store.enqueueTask('PROJ-KNOWN');
    store.flushSync();

    const mgr = new PipelineManager(store, { ...testConfig, logsDir }, singleRepoTarget);

    await new Promise(r => setTimeout(r, 200));

    const serverLog = readFileSync(join(logsDir, 'server.log'), 'utf-8');
    expect(serverLog).toContain('Repository selected: /tmp/already-chosen-repo (source: task state)');
    expect(serverLog).toContain('Task mode selected: implement (source: task state)');

    mgr.shutdown();
    store.destroy();
  });

  it('reportProgress emits task-output event', () => {
    const mgr = new PipelineManager(store, testConfig, repoRootTarget);
    const handler = vi.fn();
    mgr.on('task-output', handler);
    mgr.reportProgress('PROJ-1', 'Running tests...');
    expect(handler).toHaveBeenCalledWith('PROJ-1', expect.stringContaining('Running tests'));
    store.destroy();
  });

  it('reportPr stores PR info in task state', () => {
    const mgr = new PipelineManager(store, testConfig, repoRootTarget);
    mgr.submitTask(sampleInput);
    mgr.reportPr('PROJ-1', 'https://github.com/org/repo/pull/42', 42, 'jiranimo/PROJ-1-feature');
    const task = store.getTask('PROJ-1');
    expect(task?.prUrl).toBe('https://github.com/org/repo/pull/42');
    expect(task?.prNumber).toBe(42);
    expect(task?.branchName).toBe('jiranimo/PROJ-1-feature');
    store.destroy();
  });

  it('completeViaAgent transitions in-progress task to completed with summary', () => {
    const mgr = new PipelineManager(store, testConfig, repoRootTarget);
    // Directly set a task as in-progress to test the method in isolation
    store.upsertTask({
      key: 'PROJ-1', summary: 'Test', description: 'Test',
      priority: 'High', issueType: 'Story', labels: [],
      jiraUrl: 'https://test.atlassian.net/browse/PROJ-1',
      status: 'in-progress', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });

    mgr.completeViaAgent('PROJ-1', 'Implemented and PR created');

    const task = store.getTask('PROJ-1');
    expect(task?.status).toBe('completed');
    expect(task?.claudeResultText).toBe('Implemented and PR created');
    store.destroy();
  });

  it('posts a plan comment after plan content is loaded for plan tasks', async () => {
    const { executeClaudeCode } = await import('../claude/executor.js');
    const { resolveTaskMode } = await import('../claude/task-classifier.js');
    const planTaskKey = 'PROJ-PLAN';
    const planPath = planFilePath(planTaskKey);

    vi.mocked(resolveTaskMode).mockResolvedValue('plan');

    let mgr!: PipelineManager;
    vi.mocked(executeClaudeCode).mockImplementationOnce(async () => {
      writeFileSync(planPath, '# Technical Plan\n\n1. Investigate\n2. Implement\n', 'utf-8');
      mgr.completeViaAgent(planTaskKey, 'Plan written');
      return { success: true, resultText: 'Plan written', sessionId: 'sess-plan', costUsd: 0.1, durationMs: 100 };
    });

    mgr = new PipelineManager(store, testConfig, repoRootTarget);
    mgr.submitTask({ ...sampleInput, key: planTaskKey });

    await new Promise(r => setTimeout(r, 200));

    const task = store.getTask(planTaskKey);
    const effects = store.getPendingEffects('test.atlassian.net');
    const planEffect = effects.find((effect) => effect.type === 'plan-comment' && effect.taskKey === planTaskKey);
    const completionEffect = effects.find((effect) => effect.type === 'completion-comment' && effect.taskKey === planTaskKey);

    expect(task?.status).toBe('completed');
    expect(task?.planContent).toContain('# Technical Plan');
    expect(planEffect?.payload.body).toContain('# Technical Plan');
    expect(completionEffect).toBeUndefined();

    try {
      rmSync(planPath, { force: true });
    } catch {
      // ignore
    }
    mgr.shutdown();
    store.destroy();
  });

  it('re-submitted planned tasks keep the saved plan and re-decide mode from comments', async () => {
    const { resolveTaskMode } = await import('../claude/task-classifier.js');
    store.beginServerEpoch();
    store.upsertTask({
      key: 'PROJ-REPLAN',
      summary: 'Existing planned task',
      description: 'Existing planned task',
      priority: 'High',
      issueType: 'Story',
      labels: [],
      comments: [{ author: 'PM', body: 'Initial planning request' }],
      jiraUrl: 'https://test.atlassian.net/browse/PROJ-REPLAN',
      status: 'completed',
      taskMode: 'plan',
      planContent: '# Technical Plan\n\n1. Build it\n',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    store.flushSync();

    vi.mocked(resolveTaskMode).mockResolvedValue('implement');

    const mgr = new PipelineManager(store, testConfig, repoRootTarget);
    mgr.submitTask({
      ...sampleInput,
      key: 'PROJ-REPLAN',
      summary: 'Existing planned task',
      description: 'Existing planned task',
      comments: [{ author: 'PM', body: "Perfect, let's do it", created: '2026-04-02T09:00:00.000Z' }],
    });

    await new Promise(r => setTimeout(r, 200));

    expect(vi.mocked(resolveTaskMode)).toHaveBeenCalledWith(expect.objectContaining({
      key: 'PROJ-REPLAN',
      previousTaskMode: 'plan',
      planContent: '# Technical Plan\n\n1. Build it\n',
      comments: [{ author: 'PM', body: "Perfect, let's do it", created: '2026-04-02T09:00:00.000Z' }],
    }), testConfig.claude);
    expect(store.getTask('PROJ-REPLAN')?.taskMode).toBe('implement');

    mgr.shutdown();
    store.destroy();
  });

  it('queues a fix-comments run for completed PR tasks and marks fetched comments as fixed on success', async () => {
    const { fetchPendingGithubReviewComments } = await import('../github/review-comments.js');
    store.beginServerEpoch();
    store.upsertTask({
      key: 'PROJ-REVIEW',
      summary: 'Existing PR task',
      description: 'Existing PR task',
      priority: 'High',
      issueType: 'Story',
      labels: [],
      comments: [],
      jiraUrl: 'https://test.atlassian.net/browse/PROJ-REVIEW',
      status: 'completed',
      repoPath: '/tmp/existing-repo',
      prUrl: 'https://github.com/org/repo/pull/42',
      prNumber: 42,
      branchName: 'jiranimo/PROJ-REVIEW-feature',
      claudeCostUsd: 0.5,
      fixedGithubCommentFingerprints: ['review:100:2026-04-02T10:00:00Z'],
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
      path: 'src/app.ts',
      line: 42,
    }]);

    const mgr = new PipelineManager(store, testConfig, repoRootTarget);
    const result = await mgr.fixGithubComments('PROJ-REVIEW');

    expect(vi.mocked(fetchPendingGithubReviewComments)).toHaveBeenCalledWith(
      'https://github.com/org/repo/pull/42',
      ['review:100:2026-04-02T10:00:00Z'],
    );
    expect(result.pendingComments).toBe(1);
    expect(result.task.status).toBe('queued');
    expect(result.task.taskMode).toBe('fix-comments');
    expect(result.task.pendingGithubCommentFingerprints).toEqual(['conversation:101:2026-04-03T10:00:00Z']);

    await new Promise(r => setTimeout(r, 200));

    const updated = store.getTask('PROJ-REVIEW');
    expect(updated?.status).toBe('completed');
    expect(updated?.fixedGithubCommentFingerprints).toEqual([
      'review:100:2026-04-02T10:00:00Z',
      'conversation:101:2026-04-03T10:00:00Z',
    ]);
    expect(updated?.claudeCostUsd).toBe(1);
    expect(updated?.pendingGithubCommentFingerprints).toEqual([]);
    expect(updated?.githubReviewComments).toEqual([]);

    mgr.shutdown();
    store.destroy();
  });

  it('rejects fix-comments runs when no new GitHub review comments exist', async () => {
    const { fetchPendingGithubReviewComments } = await import('../github/review-comments.js');
    store.beginServerEpoch();
    store.upsertTask({
      key: 'PROJ-NO-COMMENTS',
      summary: 'Existing PR task',
      description: 'Existing PR task',
      priority: 'High',
      issueType: 'Story',
      labels: [],
      comments: [],
      jiraUrl: 'https://test.atlassian.net/browse/PROJ-NO-COMMENTS',
      status: 'completed',
      prUrl: 'https://github.com/org/repo/pull/99',
      prNumber: 99,
      branchName: 'jiranimo/PROJ-NO-COMMENTS-feature',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    store.flushSync();

    vi.mocked(fetchPendingGithubReviewComments).mockResolvedValueOnce([]);

    const mgr = new PipelineManager(store, testConfig, repoRootTarget);

    await expect(mgr.fixGithubComments('PROJ-NO-COMMENTS')).rejects.toThrow('no new GitHub review comments');

    mgr.shutdown();
    store.destroy();
  });

  it('queues a continue-work run on the same branch with fresh Jira and GitHub comments', async () => {
    const { fetchPendingGithubReviewComments } = await import('../github/review-comments.js');
    store.beginServerEpoch();
    store.upsertTask({
      key: 'PROJ-CONTINUE',
      summary: 'Existing PR task',
      description: 'Original description',
      priority: 'High',
      issueType: 'Story',
      labels: [],
      comments: [{ author: 'PM', body: 'Initial implementation looks good', created: '2026-04-01T10:00:00Z' }],
      jiraUrl: 'https://test.atlassian.net/browse/PROJ-CONTINUE',
      status: 'completed',
      taskMode: 'implement',
      repoPath: '/tmp/existing-repo',
      prUrl: 'https://github.com/org/repo/pull/77',
      prNumber: 77,
      branchName: 'jiranimo/PROJ-CONTINUE-feature',
      fixedGithubCommentFingerprints: ['review:100:2026-04-02T10:00:00Z'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    store.flushSync();

    vi.mocked(fetchPendingGithubReviewComments).mockResolvedValueOnce([{
      id: 101,
      fingerprint: 'conversation:101:2026-04-03T10:00:00Z',
      kind: 'conversation',
      author: 'reviewer',
      body: 'Please verify the empty state too',
    }]);

    const mgr = new PipelineManager(store, testConfig, repoRootTarget);
    const result = await mgr.continueTask('PROJ-CONTINUE', {
      description: 'Updated description',
      comments: [
        { author: 'PM', body: 'Please re-check the empty state', created: '2026-04-04T08:00:00Z' },
        { author: 'QA', body: 'Also verify the retry path', created: '2026-04-04T09:00:00Z' },
      ],
    });

    expect(result.pendingGithubComments).toBe(1);
    expect(result.task.status).toBe('queued');
    expect(result.task.taskMode).toBe('continue-work');
    expect(result.task.previousTaskMode).toBe('implement');
    expect(result.task.comments).toEqual([
      { author: 'PM', body: 'Please re-check the empty state', created: '2026-04-04T08:00:00Z' },
      { author: 'QA', body: 'Also verify the retry path', created: '2026-04-04T09:00:00Z' },
    ]);
    expect(result.task.pendingGithubCommentFingerprints).toEqual(['conversation:101:2026-04-03T10:00:00Z']);

    await new Promise(r => setTimeout(r, 200));

    const updated = store.getTask('PROJ-CONTINUE');
    expect(updated?.status).toBe('completed');
    expect(updated?.description).toBe('Updated description');
    expect(updated?.fixedGithubCommentFingerprints).toEqual([
      'review:100:2026-04-02T10:00:00Z',
      'conversation:101:2026-04-03T10:00:00Z',
    ]);
    expect(updated?.pendingGithubCommentFingerprints).toEqual([]);

    mgr.shutdown();
    store.destroy();
  });

  it('uses the single repo target directly without repo picker', async () => {
    const { pickRepo } = await import('../repo-picker.js');
    const singleRepoInput = { ...sampleInput, key: 'PROJ-SINGLE' };
    const mgr = new PipelineManager(store, testConfig, singleRepoTarget);
    mgr.submitTask(singleRepoInput);

    await new Promise(r => setTimeout(r, 200));

    expect(vi.mocked(pickRepo)).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ key: 'PROJ-SINGLE' }),
    );
    mgr.shutdown();
    store.destroy();
  });

  it('uses the repo-root target with repo picker', async () => {
    const { pickRepo } = await import('../repo-picker.js');
    const repoRootInput = { ...sampleInput, key: 'PROJ-ROOT' };
    const mgr = new PipelineManager(store, testConfig, repoRootTarget);
    mgr.submitTask(repoRootInput);

    await new Promise(r => setTimeout(r, 200));

    expect(vi.mocked(pickRepo)).toHaveBeenCalledWith('/tmp/repos', expect.objectContaining({ key: 'PROJ-ROOT' }), testConfig.claude);
    mgr.shutdown();
    store.destroy();
  });

  it('waits for repo confirmation and uses the repo chosen by the user', async () => {
    const { pickRepo, listRepos } = await import('../repo-picker.js');
    const reposRoot = mkdtempSync(join(tmpdir(), 'jiranimo-confirm-root-'));
    const detectedRepoPath = join(reposRoot, 'frontend-app');
    const chosenRepoPath = join(reposRoot, 'api-service');

    mkdirSync(join(detectedRepoPath, '.git'), { recursive: true });
    mkdirSync(join(chosenRepoPath, '.git'), { recursive: true });

    vi.mocked(listRepos).mockReturnValueOnce([
      { name: 'frontend-app', hint: 'frontend-app - React UI', path: detectedRepoPath },
      { name: 'api-service', hint: 'api-service - Express API', path: chosenRepoPath },
    ]);
    vi.mocked(pickRepo).mockResolvedValueOnce(detectedRepoPath);

    const mgr = new PipelineManager(store, {
      ...testConfig,
      pipeline: { concurrency: 1, repoConfirmationTimeoutMs: 10_000 },
    }, { kind: 'repo-root', reposRoot });
    mgr.submitTask({ ...sampleInput, key: 'PROJ-CONFIRM' });

    await vi.waitFor(() => {
      const effect = store.getPendingEffects('test.atlassian.net').find(candidate => candidate.type === 'repo-confirmation');
      expect(effect).toBeDefined();
    });

    const { executeClaudeCode } = await import('../claude/executor.js');
    expect(vi.mocked(executeClaudeCode)).not.toHaveBeenCalled();

    const response = mgr.resolveRepoConfirmation('PROJ-CONFIRM', {
      action: 'change',
      repoName: 'api-service',
    });

    expect(response.status).toBe('changed');
    expect(response.repoPath).toBe(chosenRepoPath);

    await vi.waitFor(() => {
      expect(store.getTask('PROJ-CONFIRM')?.status).toBe('completed');
    });

    expect(store.getTask('PROJ-CONFIRM')?.repoPath).toBe(chosenRepoPath);
    expect(store.getPendingEffects('test.atlassian.net').some(effect => effect.type === 'repo-confirmation')).toBe(false);

    rmSync(reposRoot, { recursive: true, force: true });
    mgr.shutdown();
    store.destroy();
  });

  it('auto-confirms the detected repo after 10 seconds with no user response', async () => {
    const { pickRepo, listRepos } = await import('../repo-picker.js');
    const { executeClaudeCode } = await import('../claude/executor.js');
    const reposRoot = mkdtempSync(join(tmpdir(), 'jiranimo-timeout-root-'));
    const detectedRepoPath = join(reposRoot, 'frontend-app');
    const otherRepoPath = join(reposRoot, 'api-service');

    mkdirSync(join(detectedRepoPath, '.git'), { recursive: true });
    mkdirSync(join(otherRepoPath, '.git'), { recursive: true });

    vi.useFakeTimers();
    try {
      vi.mocked(listRepos).mockReturnValueOnce([
        { name: 'frontend-app', hint: 'frontend-app - React UI', path: detectedRepoPath },
        { name: 'api-service', hint: 'api-service - Express API', path: otherRepoPath },
      ]);
      vi.mocked(pickRepo).mockResolvedValueOnce(detectedRepoPath);

      const mgr = new PipelineManager(store, {
        ...testConfig,
        pipeline: { concurrency: 1, repoConfirmationTimeoutMs: 10_000 },
      }, { kind: 'repo-root', reposRoot });
      mgr.submitTask({ ...sampleInput, key: 'PROJ-TIMEOUT' });

      await vi.advanceTimersByTimeAsync(1);

      expect(store.getPendingEffects('test.atlassian.net').some(effect => effect.type === 'repo-confirmation')).toBe(true);
      expect(vi.mocked(executeClaudeCode)).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(10_000);

      expect(store.getPendingEffects('test.atlassian.net').some(effect => effect.type === 'repo-confirmation')).toBe(false);
      expect(vi.mocked(executeClaudeCode)).toHaveBeenCalled();
      expect(store.getTask('PROJ-TIMEOUT')?.repoPath).toBe(detectedRepoPath);

      mgr.shutdown();
    } finally {
      vi.useRealTimers();
      rmSync(reposRoot, { recursive: true, force: true });
      store.destroy();
    }
  });

  it('pauses repo confirmation countdown when the user starts changing the repo', async () => {
    const { pickRepo, listRepos } = await import('../repo-picker.js');
    const { executeClaudeCode } = await import('../claude/executor.js');
    const reposRoot = mkdtempSync(join(tmpdir(), 'jiranimo-pause-root-'));
    const detectedRepoPath = join(reposRoot, 'frontend-app');
    const otherRepoPath = join(reposRoot, 'api-service');

    mkdirSync(join(detectedRepoPath, '.git'), { recursive: true });
    mkdirSync(join(otherRepoPath, '.git'), { recursive: true });

    vi.useFakeTimers();
    try {
      vi.mocked(listRepos).mockReturnValueOnce([
        { name: 'frontend-app', hint: 'frontend-app - React UI', path: detectedRepoPath },
        { name: 'api-service', hint: 'api-service - Express API', path: otherRepoPath },
      ]);
      vi.mocked(pickRepo).mockResolvedValueOnce(detectedRepoPath);

      const mgr = new PipelineManager(store, {
        ...testConfig,
        pipeline: { concurrency: 1, repoConfirmationTimeoutMs: 10_000 },
      }, { kind: 'repo-root', reposRoot });
      mgr.submitTask({ ...sampleInput, key: 'PROJ-PAUSE' });

      await vi.advanceTimersByTimeAsync(1);

      const response = mgr.resolveRepoConfirmation('PROJ-PAUSE', { action: 'pause' });
      expect(response.status).toBe('paused');

      const effect = store.getPendingEffects('test.atlassian.net').find(candidate => candidate.type === 'repo-confirmation');
      expect(effect?.payload.paused).toBe(true);
      expect(effect?.payload.expiresAt).toBeUndefined();

      await vi.advanceTimersByTimeAsync(15_000);

      expect(store.getPendingEffects('test.atlassian.net').some(candidate => candidate.type === 'repo-confirmation')).toBe(true);
      expect(vi.mocked(executeClaudeCode)).not.toHaveBeenCalled();

      mgr.shutdown();
    } finally {
      vi.useRealTimers();
      rmSync(reposRoot, { recursive: true, force: true });
      store.destroy();
    }
  });

  it('shows repo confirmation even when repo-root discovery finds only one repo', async () => {
    const { pickRepo, listRepos } = await import('../repo-picker.js');
    const reposRoot = mkdtempSync(join(tmpdir(), 'jiranimo-single-confirm-root-'));
    const detectedRepoPath = join(reposRoot, 'customer-web');

    mkdirSync(join(detectedRepoPath, '.git'), { recursive: true });

    vi.mocked(listRepos).mockReturnValueOnce([
      { name: 'customer-web', hint: 'customer-web - storefront', path: detectedRepoPath },
    ]);
    vi.mocked(pickRepo).mockResolvedValueOnce(detectedRepoPath);

    const mgr = new PipelineManager(store, {
      ...testConfig,
      pipeline: { concurrency: 1, repoConfirmationTimeoutMs: 10_000 },
    }, { kind: 'repo-root', reposRoot });
    mgr.submitTask({ ...sampleInput, key: 'PROJ-SINGLE-CONFIRM' });

    await vi.waitFor(() => {
      const effect = store.getPendingEffects('test.atlassian.net').find(candidate => candidate.type === 'repo-confirmation');
      expect(effect).toBeDefined();
      expect(effect?.payload.detectedRepoName).toBe('customer-web');
    });

    const response = mgr.resolveRepoConfirmation('PROJ-SINGLE-CONFIRM', { action: 'confirm' });
    expect(response.status).toBe('confirmed');
    expect(response.repoPath).toBe(detectedRepoPath);

    await vi.waitFor(() => {
      expect(store.getTask('PROJ-SINGLE-CONFIRM')?.status).toBe('completed');
    });

    rmSync(reposRoot, { recursive: true, force: true });
    mgr.shutdown();
    store.destroy();
  });

  it('prunes tasks older than the retention window during startup', () => {
    const statePath = join(tmpDir, 'state.json');
    store.destroy();
    writeFileSync(statePath, JSON.stringify({
      meta: { serverEpoch: 0, revision: 0 },
      tasks: {
        'PROJ-OLD': {
          key: 'PROJ-OLD',
          summary: 'Old task',
          description: 'Old task',
          priority: 'High',
          issueType: 'Story',
          labels: [],
          jiraUrl: 'https://test.atlassian.net/browse/PROJ-OLD',
          status: 'completed',
          createdAt: '2025-01-01T00:00:00.000Z',
          updatedAt: '2025-01-05T00:00:00.000Z',
          completedAt: '2025-01-05T00:00:00.000Z',
        },
      },
      queue: [],
      effects: {},
    }));
    store = new StateStore({ filePath: statePath, flushDelayMs: 0 });

    const mgr = new PipelineManager(store, testConfig, repoRootTarget);

    expect(store.getTask('PROJ-OLD')).toBeUndefined();
    mgr.shutdown();
    store.destroy();
  });
});
