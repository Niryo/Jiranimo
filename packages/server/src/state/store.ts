import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import type {
  AppMeta,
  AppState,
  EffectRecord,
  TaskRecord,
  TaskStatus,
} from './types.js';

const DEFAULT_STATE_PATH = resolve(homedir(), '.jiranimo', 'state.json');

function defaultMeta(): AppMeta {
  return { serverEpoch: 0, revision: 0 };
}

function emptyState(): AppState {
  return {
    meta: defaultMeta(),
    tasks: {},
    queue: [],
    effects: {},
  };
}

function cloneTask(task: TaskRecord): TaskRecord {
  return JSON.parse(JSON.stringify(task)) as TaskRecord;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === 'string' && item.length > 0))];
}

function normalizeGithubReviewComments(value: unknown): TaskRecord['githubReviewComments'] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is NonNullable<TaskRecord['githubReviewComments']>[number] =>
      !!item
      && typeof item === 'object'
      && typeof (item as { id?: unknown }).id === 'number'
      && typeof (item as { fingerprint?: unknown }).fingerprint === 'string'
      && ((item as { kind?: unknown }).kind === 'review' || (item as { kind?: unknown }).kind === 'conversation')
      && typeof (item as { author?: unknown }).author === 'string'
      && typeof (item as { body?: unknown }).body === 'string',
    )
    .map(item => ({
      id: item.id,
      fingerprint: item.fingerprint,
      kind: item.kind,
      author: item.author,
      body: item.body,
      path: typeof item.path === 'string' ? item.path : undefined,
      line: typeof item.line === 'number' ? item.line : undefined,
      url: typeof item.url === 'string' ? item.url : undefined,
      created: typeof item.created === 'string' ? item.created : undefined,
      updated: typeof item.updated === 'string' ? item.updated : undefined,
    }));
}

function normalizeTask(task: TaskRecord): TaskRecord {
  return {
    ...task,
    trackedBoards: normalizeStringArray(task.trackedBoards),
    fixedGithubCommentFingerprints: normalizeStringArray(task.fixedGithubCommentFingerprints),
    pendingGithubCommentFingerprints: normalizeStringArray(task.pendingGithubCommentFingerprints),
    githubReviewComments: normalizeGithubReviewComments(task.githubReviewComments),
  };
}

export function boardTrackingKey(jiraHost: string, boardId: string): string {
  return `${jiraHost}:${boardId}`;
}

export class StateStore {
  private state: AppState;
  private filePath: string;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushDelayMs: number;

  constructor(options?: { filePath?: string; flushDelayMs?: number }) {
    this.filePath = options?.filePath ?? DEFAULT_STATE_PATH;
    this.flushDelayMs = options?.flushDelayMs ?? 100;
    this.state = this.load();
  }

  private load(): AppState {
    let raw: string;
    try {
      raw = readFileSync(this.filePath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return emptyState();
      }
      throw new Error(`Failed to read state file ${this.filePath}: ${(err as Error).message}`);
    }

    let parsed: Partial<AppState> & { tasks?: Record<string, TaskRecord> };
    try {
      parsed = JSON.parse(raw) as Partial<AppState> & { tasks?: Record<string, TaskRecord> };
    } catch (err) {
      throw new Error(
        `Invalid JSON in state file ${this.filePath}; refusing to start to avoid overwriting existing state: ${(err as Error).message}`,
      );
    }

    const tasks = parsed?.tasks && typeof parsed.tasks === 'object'
      ? Object.fromEntries(
          Object.entries(parsed.tasks)
            .map(([key, task]) => [key, normalizeTask(task)]),
        )
      : {};
    return {
      meta: parsed?.meta && typeof parsed.meta === 'object'
        ? {
            serverEpoch: Number(parsed.meta.serverEpoch ?? 0),
            revision: Number(parsed.meta.revision ?? 0),
          }
        : defaultMeta(),
      tasks,
      queue: Array.isArray(parsed?.queue) ? parsed.queue.filter((key): key is string => typeof key === 'string') : [],
      effects: parsed?.effects && typeof parsed.effects === 'object' ? parsed.effects : {},
    };
  }

  private mutate(mutator: () => void): void {
    mutator();
    this.state.meta.revision += 1;
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushSync();
      this.flushTimer = null;
    }, this.flushDelayMs);
  }

  flushSync(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    mkdirSync(dirname(this.filePath), { recursive: true });
    const raw = JSON.stringify(this.state, null, 2);
    const tempPath = `${this.filePath}.tmp-${process.pid}`;
    writeFileSync(tempPath, raw, 'utf-8');
    renameSync(tempPath, this.filePath);
  }

  getMeta(): AppMeta {
    return { ...this.state.meta };
  }

  beginServerEpoch(): AppMeta {
    this.mutate(() => {
      this.state.meta.serverEpoch += 1;
      for (const effect of Object.values(this.state.effects)) {
        effect.status = 'pending';
        effect.claimedBy = undefined;
        effect.claimExpiresAt = undefined;
        effect.claimEpoch = undefined;
        effect.updatedAt = new Date().toISOString();
      }
    });
    return this.getMeta();
  }

  releaseExpiredClaims(now = new Date()): number {
    const expiredIds = Object.values(this.state.effects)
      .filter(effect =>
        effect.status === 'claimed'
        && effect.claimExpiresAt
        && new Date(effect.claimExpiresAt).getTime() <= now.getTime(),
      )
      .map(effect => effect.id);
    if (expiredIds.length === 0) {
      return 0;
    }
    this.mutate(() => {
      for (const effectId of expiredIds) {
        const effect = this.state.effects[effectId];
        if (!effect) continue;
        effect.status = 'pending';
        effect.claimedBy = undefined;
        effect.claimExpiresAt = undefined;
        effect.claimEpoch = undefined;
        effect.updatedAt = now.toISOString();
      }
    });
    return expiredIds.length;
  }

  getTask(key: string): TaskRecord | undefined {
    const task = this.state.tasks[key];
    return task ? cloneTask(task) : undefined;
  }

  getAllTasks(): TaskRecord[] {
    return Object.values(this.state.tasks)
      .map(cloneTask)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  getTasksByStatus(status: TaskStatus): TaskRecord[] {
    return this.getAllTasks().filter(t => t.status === status);
  }

  upsertTask(task: TaskRecord): TaskRecord {
    const incoming = normalizeTask(cloneTask(task));
    this.mutate(() => {
      incoming.updatedAt = new Date().toISOString();
      incoming.attempt = incoming.attempt ?? 0;
      incoming.recoveryState = incoming.recoveryState ?? 'none';
      this.state.tasks[incoming.key] = incoming;
    });
    return this.getTask(incoming.key)!;
  }

  updateTaskStatus(key: string, status: TaskStatus, extra?: Partial<TaskRecord>): TaskRecord {
    let updated!: TaskRecord;
    this.mutate(() => {
      const task = this.state.tasks[key];
      if (!task) throw new Error(`Task ${key} not found`);
      task.status = status;
      task.updatedAt = new Date().toISOString();
      if (extra) Object.assign(task, extra);
      updated = cloneTask(task);
    });
    return updated;
  }

  patchTask(key: string, extra: Partial<TaskRecord>): TaskRecord {
    let updated!: TaskRecord;
    this.mutate(() => {
      const task = this.state.tasks[key];
      if (!task) throw new Error(`Task ${key} not found`);
      Object.assign(task, extra);
      task.updatedAt = new Date().toISOString();
      updated = cloneTask(task);
    });
    return updated;
  }

  enqueueTask(key: string): void {
    if (this.state.queue.includes(key)) return;
    this.mutate(() => {
      this.state.queue.push(key);
    });
  }

  dequeueTask(): string | undefined {
    let key: string | undefined;
    this.mutate(() => {
      key = this.state.queue.shift();
    });
    return key;
  }

  removeFromQueue(key: string): void {
    if (!this.state.queue.includes(key)) return;
    this.mutate(() => {
      this.state.queue = this.state.queue.filter(existing => existing !== key);
    });
  }

  getQueue(): string[] {
    return [...this.state.queue];
  }

  createEffect(effect: Omit<EffectRecord, 'createdAt' | 'updatedAt' | 'status'> & { status?: EffectRecord['status'] }): EffectRecord {
    const now = new Date().toISOString();
    const record: EffectRecord = {
      ...effect,
      status: effect.status ?? 'pending',
      createdAt: now,
      updatedAt: now,
    };
    this.mutate(() => {
      this.state.effects[record.id] = record;
    });
    return { ...record };
  }

  patchEffect(id: string, patch: Partial<Omit<EffectRecord, 'id' | 'createdAt'>>): EffectRecord | undefined {
    let updated: EffectRecord | undefined;
    this.mutate(() => {
      const effect = this.state.effects[id];
      if (!effect) return;
      Object.assign(effect, patch);
      effect.updatedAt = new Date().toISOString();
      updated = { ...effect };
    });
    return updated;
  }

  getEffect(id: string): EffectRecord | undefined {
    const effect = this.state.effects[id];
    return effect ? { ...effect } : undefined;
  }

  getPendingEffects(jiraHost?: string): EffectRecord[] {
    return Object.values(this.state.effects)
      .filter(effect => !jiraHost || effect.jiraHost === jiraHost)
      .map(effect => ({ ...effect }))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  pruneTasksOlderThan(cutoff: Date): string[] {
    const cutoffMs = cutoff.getTime();
    const deletedTaskKeys = Object.values(this.state.tasks)
      .filter((task) => {
        const timestamp = Date.parse(task.updatedAt || task.completedAt || task.createdAt);
        return Number.isFinite(timestamp) && timestamp <= cutoffMs;
      })
      .map(task => task.key);

    if (deletedTaskKeys.length === 0) {
      return [];
    }

    this.mutate(() => {
      for (const taskKey of deletedTaskKeys) {
        delete this.state.tasks[taskKey];
        this.state.queue = this.state.queue.filter(existing => existing !== taskKey);
        for (const [effectId, effect] of Object.entries(this.state.effects)) {
          if (effect.taskKey === taskKey) {
            delete this.state.effects[effectId];
          }
        }
      }
    });

    return deletedTaskKeys;
  }

  claimEffect(id: string, clientId: string, leaseMs: number): EffectRecord {
    const now = new Date();
    let claimed!: EffectRecord;
    this.mutate(() => {
      const effect = this.state.effects[id];
      if (!effect) throw new Error(`Effect ${id} not found`);
      const expired = effect.claimExpiresAt ? new Date(effect.claimExpiresAt).getTime() <= now.getTime() : false;
      if (effect.status === 'claimed' && !expired) {
        throw new Error(`Effect ${id} is already claimed`);
      }
      effect.status = 'claimed';
      effect.claimedBy = clientId;
      effect.claimExpiresAt = new Date(now.getTime() + leaseMs).toISOString();
      effect.claimEpoch = this.state.meta.serverEpoch;
      effect.updatedAt = now.toISOString();
      claimed = { ...effect };
    });
    return claimed;
  }

  ackEffect(id: string): boolean {
    if (!this.state.effects[id]) {
      return false;
    }
    this.mutate(() => {
      delete this.state.effects[id];
    });
    return true;
  }

  deleteTask(key: string): boolean {
    if (!this.state.tasks[key]) {
      return false;
    }
    this.mutate(() => {
      delete this.state.tasks[key];
      this.state.queue = this.state.queue.filter(existing => existing !== key);
      for (const [effectId, effect] of Object.entries(this.state.effects)) {
        if (effect.taskKey === key) {
          delete this.state.effects[effectId];
        }
      }
    });
    return true;
  }

  clear(): void {
    this.mutate(() => {
      this.state = emptyState();
    });
  }

  destroy(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }
}
