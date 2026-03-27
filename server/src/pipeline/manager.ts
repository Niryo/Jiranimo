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
import { commitAndPush } from '../git/branch.js';
import { createWorktree, removeWorktree, findGitRepo } from '../git/worktree.js';
import { branchName } from '../git/branch.js';

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
      // Preserve branch name from previous attempt so we continue on the same branch
      branchName: existing?.branchName,
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
      while (this.queue.length > 0 && this.activeCount < this.config.pipeline.concurrency) {
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
    const repoRoot = this.config.repoPath;

    this.activeCount++;
    console.log(`\n${'='.repeat(60)}`);
    console.log(`[PIPELINE] Starting task: ${task.key} — ${task.summary} (${this.activeCount}/${this.config.pipeline.concurrency} active)`);
    console.log(`[PIPELINE] Repo root: ${repoRoot}`);
    console.log(`${'='.repeat(60)}`);
    this.transitionTask(key, 'start', { startedAt: new Date().toISOString() });

    const logsDir = this.config.logsDir ?? resolve(homedir(), '.jiranimo', 'logs');
    mkdirSync(logsDir, { recursive: true });
    const logPath = join(logsDir, `${key}-${Date.now()}.jsonl`);
    const logLines: string[] = [];
    let worktreePath: string | null = null;
    let gitRepoPath: string | null = null;

    try {
      // 1. Find the git repo inside repoRoot
      gitRepoPath = await findGitRepo(repoRoot);
      if (!gitRepoPath) {
        throw new Error(`No git repository found in ${repoRoot}`);
      }
      console.log(`[PIPELINE] Git repo: ${gitRepoPath}`);

      // 2. Create a worktree for this task (isolated from user's working directory)
      // Reuse existing branch name if this is a re-implementation, otherwise generate a new one
      const branch = task.branchName ?? branchName(this.config.git.branchPrefix, task.key, task.summary);
      worktreePath = await createWorktree(
        gitRepoPath,
        task.key,
        branch,
        this.config.git.defaultBaseBranch,
        this.config.git.pushRemote,
      );
      console.log(`[PIPELINE] Worktree created: ${worktreePath}`);
      console.log(`[PIPELINE] Branch: ${branch}`);
      this.store.updateTaskStatus(key, 'in-progress', { branchName: branch });

      // 3. Build prompt and run Claude in the worktree
      const prompt = buildPrompt(task, this.config.claude.appendSystemPrompt);

      console.log(`[PIPELINE] Prompt built (${prompt.length} chars)`);
      console.log(`[PIPELINE] Spawning Claude Code in worktree...`);
      console.log(`${'─'.repeat(60)}`);

      const result: ExecutionResult = await executeClaudeCode({
        prompt,
        cwd: worktreePath,
        config: this.config.claude,
        timeoutMs: 30 * 60 * 1000,
        onEvent: (event: ClaudeEvent) => {
          logLines.push(JSON.stringify(event.raw));
          this.emit('task-output', key, JSON.stringify(event.raw));
          if (event.text) {
            console.log(`[CLAUDE] ${event.text}`);
          } else if (event.type === 'init' && event.sessionId) {
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

      if (!result.success) {
        throw new Error(result.resultText);
      }

      // 4. Commit and push from the worktree
      await commitAndPush(
        worktreePath,
        branch,
        task.key,
        task.summary,
        task.issueType,
        task.jiraUrl,
        this.config.git.pushRemote,
      );
      console.log(`[PIPELINE] Changes committed and pushed`);

      this.transitionTask(key, 'complete', {
        claudeSessionId: result.sessionId,
        claudeCostUsd: result.costUsd,
        claudeResultText: result.resultText,
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
      // 5. Clean up worktree
      if (worktreePath && gitRepoPath) {
        try {
          await removeWorktree(gitRepoPath, worktreePath);
          console.log(`[PIPELINE] Worktree removed: ${worktreePath}`);
        } catch (err) {
          console.warn(`[PIPELINE] Failed to remove worktree: ${(err as Error).message}`);
        }
      }
      this.activeCount--;
      this.processQueue();
    }
  }
}
