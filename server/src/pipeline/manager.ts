import { EventEmitter } from 'node:events';
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import type { ServerConfig } from '../config/types.js';
import type { TaskRecord } from '../state/types.js';
import type { ClaudeEvent, ExecutionResult, TaskInput } from '../claude/types.js';
import { StateStore } from '../state/store.js';
import { transition } from './state-machine.js';
import { buildPrompt } from '../claude/prompt-builder.js';
import { executeClaudeCode } from '../claude/executor.js';
import { pickRepo } from '../repo-picker.js';
import { writeMcpConfig, deleteMcpConfig } from '../mcp/server.js';

export class PipelineManager extends EventEmitter {
  private store: StateStore;
  private config: ServerConfig;
  private activeCount = 0;
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

  // Public methods called by MCP tool handlers
  reportProgress(key: string, message: string): void {
    this.emit('task-output', key, JSON.stringify({ type: 'progress', text: message }));
  }

  reportPr(key: string, prUrl: string, prNumber: number, branchName: string): void {
    const current = this.store.getTask(key);
    if (!current) return;
    this.store.updateTaskStatus(key, current.status, { prUrl, prNumber, branchName });
    this.store.flushSync();
  }

  completeViaAgent(key: string, summary: string): void {
    this.transitionTask(key, 'complete', {
      claudeResultText: summary,
      completedAt: new Date().toISOString(),
    });
  }

  failViaAgent(key: string, errorMessage: string): void {
    this.transitionTask(key, 'fail', { errorMessage });
  }

  private processQueue(): void {
    if (this.processing) return;
    this.processing = true;

    try {
      const limit = this.config.pipeline.concurrency;
      while (this.queue.length > 0 && (limit === 0 || this.activeCount < limit)) {
        const key = this.queue.shift();
        if (!key) break;
        const task = this.store.getTask(key);
        if (!task) continue;
        this.runTask(key);
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

    this.activeCount++;
    console.log(`\n${'='.repeat(60)}`);
    const concurrencyLabel = this.config.pipeline.concurrency === 0 ? 'unlimited' : String(this.config.pipeline.concurrency);
    console.log(`[PIPELINE] Starting task: ${task.key} — ${task.summary} (${this.activeCount}/${concurrencyLabel} active)`);
    console.log(`${'='.repeat(60)}`);
    this.transitionTask(key, 'start', { startedAt: new Date().toISOString() });

    const logsDir = this.config.logsDir ?? resolve(homedir(), '.jiranimo', 'logs');
    mkdirSync(logsDir, { recursive: true });
    const logPath = join(logsDir, `${key}-${Date.now()}.jsonl`);
    const logLines: string[] = [];
    let workDir: string | null = null;

    try {
      // 1. Discover which repo to use
      const repoPath = await pickRepo(this.config.reposRoot, task);
      console.log(`[PIPELINE] Selected repo: ${repoPath}`);

      // 2. Create isolated work dir and write .mcp.json so Claude can call back
      workDir = mkdtempSync(join(tmpdir(), `jiranimo-${key}-`));
      writeMcpConfig(workDir, this.config.web.port);

      // 3. Build prompt with all task context + git/MCP instructions
      const prompt = buildPrompt({ ...task, comments: task.comments ?? [] }, this.config, repoPath);
      console.log(`[PIPELINE] Prompt built (${prompt.length} chars)`);
      console.log(`[PIPELINE] Spawning Claude Code...`);
      console.log(`${'─'.repeat(60)}`);

      let sessionLogged = false;
      const result: ExecutionResult = await executeClaudeCode({
        prompt,
        cwd: workDir,
        config: this.config.claude,
        timeoutMs: 30 * 60 * 1000,
        onEvent: (event: ClaudeEvent) => {
          logLines.push(JSON.stringify(event.raw));
          this.emit('task-output', key, JSON.stringify(event.raw));
          if (event.text) {
            console.log(`[CLAUDE] ${event.text}`);
          } else if (event.type === 'init' && event.sessionId && !sessionLogged) {
            sessionLogged = true;
            console.log(`[CLAUDE] Session started: ${event.sessionId}`);
          } else if (event.type === 'result') {
            console.log(`[CLAUDE] Result: ${event.isError ? 'ERROR' : 'SUCCESS'} — ${event.text?.slice(0, 200) || ''}`);
          }
        },
        onOutput: (raw: string) => {
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

      // 4. Persist cost/session regardless of how the task was transitioned
      this.store.updateTaskStatus(key, this.store.getTask(key)!.status, {
        claudeSessionId: result.sessionId,
        claudeCostUsd: result.costUsd,
        logPath,
      });
      this.store.flushSync();

      // 5. Fallback: if Claude didn't call jiranimo_complete/fail via MCP, use process exit
      const currentStatus = this.store.getTask(key)!.status;
      if (currentStatus === 'in-progress') {
        if (!result.success) {
          throw new Error(result.resultText ?? 'Claude exited with failure');
        }
        this.transitionTask(key, 'complete', {
          claudeResultText: result.resultText,
          completedAt: new Date().toISOString(),
        });
      }

      console.log(`[PIPELINE] ✓ Task ${key} completed`);
      console.log(`${'='.repeat(60)}\n`);
    } catch (err) {
      writeFileSync(logPath, logLines.join('\n'), 'utf-8');
      console.error(`[PIPELINE] ✗ Task ${key} failed: ${(err as Error).message}`);
      console.log(`[PIPELINE] Logs: ${logPath}`);
      console.log(`${'='.repeat(60)}\n`);
      const currentStatus = this.store.getTask(key)?.status;
      if (currentStatus === 'in-progress') {
        this.transitionTask(key, 'fail', {
          errorMessage: (err as Error).message,
          logPath,
        });
      }
    } finally {
      if (workDir) {
        deleteMcpConfig(workDir);
        try {
          rmSync(workDir, { recursive: true, force: true });
        } catch {
          // ignore cleanup errors
        }
      }
      this.activeCount--;
      this.processQueue();
    }
  }
}
