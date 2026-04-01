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
});
