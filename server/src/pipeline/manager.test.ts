import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PipelineManager } from './manager.js';
import { StateStore } from '../state/store.js';
import type { ServerConfig } from '../config/types.js';
import type { TaskInput } from '../claude/types.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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
}));

// Mock MCP config helpers
vi.mock('../mcp/server.js', () => ({
  createMcpHandler: vi.fn(),
  writeMcpConfig: vi.fn(),
  deleteMcpConfig: vi.fn(),
}));

// Mock task classifier so it doesn't consume executor mock calls
vi.mock('../claude/task-classifier.js', () => ({
  classifyTask: vi.fn().mockResolvedValue('implement'),
}));

const testConfig: ServerConfig = {
  reposRoot: '/tmp/repos',
  claude: { maxBudgetUsd: 2.0 },
  pipeline: { concurrency: 1 },
  git: { branchPrefix: 'jiranimo/', defaultBaseBranch: 'main', pushRemote: 'origin', createDraftPr: true },
  web: { port: 3456, host: '127.0.0.1' },
};

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
    const mgr = new PipelineManager(store, testConfig);
    const task = mgr.submitTask(sampleInput);
    expect(task.status).toBe('queued');
    expect(task.key).toBe('PROJ-1');
    store.destroy();
  });

  it('emits task-created event on submit', () => {
    const mgr = new PipelineManager(store, testConfig);
    const handler = vi.fn();
    mgr.on('task-created', handler);
    mgr.submitTask(sampleInput);
    expect(handler).toHaveBeenCalledOnce();
    store.destroy();
  });

  it('rejects duplicate task submission while queued or in-progress', () => {
    const mgr = new PipelineManager(store, testConfig);
    mgr.submitTask(sampleInput);
    expect(() => mgr.submitTask(sampleInput)).toThrow('already');
    store.destroy();
  });

  it('allows resubmission of completed tasks', async () => {
    const mgr = new PipelineManager(store, testConfig);
    mgr.submitTask(sampleInput);

    await new Promise(r => setTimeout(r, 100));

    const task = store.getTask('PROJ-1');
    expect(task?.status).toBe('completed');

    const resubmitted = mgr.submitTask(sampleInput);
    expect(resubmitted.status).toBe('queued');
    store.destroy();
  });

  it('processes task through full lifecycle', async () => {
    const mgr = new PipelineManager(store, testConfig);
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

    const mgr = new PipelineManager(store, testConfig);
    mgr.submitTask(sampleInput);

    await new Promise(r => setTimeout(r, 200));
    expect(store.getTask('PROJ-1')?.status).toBe('failed');

    mgr.retryTask('PROJ-1');
    await new Promise(r => setTimeout(r, 200));
    expect(store.getTask('PROJ-1')?.status).toBe('completed');
    store.destroy();
  });

  it('throws when retrying non-failed task', () => {
    const mgr = new PipelineManager(store, testConfig);
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

    const mgr = new PipelineManager(store, testConfig);
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

    const mgr = new PipelineManager(store, testConfig);
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

    const mgr = new PipelineManager(store, testConfig);
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

    const mgr = new PipelineManager(store, testConfig);
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
    const mgr = new PipelineManager(store, testConfig);
    mgr.submitTask(sampleInput);

    await new Promise(r => setTimeout(r, 200));

    const sessionLogs = consoleSpy.mock.calls
      .map(args => args[0] as string)
      .filter(msg => typeof msg === 'string' && msg.includes('[CLAUDE] Session started:'));

    expect(sessionLogs).toHaveLength(1);
    consoleSpy.mockRestore();
    store.destroy();
  });

  it('reportProgress emits task-output event', () => {
    const mgr = new PipelineManager(store, testConfig);
    const handler = vi.fn();
    mgr.on('task-output', handler);
    mgr.reportProgress('PROJ-1', 'Running tests...');
    expect(handler).toHaveBeenCalledWith('PROJ-1', expect.stringContaining('Running tests'));
    store.destroy();
  });

  it('reportPr stores PR info in task state', () => {
    const mgr = new PipelineManager(store, testConfig);
    mgr.submitTask(sampleInput);
    mgr.reportPr('PROJ-1', 'https://github.com/org/repo/pull/42', 42, 'jiranimo/PROJ-1-feature');
    const task = store.getTask('PROJ-1');
    expect(task?.prUrl).toBe('https://github.com/org/repo/pull/42');
    expect(task?.prNumber).toBe(42);
    expect(task?.branchName).toBe('jiranimo/PROJ-1-feature');
    store.destroy();
  });

  it('completeViaAgent transitions in-progress task to completed with summary', () => {
    const mgr = new PipelineManager(store, testConfig);
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
});
