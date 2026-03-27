import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import type { AppState, TaskRecord, TaskStatus } from './types.js';

const DEFAULT_STATE_PATH = resolve(homedir(), '.jiranimo', 'state.json');

function emptyState(): AppState {
  return { tasks: {} };
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
    try {
      const raw = readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && parsed.tasks) {
        return parsed as AppState;
      }
      return emptyState();
    } catch {
      return emptyState();
    }
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
    writeFileSync(this.filePath, JSON.stringify(this.state, null, 2), 'utf-8');
  }

  getTask(key: string): TaskRecord | undefined {
    return this.state.tasks[key];
  }

  getAllTasks(): TaskRecord[] {
    return Object.values(this.state.tasks);
  }

  getTasksByStatus(status: TaskStatus): TaskRecord[] {
    return this.getAllTasks().filter(t => t.status === status);
  }

  upsertTask(task: TaskRecord): void {
    task.updatedAt = new Date().toISOString();
    this.state.tasks[task.key] = task;
    this.scheduleFlush();
  }

  updateTaskStatus(key: string, status: TaskStatus, extra?: Partial<TaskRecord>): TaskRecord {
    const task = this.state.tasks[key];
    if (!task) throw new Error(`Task ${key} not found`);
    task.status = status;
    task.updatedAt = new Date().toISOString();
    if (extra) Object.assign(task, extra);
    this.scheduleFlush();
    return task;
  }

  deleteTask(key: string): boolean {
    if (!this.state.tasks[key]) return false;
    delete this.state.tasks[key];
    this.scheduleFlush();
    return true;
  }

  clear(): void {
    this.state = emptyState();
    this.scheduleFlush();
  }

  destroy(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }
}
