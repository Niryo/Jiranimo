import { EventEmitter } from 'node:events';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { writeFileSync } from 'node:fs';
import type { ServerConfig } from '../config/types.js';
import type { TaskRecord, TaskStatus } from '../state/types.js';
import type { ClaudeEvent, ExecutionResult, TaskInput } from '../claude/types.js';
import { StateStore } from '../state/store.js';
import { transition } from './state-machine.js';
import { buildPrompt } from '../claude/prompt-builder.js';
import { executeClaudeCode } from '../claude/executor.js';

export class PipelineManager extends EventEmitter {
  private store: StateStore;
  private config: ServerConfig;
  private running = false;
  private queue: string[] = [];
  private processing = false;

  constructor(store: StateStore, config: ServerConfig) {
    super();
    this.store = store;
    this.config = config;
  }

  submitTask(input: TaskInput): TaskRecord {
    const existing = this.store.getTask(input.key);
    if (existing && (existing.status === 'queued' || existing.status === 'in-progress')) {
      throw new Error(`Task ${input.key} is already ${existing.status}`);
    }

    const task: TaskRecord = {
      key: input.key,
      summary: input.summary,
      description: input.description,
      acceptanceCriteria: input.acceptanceCriteria,
      priority: input.priority,
      issueType: input.issueType,
      labels: input.labels,
      comments: input.comments,
      subtasks: input.subtasks,
      linkedIssues: input.linkedIssues,
      attachments: input.attachments,
      assignee: input.assignee,
      reporter: input.reporter,
      components: input.components,
      parentKey: input.parentKey,
      jiraUrl: input.jiraUrl,
      status: 'queued',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.store.upsertTask(task);
    this.store.flushSync();
    this.queue.push(task.key);
    this.emit('task-created', task);
    setImmediate(() => this.processQueue());
    return task;
  }

  retryTask(key: string): TaskRecord {
    const task = this.store.getTask(key);
    if (!task) throw new Error(`Task ${key} not found`);

    const newStatus = transition(task.status, 'retry');
    const oldStatus = task.status;
    this.store.updateTaskStatus(key, newStatus, { errorMessage: undefined });
    this.store.flushSync();
    this.queue.push(key);
    this.emit('task-status-changed', this.store.getTask(key)!, oldStatus);
    setImmediate(() => this.processQueue());
    return this.store.getTask(key)!;
  }

  private processQueue(): void {
    if (this.processing) return;
    this.processing = true;

    try {
      while (this.queue.length > 0 && !this.running) {
        const key = this.queue.shift();
        if (!key) break;
        const task = this.store.getTask(key);
        if (!task) continue;
        this.runTask(key);
        break;
      }
    } finally {
      this.processing = false;
    }
  }

  private transitionTask(key: string, action: 'start' | 'complete' | 'fail', extra?: Partial<TaskRecord>): void {
    const task = this.store.getTask(key);
    if (!task) return;
    const oldStatus = task.status;
    const newStatus = transition(task.status, action);
    this.store.updateTaskStatus(key, newStatus, extra);
    this.store.flushSync();
    const updated = this.store.getTask(key)!;
    this.emit('task-status-changed', updated, oldStatus);
    if (newStatus === 'completed' || newStatus === 'failed') {
      this.emit('task-completed', updated);
    }
  }

  private async runTask(key: string): Promise<void> {
    const task = this.store.getTask(key)!;
    const repoPath = this.config.repoPath;

    this.running = true;
    console.log(`\n${'='.repeat(60)}`);
    console.log(`[PIPELINE] Starting task: ${task.key} — ${task.summary}`);
    console.log(`[PIPELINE] Repo path: ${repoPath}`);
    console.log(`${'='.repeat(60)}`);
    this.transitionTask(key, 'start', { startedAt: new Date().toISOString() });

    const logsDir = this.config.logsDir ?? resolve(homedir(), '.jiranimo', 'logs');
    mkdirSync(logsDir, { recursive: true });
    const logPath = join(logsDir, `${key}-${Date.now()}.jsonl`);
    const logLines: string[] = [];

    try {
      const prompt = buildPrompt(task, this.config.claude.appendSystemPrompt);

      console.log(`[PIPELINE] Prompt built (${prompt.length} chars)`);
      console.log(`[PIPELINE] Spawning Claude Code...`);
      console.log(`[PIPELINE] Command: ${this.config.claude.command ?? 'claude'}`);
      console.log(`${'─'.repeat(60)}`);

      const result: ExecutionResult = await executeClaudeCode({
        prompt,
        cwd: repoPath,
        config: this.config.claude,
        timeoutMs: 30 * 60 * 1000,
        onEvent: (event: ClaudeEvent) => {
          logLines.push(JSON.stringify(event.raw));
          this.emit('task-output', key, JSON.stringify(event.raw));
          // Print Claude's output to server console
          if (event.text) {
            console.log(`[CLAUDE] ${event.text}`);
          } else if (event.type === 'init') {
            console.log(`[CLAUDE] Session started: ${event.sessionId || 'unknown'}`);
          } else if (event.type === 'result') {
            console.log(`[CLAUDE] Result: ${event.isError ? 'ERROR' : 'SUCCESS'} — ${event.text?.slice(0, 200) || ''}`);
          }
        },
        onOutput: (raw: string) => {
          // Print raw output lines that aren't JSON (stderr-like messages)
          for (const line of raw.split('\n')) {
            const trimmed = line.trim();
            if (trimmed && !trimmed.startsWith('{')) {
              console.log(`[CLAUDE RAW] ${trimmed}`);
            }
          }
        },
      });

      console.log(`${'─'.repeat(60)}`);
      console.log(`[PIPELINE] Claude finished — success: ${result.success}, cost: $${result.costUsd ?? 0}, duration: ${result.durationMs}ms`);
      writeFileSync(logPath, logLines.join('\n'), 'utf-8');
      console.log(`[PIPELINE] Logs saved to: ${logPath}`);

      if (!result.success) {
        throw new Error(result.resultText);
      }

      this.transitionTask(key, 'complete', {
        claudeSessionId: result.sessionId,
        claudeCostUsd: result.costUsd,
        logPath,
        completedAt: new Date().toISOString(),
      });
      console.log(`[PIPELINE] ✓ Task ${key} completed successfully`);
      console.log(`${'='.repeat(60)}\n`);
    } catch (err) {
      writeFileSync(logPath, logLines.join('\n'), 'utf-8');
      console.error(`[PIPELINE] ✗ Task ${key} failed: ${(err as Error).message}`);
      console.log(`[PIPELINE] Logs: ${logPath}`);
      console.log(`${'='.repeat(60)}\n`);
      this.transitionTask(key, 'fail', {
        errorMessage: (err as Error).message,
        logPath,
      });
    } finally {
      this.running = false;
      this.processQueue();
    }
  }
}
