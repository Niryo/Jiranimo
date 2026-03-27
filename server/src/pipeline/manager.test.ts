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

// Mock git operations (worktree, commit)
vi.mock('../git/worktree.js', () => ({
  findGitRepo: vi.fn().mockResolvedValue('/tmp/test-repo'),
  createWorktree: vi.fn().mockResolvedValue('/tmp/test-repo/.jiranimo-worktrees/PROJ-1'),
  removeWorktree: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../git/branch.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../git/branch.js')>();
  return {
    ...original,
    commitAndPush: vi.fn().mockResolvedValue(undefined),
  };
});

const testConfig: ServerConfig = {
  repoPath: '/tmp/test-repo',
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

    // Wait for async processing
    await new Promise(r => setTimeout(r, 100));

    const task = store.getTask('PROJ-1');
    expect(task?.status).toBe('completed');

    // Resubmit should work
    const resubmitted = mgr.submitTask(sampleInput);
    expect(resubmitted.status).toBe('queued');
    store.destroy();
  });

  it('processes task through full lifecycle', async () => {
    const mgr = new PipelineManager(store, testConfig);
    const statusChanges: string[] = [];
    mgr.on('task-status-changed', (task) => statusChanges.push(task.status));

    mgr.submitTask(sampleInput);

    // Wait for async processing
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

    // First call fails
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

  it('logs session started only once even when multiple init events arrive', async () => {
    const { executeClaudeCode } = await import('../claude/executor.js');

    // Simulate Claude emitting multiple system/init events with the same session ID
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
});
