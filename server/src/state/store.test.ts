import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StateStore } from './store.js';
import type { TaskRecord } from './types.js';

function makeTask(overrides?: Partial<TaskRecord>): TaskRecord {
  return {
    key: 'PROJ-1',
    summary: 'Test task',
    description: 'A test task',
    priority: 'Medium',
    issueType: 'Story',
    labels: ['ai-ready'],
    jiraUrl: 'https://test.atlassian.net/browse/PROJ-1',
    status: 'queued',
    trackedBoards: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

let tmpDir: string;
let statePath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'jiranimo-test-'));
  statePath = join(tmpDir, 'state.json');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('StateStore', () => {
  it('starts with empty state when file does not exist', () => {
    const store = new StateStore({ filePath: statePath, flushDelayMs: 0 });
    expect(store.getAllTasks()).toEqual([]);
    store.destroy();
  });

  it('upserts and retrieves a task', () => {
    const store = new StateStore({ filePath: statePath, flushDelayMs: 0 });
    const task = makeTask();
    store.upsertTask(task);
    expect(store.getTask('PROJ-1')).toMatchObject({ key: 'PROJ-1', summary: 'Test task' });
    store.destroy();
  });

  it('updates task status', () => {
    const store = new StateStore({ filePath: statePath, flushDelayMs: 0 });
    store.upsertTask(makeTask());
    const updated = store.updateTaskStatus('PROJ-1', 'in-progress', { startedAt: new Date().toISOString() });
    expect(updated.status).toBe('in-progress');
    expect(updated.startedAt).toBeDefined();
    store.destroy();
  });

  it('throws when updating non-existent task', () => {
    const store = new StateStore({ filePath: statePath, flushDelayMs: 0 });
    expect(() => store.updateTaskStatus('NOPE-1', 'completed')).toThrow('Task NOPE-1 not found');
    store.destroy();
  });

  it('filters tasks by status', () => {
    const store = new StateStore({ filePath: statePath, flushDelayMs: 0 });
    store.upsertTask(makeTask({ key: 'PROJ-1', status: 'queued' }));
    store.upsertTask(makeTask({ key: 'PROJ-2', status: 'in-progress' }));
    store.upsertTask(makeTask({ key: 'PROJ-3', status: 'queued' }));

    expect(store.getTasksByStatus('queued')).toHaveLength(2);
    expect(store.getTasksByStatus('in-progress')).toHaveLength(1);
    expect(store.getTasksByStatus('completed')).toHaveLength(0);
    store.destroy();
  });

  it('deletes a task', () => {
    const store = new StateStore({ filePath: statePath, flushDelayMs: 0 });
    store.upsertTask(makeTask());
    expect(store.deleteTask('PROJ-1')).toBe(true);
    expect(store.getTask('PROJ-1')).toBeUndefined();
    store.destroy();
  });

  it('returns false when deleting non-existent task', () => {
    const store = new StateStore({ filePath: statePath, flushDelayMs: 0 });
    expect(store.deleteTask('NOPE-1')).toBe(false);
    store.destroy();
  });

  it('clears all tasks', () => {
    const store = new StateStore({ filePath: statePath, flushDelayMs: 0 });
    store.upsertTask(makeTask({ key: 'PROJ-1' }));
    store.upsertTask(makeTask({ key: 'PROJ-2' }));
    store.clear();
    expect(store.getAllTasks()).toEqual([]);
    store.destroy();
  });

  it('persists state to disk via flushSync', () => {
    const store = new StateStore({ filePath: statePath, flushDelayMs: 0 });
    store.upsertTask(makeTask());
    store.flushSync();

    const raw = readFileSync(statePath, 'utf-8');
    const persisted = JSON.parse(raw);
    expect(persisted.tasks['PROJ-1'].key).toBe('PROJ-1');
    store.destroy();
  });

  it('loads persisted state on construction', () => {
    // Write state, create new store, verify it loads
    const store1 = new StateStore({ filePath: statePath, flushDelayMs: 0 });
    store1.upsertTask(makeTask({ key: 'PROJ-99', summary: 'Persisted' }));
    store1.flushSync();
    store1.destroy();

    const store2 = new StateStore({ filePath: statePath, flushDelayMs: 0 });
    expect(store2.getTask('PROJ-99')?.summary).toBe('Persisted');
    store2.destroy();
  });

  it('normalizes persisted GitHub review comment tracking fields on load', () => {
    const store1 = new StateStore({ filePath: statePath, flushDelayMs: 0 });
    store1.upsertTask(makeTask({
      key: 'PROJ-GH',
      githubReviewComments: [{
        id: 101,
        fingerprint: 'review:101:2026-04-03T10:00:00Z',
        kind: 'review',
        author: 'reviewer',
        body: 'Please rename this helper',
      }],
      fixedGithubCommentFingerprints: ['review:101:2026-04-03T10:00:00Z', 'review:101:2026-04-03T10:00:00Z'],
      pendingGithubCommentFingerprints: ['conversation:102:2026-04-03T10:05:00Z'],
    }));
    store1.flushSync();
    store1.destroy();

    const store2 = new StateStore({ filePath: statePath, flushDelayMs: 0 });
    const task = store2.getTask('PROJ-GH');

    expect(task?.githubReviewComments).toEqual([{
      id: 101,
      fingerprint: 'review:101:2026-04-03T10:00:00Z',
      kind: 'review',
      author: 'reviewer',
      body: 'Please rename this helper',
      path: undefined,
      line: undefined,
      url: undefined,
      created: undefined,
      updated: undefined,
    }]);
    expect(task?.fixedGithubCommentFingerprints).toEqual(['review:101:2026-04-03T10:00:00Z']);
    expect(task?.pendingGithubCommentFingerprints).toEqual(['conversation:102:2026-04-03T10:05:00Z']);
    store2.destroy();
  });

  it('handles corrupted state file gracefully', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(statePath, 'not valid json!!!');

    const store = new StateStore({ filePath: statePath, flushDelayMs: 0 });
    expect(store.getAllTasks()).toEqual([]);
    store.destroy();
  });

  it('increments server epoch on boot and resets claimed effects', () => {
    const store = new StateStore({ filePath: statePath, flushDelayMs: 0 });
    store.createEffect({
      id: 'effect-1',
      type: 'pipeline-status-sync',
      taskKey: 'PROJ-1',
      jiraHost: 'test.atlassian.net',
      payload: { issueKey: 'PROJ-1', pipelineStatus: 'in-progress' },
      status: 'claimed',
      claimedBy: 'client-1',
      claimEpoch: 1,
      claimExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const meta = store.beginServerEpoch();
    const effect = store.getEffect('effect-1');
    expect(meta.serverEpoch).toBe(1);
    expect(effect?.status).toBe('pending');
    expect(effect?.claimedBy).toBeUndefined();
    store.destroy();
  });

  it('claims and acknowledges effects', () => {
    const store = new StateStore({ filePath: statePath, flushDelayMs: 0 });
    store.beginServerEpoch();
    store.createEffect({
      id: 'effect-2',
      type: 'plan-comment',
      taskKey: 'PROJ-2',
      jiraHost: 'test.atlassian.net',
      payload: { issueKey: 'PROJ-2', body: 'Plan', hash: 'hash' },
    });

    const claimed = store.claimEffect('effect-2', 'client-2', 10_000);
    expect(claimed.status).toBe('claimed');
    expect(claimed.claimedBy).toBe('client-2');
    expect(store.ackEffect('effect-2')).toBe(true);
    expect(store.getEffect('effect-2')).toBeUndefined();
    store.destroy();
  });

  it('does not allow the same client to reclaim an active effect lease', () => {
    const store = new StateStore({ filePath: statePath, flushDelayMs: 0 });
    store.beginServerEpoch();
    store.createEffect({
      id: 'effect-3',
      type: 'plan-comment',
      taskKey: 'PROJ-3',
      jiraHost: 'test.atlassian.net',
      payload: { issueKey: 'PROJ-3', body: 'Plan', hash: 'hash' },
    });

    store.claimEffect('effect-3', 'client-3', 10_000);
    expect(() => store.claimEffect('effect-3', 'client-3', 10_000)).toThrow('already claimed');
    store.destroy();
  });

  it('reconciles board presence and stores board snapshots', () => {
    const store = new StateStore({ filePath: statePath, flushDelayMs: 0 });
    store.upsertTask(makeTask({ trackedBoards: ['test.atlassian.net:board-1'] }));

    const result = store.reconcileBoardPresence({
      boardId: 'board-1',
      jiraHost: 'test.atlassian.net',
      boardType: 'scrum',
      projectKey: 'PROJ',
      issueKeys: ['PROJ-1'],
    });

    expect(result.deletedTaskKeys).toEqual([]);
    expect(store.getTask('PROJ-1')?.trackedBoards).toEqual(['test.atlassian.net:board-1']);
    expect(store.getTask('PROJ-1')?.lastSeenOnBoardAt).toBeDefined();
    expect(store.getBoardSnapshots('test.atlassian.net')).toHaveLength(1);
    store.destroy();
  });

  it('removes tasks when their last tracked board no longer contains them', () => {
    const store = new StateStore({ filePath: statePath, flushDelayMs: 0 });
    store.upsertTask(makeTask({ trackedBoards: ['test.atlassian.net:board-1'] }));

    const result = store.reconcileBoardPresence({
      boardId: 'board-1',
      jiraHost: 'test.atlassian.net',
      boardType: 'scrum',
      projectKey: 'PROJ',
      issueKeys: [],
    });

    expect(result.deletedTaskKeys).toEqual(['PROJ-1']);
    expect(store.getTask('PROJ-1')).toBeUndefined();
    store.destroy();
  });
});
