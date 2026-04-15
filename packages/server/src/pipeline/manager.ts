import { EventEmitter } from 'node:events';
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import type { ServerConfig } from '../config/types.js';
import type { TaskRecord, TaskStatus, EffectRecord } from '../state/types.js';
import type { ClaudeEvent, ExecutionResult, TaskInput } from '../claude/types.js';
import { StateStore } from '../state/store.js';
import { transition } from './state-machine.js';
import { buildPrompt, planFilePath } from '../claude/prompt-builder.js';
import { resolveTaskMode } from '../claude/task-classifier.js';
import { executeClaudeCode } from '../claude/executor.js';
import { listRepos, pickRepo, type RepoCandidate } from '../repo-picker.js';
import { writeMcpConfig, deleteMcpConfig } from '../mcp/server.js';
import type { RepoTarget } from '../runtime-target.js';
import { createLogger, isSuppressedChildProcessLogLine, resolveLoggingConfig, type Logger } from '../logging/logger.js';
import { fetchPendingGithubReviewComments } from '../github/review-comments.js';
import { generateCompactLog } from '../claude/compact-log-generator.js';

const RESUME_GRACE_MS = 15_000;
const EFFECT_CLAIM_LEASE_MS = 30_000;
const DEFAULT_REPO_CONFIRMATION_TIMEOUT_MS = 10_000;
const TASK_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const TASK_RETENTION_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const WORKSPACE_ROOT = resolve(tmpdir(), 'jiranimo-workspaces');

type RepoConfirmationResolution =
  | {
      kind: 'confirmed';
      repoPath: string;
      repoName: string;
      source: 'user-confirmed' | 'user-changed' | 'timeout';
    }
  | { kind: 'cancelled' };

interface PendingRepoConfirmation {
  effectId: string;
  detectedRepoPath: string;
  detectedRepoName: string;
  repoOptions: RepoCandidate[];
  timeout?: ReturnType<typeof setTimeout>;
  paused: boolean;
  resolve: (resolution: RepoConfirmationResolution) => void;
}

function jiraHostFromUrl(jiraUrl: string): string {
  try {
    return new URL(jiraUrl).host;
  } catch {
    return '';
  }
}

function worktreePathForTask(taskKey: string): string {
  return resolve(tmpdir(), `jiranimo-${taskKey}`);
}

function workspacePathForTask(taskKey: string): string {
  return join(WORKSPACE_ROOT, taskKey);
}

function sha1(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}

export class PipelineManager extends EventEmitter {
  private store: StateStore;
  private config: ServerConfig;
  private repoTarget: RepoTarget;
  private activeCount = 0;
  private processing = false;
  private activeChildren = new Map<string, ChildProcess>();
  private resumeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private pendingRepoConfirmations = new Map<string, PendingRepoConfirmation>();
  private retentionSweepTimer: ReturnType<typeof setInterval> | null = null;
  private logger: Logger;
  private loggingConfig: ReturnType<typeof resolveLoggingConfig>;

  constructor(store: StateStore, config: ServerConfig, repoTarget: RepoTarget) {
    super();
    this.store = store;
    this.config = config;
    this.repoTarget = repoTarget;
    this.logger = createLogger(config, 'pipeline');
    this.loggingConfig = resolveLoggingConfig(config);
    this.clearStaleRepoConfirmationEffects();
    this.recoverOnStartup();
    this.pruneExpiredTasks();
    this.retentionSweepTimer = setInterval(() => {
      this.pruneExpiredTasks();
    }, TASK_RETENTION_SWEEP_INTERVAL_MS);
    setImmediate(() => this.processQueue());
  }

  getSyncSnapshot(jiraHost?: string): { serverEpoch: number; revision: number; tasks: TaskRecord[]; pendingEffects: EffectRecord[] } {
    const released = this.store.releaseExpiredClaims();
    if (released > 0) {
      this.emitSyncNeeded();
    }
    const meta = this.store.getMeta();
    return {
      serverEpoch: meta.serverEpoch,
      revision: meta.revision,
      tasks: this.store.getAllTasks(),
      pendingEffects: this.store.getPendingEffects(jiraHost).filter(effect => effect.status !== 'claimed' || effect.claimedBy),
    };
  }

  submitTask(input: TaskInput): TaskRecord {
    const existing = this.store.getTask(input.key);
    if (existing && (existing.status === 'queued' || existing.status === 'in-progress')) {
      throw new Error(`Task ${input.key} is already ${existing.status}`);
    }

    const isScreenshotRetry =
      existing?.status === 'completed' &&
      existing.screenshotFailed === true &&
      existing.prUrl !== undefined &&
      (input.comments ?? []).some(c => /screenshot/i.test(c.body));

    const now = new Date().toISOString();

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
      repoPath: existing?.repoPath,
      ...(isScreenshotRetry && {
        taskMode: 'screenshot' as const,
        prUrl: existing!.prUrl,
        prNumber: existing!.prNumber,
        branchName: existing!.branchName,
      }),
      githubReviewComments: [],
      pendingGithubCommentFingerprints: [],
      fixedGithubCommentFingerprints: existing?.fixedGithubCommentFingerprints ?? [],
      ...(existing?.taskMode === 'plan' && {
        previousTaskMode: existing.taskMode,
        planContent: existing.planContent,
      }),
      worktreePath: existing?.worktreePath ?? worktreePathForTask(input.key),
      workspacePath: existing?.workspacePath ?? workspacePathForTask(input.key),
      attempt: existing?.attempt ?? 0,
      recoveryState: 'none',
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    const persisted = this.store.upsertTask(task);
    this.store.enqueueTask(task.key);
    this.store.flushSync();
    const verb = task.taskMode === 'screenshot'
      ? 'screenshot'
      : task.taskMode === 'fix-comments'
        ? 'fix comments for'
        : task.taskMode === 'continue-work'
          ? 'continue work on'
          : 'implement';
    this.logger.info(`Received task to ${verb}: ${task.summary} (${task.key})`);
    this.emit('task-created', persisted);
    this.emitSyncNeeded();
    setImmediate(() => this.processQueue());
    return persisted;
  }

  async fixGithubComments(key: string): Promise<{ task: TaskRecord; pendingComments: number }> {
    const task = this.store.getTask(key);
    if (!task) throw new Error(`Task ${key} not found`);
    if (task.status !== 'completed' && task.status !== 'failed') {
      throw new Error(`Task ${key} must be completed or failed before fixing comments`);
    }
    if (!task.prUrl || !task.prNumber || !task.branchName) {
      throw new Error(`Task ${key} does not have an existing PR to update`);
    }

    const githubReviewComments = await fetchPendingGithubReviewComments(
      task.prUrl,
      task.fixedGithubCommentFingerprints ?? [],
    );

    if (githubReviewComments.length === 0) {
      throw new Error(`Task ${key} has no new GitHub review comments to fix`);
    }

    const updated = this.store.updateTaskStatus(key, 'queued', {
      taskMode: 'fix-comments',
      githubReviewComments,
      pendingGithubCommentFingerprints: githubReviewComments.map(comment => comment.fingerprint),
      errorMessage: undefined,
      recoveryState: 'none',
      resumeAfter: undefined,
      resumeMode: undefined,
      resumeReason: undefined,
      completedAt: undefined,
      activePid: undefined,
      screenshotFailed: undefined,
      screenshotFailReason: undefined,
    });
    this.store.enqueueTask(key);
    this.store.flushSync();
    this.emitSyncNeeded();
    setImmediate(() => this.processQueue());

    return { task: updated, pendingComments: githubReviewComments.length };
  }

  async continueTask(
    key: string,
    input: Partial<Pick<
      TaskRecord,
      'summary' | 'description' | 'acceptanceCriteria' | 'priority' | 'issueType' | 'labels' | 'comments'
      | 'subtasks' | 'linkedIssues' | 'attachments' | 'assignee' | 'reporter' | 'components'
      | 'parentKey' | 'jiraUrl'
    >>,
  ): Promise<{ task: TaskRecord; pendingGithubComments: number }> {
    const task = this.store.getTask(key);
    if (!task) throw new Error(`Task ${key} not found`);
    if (task.status !== 'completed' && task.status !== 'failed') {
      throw new Error(`Task ${key} must be completed or failed before continuing work`);
    }
    if (!task.repoPath || !task.branchName) {
      throw new Error(`Task ${key} does not have an existing repo and branch to continue on`);
    }

    const githubReviewComments = task.prUrl
      ? await fetchPendingGithubReviewComments(task.prUrl, task.fixedGithubCommentFingerprints ?? [])
      : [];

    const updated = this.store.updateTaskStatus(key, 'queued', {
      summary: input.summary ?? task.summary,
      description: input.description ?? task.description,
      acceptanceCriteria: input.acceptanceCriteria ?? task.acceptanceCriteria,
      priority: input.priority ?? task.priority,
      issueType: input.issueType ?? task.issueType,
      labels: input.labels ?? task.labels,
      comments: input.comments ?? task.comments ?? [],
      subtasks: input.subtasks ?? task.subtasks,
      linkedIssues: input.linkedIssues ?? task.linkedIssues,
      attachments: input.attachments ?? task.attachments,
      assignee: input.assignee ?? task.assignee,
      reporter: input.reporter ?? task.reporter,
      components: input.components ?? task.components,
      parentKey: input.parentKey ?? task.parentKey,
      jiraUrl: input.jiraUrl ?? task.jiraUrl,
      taskMode: 'continue-work',
      previousTaskMode: task.taskMode,
      githubReviewComments,
      pendingGithubCommentFingerprints: githubReviewComments.map(comment => comment.fingerprint),
      errorMessage: undefined,
      recoveryState: 'none',
      resumeAfter: undefined,
      resumeMode: undefined,
      resumeReason: undefined,
      completedAt: undefined,
      activePid: undefined,
      screenshotFailed: undefined,
      screenshotFailReason: undefined,
    });
    this.store.enqueueTask(key);
    this.store.flushSync();
    this.emitSyncNeeded();
    setImmediate(() => this.processQueue());

    return { task: updated, pendingGithubComments: githubReviewComments.length };
  }

  retryTask(key: string): TaskRecord {
    const task = this.store.getTask(key);
    if (!task) throw new Error(`Task ${key} not found`);

    const newStatus = transition(task.status, 'retry');
    const updated = this.store.updateTaskStatus(key, newStatus, {
      errorMessage: undefined,
      recoveryState: 'none',
      resumeAfter: undefined,
      resumeMode: undefined,
      resumeReason: undefined,
      completedAt: undefined,
      activePid: undefined,
    });
    this.store.enqueueTask(key);
    this.store.flushSync();
    this.emitSyncNeeded();
    setImmediate(() => this.processQueue());
    return updated;
  }

  cancelResume(key: string): TaskRecord {
    const task = this.store.getTask(key);
    if (!task) throw new Error(`Task ${key} not found`);
    if (task.status !== 'interrupted' || task.recoveryState !== 'resume-pending') {
      throw new Error(`Task ${key} is not waiting to resume`);
    }
    this.clearResumeTimer(key);
    const updated = this.store.patchTask(key, {
      recoveryState: 'resume-cancelled',
      resumeAfter: undefined,
    });
    this.store.flushSync();
    this.emitSyncNeeded();
    return updated;
  }

  resumeTask(key: string): TaskRecord {
    const task = this.store.getTask(key);
    if (!task) throw new Error(`Task ${key} not found`);
    if (task.status !== 'interrupted') {
      throw new Error(`Task ${key} is not interrupted`);
    }
    this.clearResumeTimer(key);
    const updated = this.store.patchTask(key, {
      recoveryState: 'resuming',
      resumeAfter: undefined,
      resumeMode: task.claudeSessionId ? 'claude-session' : 'fresh-recovery',
    });
    this.store.enqueueTask(key);
    this.store.flushSync();
    this.emitSyncNeeded();
    setImmediate(() => this.processQueue());
    return updated;
  }

  deleteTask(key: string): boolean {
    this.clearPendingRepoConfirmation(key, { kind: 'cancelled' });
    this.clearResumeTimer(key);
    const deleted = this.store.deleteTask(key);
    if (deleted) {
      this.store.flushSync();
      this.emitSyncNeeded();
    }
    return deleted;
  }

  claimEffect(effectId: string, clientId: string): EffectRecord {
    const effect = this.store.claimEffect(effectId, clientId, EFFECT_CLAIM_LEASE_MS);
    this.store.flushSync();
    this.emitSyncNeeded();
    return effect;
  }

  ackEffect(effectId: string): boolean {
    const acked = this.store.ackEffect(effectId);
    if (acked) {
      this.store.flushSync();
      this.emitSyncNeeded();
    }
    return acked;
  }

  reportProgress(key: string, message: string): void {
    this.emit('task-output', key, JSON.stringify({ type: 'progress', text: message }));
  }

  reportPr(key: string, prUrl: string, prNumber: number, branchName: string): void {
    const current = this.store.getTask(key);
    if (!current) return;
    this.store.patchTask(key, { prUrl, prNumber, branchName });
    this.store.flushSync();
    this.emitSyncNeeded();
  }

  reportScreenshotFailed(key: string, reason: string): void {
    const current = this.store.getTask(key);
    if (!current) return;
    this.store.patchTask(key, { screenshotFailed: true, screenshotFailReason: reason });
    this.store.flushSync();
    this.emitSyncNeeded();
  }

  completeViaAgent(key: string, summary: string): void {
    this.transitionTask(key, 'complete', {
      claudeResultText: summary,
      completedAt: new Date().toISOString(),
      activePid: undefined,
      recoveryState: 'none',
      resumeAfter: undefined,
    });
  }

  failViaAgent(key: string, errorMessage: string): void {
    this.transitionTask(key, 'fail', {
      errorMessage,
      activePid: undefined,
      recoveryState: 'none',
      resumeAfter: undefined,
    });
  }

  shutdown(): void {
    if (this.retentionSweepTimer) {
      clearInterval(this.retentionSweepTimer);
      this.retentionSweepTimer = null;
    }

    for (const [key, pending] of this.pendingRepoConfirmations.entries()) {
      clearTimeout(pending.timeout);
      this.pendingRepoConfirmations.delete(key);
    }

    for (const key of this.resumeTimers.keys()) {
      this.clearResumeTimer(key);
    }

    for (const [key, child] of this.activeChildren.entries()) {
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
      const task = this.store.getTask(key);
      if (task?.status === 'in-progress') {
        this.transitionTask(key, 'interrupt', {
          recoveryState: 'resume-pending',
          resumeAfter: new Date(Date.now() + RESUME_GRACE_MS).toISOString(),
          resumeReason: 'server_shutdown',
          resumeMode: task.claudeSessionId ? 'claude-session' : 'fresh-recovery',
          activePid: undefined,
        });
      }
    }

    this.store.flushSync();
  }

  private recoverOnStartup(): void {
    for (const key of [...this.store.getQueue()]) {
      const task = this.store.getTask(key);
      if (!task || task.status !== 'queued') {
        this.store.removeFromQueue(key);
      }
    }

    for (const task of this.store.getTasksByStatus('queued')) {
      if (!this.store.getQueue().includes(task.key)) {
        this.store.enqueueTask(task.key);
      }
    }

    const interruptedAt = new Date(Date.now() + RESUME_GRACE_MS).toISOString();
    for (const task of this.store.getTasksByStatus('in-progress')) {
      this.bestEffortStopPid(task.activePid);
      this.transitionTask(task.key, 'interrupt', {
        recoveryState: 'resume-pending',
        resumeAfter: interruptedAt,
        resumeReason: 'server_restart',
        resumeMode: task.claudeSessionId ? 'claude-session' : 'fresh-recovery',
        activePid: undefined,
      });
    }

    for (const task of this.store.getTasksByStatus('interrupted')) {
      if (task.recoveryState === 'resume-pending' || task.recoveryState === 'resuming') {
        const updated = this.store.patchTask(task.key, {
          recoveryState: 'resume-pending',
          resumeAfter: interruptedAt,
          resumeMode: task.claudeSessionId ? 'claude-session' : 'fresh-recovery',
        });
        this.scheduleResume(updated);
      }
    }
  }

  private clearStaleRepoConfirmationEffects(): void {
    let changed = false;
    for (const effect of this.store.getPendingEffects()) {
      if (effect.type !== 'repo-confirmation') continue;
      changed = this.store.ackEffect(effect.id) || changed;
    }
    if (changed) {
      this.store.flushSync();
    }
  }

  private scheduleResume(task: TaskRecord): void {
    if (task.status !== 'interrupted' || task.recoveryState !== 'resume-pending' || !task.resumeAfter) {
      return;
    }
    this.clearResumeTimer(task.key);
    const delay = Math.max(0, new Date(task.resumeAfter).getTime() - Date.now());
    const timer = setTimeout(() => {
      this.resumeTimers.delete(task.key);
      const current = this.store.getTask(task.key);
      if (!current || current.status !== 'interrupted' || current.recoveryState !== 'resume-pending') {
        return;
      }
      this.resumeTask(task.key);
    }, delay);
    this.resumeTimers.set(task.key, timer);
  }

  private clearResumeTimer(key: string): void {
    const timer = this.resumeTimers.get(key);
    if (!timer) return;
    clearTimeout(timer);
    this.resumeTimers.delete(key);
  }

  private pruneExpiredTasks(now = new Date()): string[] {
    const cutoff = new Date(now.getTime() - TASK_RETENTION_MS);
    const deletedTaskKeys = this.store.pruneTasksOlderThan(cutoff);
    if (deletedTaskKeys.length > 0) {
      this.store.flushSync();
      this.logger.info('Pruned expired tasks from local state', { deletedTaskKeys, cutoff: cutoff.toISOString() });
      this.emitSyncNeeded();
    }
    return deletedTaskKeys;
  }

  private clearPendingRepoConfirmation(key: string, resolution?: RepoConfirmationResolution): void {
    const pending = this.pendingRepoConfirmations.get(key);
    if (!pending) return;

    if (pending.timeout) {
      clearTimeout(pending.timeout);
    }
    this.pendingRepoConfirmations.delete(key);

    const acked = this.store.ackEffect(pending.effectId);
    if (acked) {
      this.store.flushSync();
      this.emitSyncNeeded();
    }

    if (resolution) {
      pending.resolve(resolution);
    }
  }

  private getRepoConfirmationTimeoutMs(): number {
    return this.config.pipeline.repoConfirmationTimeoutMs ?? DEFAULT_REPO_CONFIRMATION_TIMEOUT_MS;
  }

  private async waitForRepoConfirmation(
    task: TaskRecord,
    detectedRepoPath: string,
    repoOptions: RepoCandidate[],
    taskLogger: Logger,
  ): Promise<RepoConfirmationResolution> {
    const timeoutMs = this.getRepoConfirmationTimeoutMs();
    const matchedRepo = repoOptions.find(candidate => candidate.path === detectedRepoPath);
    const detectedRepoName = matchedRepo?.name ?? detectedRepoPath.split('/').at(-1) ?? detectedRepoPath;
    const effectId = `${task.key}:repo-confirmation:${task.runId ?? task.attempt ?? Date.now()}`;
    const expiresAt = new Date(Date.now() + timeoutMs).toISOString();

    if (timeoutMs <= 0) {
      return {
        kind: 'confirmed',
        repoPath: detectedRepoPath,
        repoName: detectedRepoName,
        source: 'timeout',
      };
    }

    this.clearPendingRepoConfirmation(task.key);

    this.store.createEffect({
      id: effectId,
      type: 'repo-confirmation',
      taskKey: task.key,
      jiraHost: jiraHostFromUrl(task.jiraUrl),
      payload: {
        issueKey: task.key,
        summary: task.summary,
        detectedRepoName,
        detectedRepoPath,
        repoOptions: repoOptions.map(candidate => ({
          name: candidate.name,
          hint: candidate.hint,
        })),
        expiresAt,
        timeoutMs,
        paused: false,
      },
    });
    this.store.flushSync();
    this.emitSyncNeeded();

    taskLogger.info(`Awaiting repo confirmation for ${detectedRepoName} (${timeoutMs}ms timeout)`);

    return await new Promise<RepoConfirmationResolution>((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingRepoConfirmations.delete(task.key);
        const acked = this.store.ackEffect(effectId);
        if (acked) {
          this.store.flushSync();
          this.emitSyncNeeded();
        }
        taskLogger.info(`Repo confirmation timed out; continuing with ${detectedRepoName}`);
        resolve({
          kind: 'confirmed',
          repoPath: detectedRepoPath,
          repoName: detectedRepoName,
          source: 'timeout',
        });
      }, timeoutMs);

      this.pendingRepoConfirmations.set(task.key, {
        effectId,
        detectedRepoPath,
        detectedRepoName,
        repoOptions,
        timeout,
        paused: false,
        resolve,
      });
    });
  }

  resolveRepoConfirmation(
    key: string,
    input: { action: 'confirm' | 'change' | 'cancel' | 'pause'; repoName?: string },
  ): { task?: TaskRecord; status: 'confirmed' | 'changed' | 'cancelled' | 'paused'; repoName?: string; repoPath?: string } {
    const pending = this.pendingRepoConfirmations.get(key);
    if (!pending) {
      throw new Error(`Task ${key} is not waiting for repo confirmation`);
    }

    if (input.action === 'pause') {
      if (!pending.paused) {
        if (pending.timeout) {
          clearTimeout(pending.timeout);
          pending.timeout = undefined;
        }
        pending.paused = true;
        const currentPayload = this.store.getEffect(pending.effectId)?.payload ?? {};
        this.store.patchEffect(pending.effectId, {
          payload: {
            ...currentPayload,
            paused: true,
            expiresAt: undefined,
          },
        });
        this.store.flushSync();
        this.emitSyncNeeded();
      }
      return {
        task: this.store.getTask(key),
        status: 'paused',
        repoName: pending.detectedRepoName,
        repoPath: pending.detectedRepoPath,
      };
    }

    if (input.action === 'cancel') {
      this.clearPendingRepoConfirmation(key, { kind: 'cancelled' });
      this.deleteTask(key);
      return { status: 'cancelled' };
    }

    if (input.action === 'change') {
      if (!input.repoName) {
        throw new Error('repoName is required when choosing a different repo');
      }
      const matched = pending.repoOptions.find(candidate => candidate.name === input.repoName);
      if (!matched) {
        throw new Error(`Unknown repository "${input.repoName}"`);
      }
      this.clearPendingRepoConfirmation(key, {
        kind: 'confirmed',
        repoPath: matched.path,
        repoName: matched.name,
        source: 'user-changed',
      });
      return {
        task: this.store.getTask(key),
        status: 'changed',
        repoName: matched.name,
        repoPath: matched.path,
      };
    }

    this.clearPendingRepoConfirmation(key, {
      kind: 'confirmed',
      repoPath: pending.detectedRepoPath,
      repoName: pending.detectedRepoName,
      source: 'user-confirmed',
    });
    return {
      task: this.store.getTask(key),
      status: 'confirmed',
      repoName: pending.detectedRepoName,
      repoPath: pending.detectedRepoPath,
    };
  }

  private emitSyncNeeded(): void {
    const meta = this.store.getMeta();
    this.emit('sync-needed', meta.serverEpoch, meta.revision);
  }

  private processQueue(): void {
    if (this.processing) return;
    this.processing = true;

    try {
      const limit = this.config.pipeline.concurrency;
      while (this.store.getQueue().length > 0 && (limit === 0 || this.activeCount < limit)) {
        const key = this.store.dequeueTask();
        if (!key) break;
        const task = this.store.getTask(key);
        if (!task) continue;
        this.runTask(key).catch(err => {
          this.logger.error('Unhandled runTask error', { error: (err as Error).message, taskKey: key });
        });
      }
    } finally {
      this.processing = false;
    }
  }

  private transitionTask(key: string, action: 'start' | 'complete' | 'fail' | 'interrupt', extra?: Partial<TaskRecord>): TaskRecord | undefined {
    const task = this.store.getTask(key);
    if (!task) return undefined;
    const oldStatus = task.status;
    const newStatus = transition(task.status, action);
    const nextExtra: Partial<TaskRecord> = { ...extra };

    if (action === 'complete' && (task.pendingGithubCommentFingerprints?.length ?? 0) > 0) {
      nextExtra.fixedGithubCommentFingerprints = [...new Set([
        ...(task.fixedGithubCommentFingerprints ?? []),
        ...(task.pendingGithubCommentFingerprints ?? []),
      ])];
      nextExtra.pendingGithubCommentFingerprints = [];
      nextExtra.githubReviewComments = [];
    }

    if (action === 'fail' && (task.pendingGithubCommentFingerprints?.length ?? 0) > 0) {
      nextExtra.pendingGithubCommentFingerprints = [];
    }

    const updated = this.store.updateTaskStatus(key, newStatus, nextExtra);

    if (newStatus === 'in-progress') {
      this.createPipelineStatusEffect(updated, 'in-progress');
    }

    if (newStatus === 'completed') {
      this.createPipelineStatusEffect(updated, 'completed');
      if (updated.taskMode === 'plan') {
        if (updated.planContent) {
          this.createPlanCommentEffect(updated);
        }
      } else {
        this.createCompletionCommentEffect(updated);
      }
    }

    if (newStatus === 'interrupted' && updated.recoveryState === 'resume-pending') {
      this.scheduleResume(updated);
    }

    this.store.flushSync();
    this.emit('task-status-changed', updated, oldStatus);
    if (newStatus === 'completed' || newStatus === 'failed') {
      this.emit('task-completed', updated);
    }
    this.emitSyncNeeded();
    return updated;
  }

  private createPipelineStatusEffect(task: TaskRecord, pipelineStatus: 'in-progress' | 'completed'): void {
    this.store.createEffect({
      id: `${task.key}:status:${pipelineStatus}:${task.runId ?? task.attempt ?? 0}`,
      type: 'pipeline-status-sync',
      taskKey: task.key,
      jiraHost: jiraHostFromUrl(task.jiraUrl),
      payload: {
        issueKey: task.key,
        pipelineStatus,
      },
    });
  }

  private createCompletionCommentEffect(task: TaskRecord): void {
    const body = this.buildCompletionComment(task);
    this.store.createEffect({
      id: `${task.key}:completion-comment:${task.runId ?? task.attempt ?? 0}`,
      type: 'completion-comment',
      taskKey: task.key,
      jiraHost: jiraHostFromUrl(task.jiraUrl),
      payload: {
        issueKey: task.key,
        body,
        hash: sha1(body),
      },
    });
  }

  private createPlanCommentEffect(task: TaskRecord): void {
    const body = task.planContent ?? '';
    this.store.createEffect({
      id: `${task.key}:plan-comment:${task.runId ?? task.attempt ?? 0}`,
      type: 'plan-comment',
      taskKey: task.key,
      jiraHost: jiraHostFromUrl(task.jiraUrl),
      payload: {
        issueKey: task.key,
        body,
        hash: sha1(body),
      },
    });
  }

  private ensurePlanCommentEffect(task: TaskRecord): void {
    const effectId = `${task.key}:plan-comment:${task.runId ?? task.attempt ?? 0}`;
    if (!task.planContent || this.store.getEffect(effectId)) {
      return;
    }

    this.createPlanCommentEffect(task);
    this.store.flushSync();
    this.emitSyncNeeded();
  }

  private buildCompletionComment(task: TaskRecord): string {
    const parts: string[] = [];
    if (task.prUrl) {
      parts.push(task.taskMode === 'fix-comments' || task.taskMode === 'screenshot'
        ? `Updated PR: ${task.prUrl}`
        : `Draft PR: ${task.prUrl}`);
    }

    if (task.claudeResultText) {
      const text = task.claudeResultText.trim();
      if (text.length > 10 && text.length < 2000) {
        parts.push(text);
      }
    }

    if (typeof task.claudeCostUsd === 'number') {
      parts.push(`Cost: $${task.claudeCostUsd.toFixed(2)}`);
    }

    if (task.screenshotFailed) {
      const reason = task.screenshotFailReason ? ` Reason: ${task.screenshotFailReason}` : '';
      parts.push(
        `⚠️ I wasn't able to take a screenshot of the feature.${reason}\n\n` +
        `To add one: reply to this comment with instructions on how to screenshot this feature ` +
        `(e.g. which URL to visit, how to start the dev server, what to click), ` +
        `then click the AI button on this card again.`,
      );
    }

    if (parts.length === 0) {
      parts.push('Done');
    }

    parts.push('\n— Jiranimo + Claude Code');
    return parts.join('\n\n');
  }

  private bestEffortStopPid(pid?: number): void {
    if (!pid) return;
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // ignore
    }
  }

  private cleanupWorkspace(task: TaskRecord): void {
    if (!task.workspacePath) return;
    deleteMcpConfig(task.workspacePath);
    try {
      rmSync(task.workspacePath, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }

  private async runTask(key: string): Promise<void> {
    const task = this.store.getTask(key);
    if (!task) return;

    const wasInterrupted = task.status === 'interrupted';
    const resumeMode = wasInterrupted
      ? (task.claudeSessionId ? 'claude-session' as const : 'fresh-recovery' as const)
      : undefined;
    const workspacePath = task.workspacePath ?? workspacePathForTask(key);
    const worktreePath = task.worktreePath ?? worktreePathForTask(key);

    mkdirSync(workspacePath, { recursive: true });

    this.activeCount++;
    const taskLogger = this.logger.child(key);
    const resumeLabel = wasInterrupted ? ' (resuming previous run)' : '';
    taskLogger.info(`Starting task: ${task.summary}${resumeLabel}`);
    taskLogger.info('Preparing workspace');

    const started = this.transitionTask(key, 'start', {
      startedAt: new Date().toISOString(),
      attempt: (task.attempt ?? 0) + 1,
      runId: randomUUID(),
      workspacePath,
      worktreePath,
      recoveryState: wasInterrupted ? 'resuming' : 'none',
      resumeAfter: undefined,
      resumeMode,
      activePid: undefined,
      errorMessage: undefined,
    });
    if (!started) {
      this.activeCount--;
      return;
    }

    const logsDir = this.config.logsDir ?? resolve(homedir(), '.jiranimo', 'logs');
    mkdirSync(logsDir, { recursive: true });
    const logPath = join(logsDir, `${key}-${Date.now()}.jsonl`);
    const logLines: string[] = [];
    let capturedSessionId: string | undefined;

    try {
      const needsRepoPick = !started.repoPath && this.repoTarget.kind !== 'single-repo';
      const needsTaskMode = started.taskMode == null;
      let repoDecisionSource = started.repoPath
        ? 'task state'
        : this.repoTarget.kind === 'single-repo'
          ? 'single-repo config'
          : 'repo picker';
      const taskModeDecisionSource = started.taskMode != null ? 'task state' : 'task classifier';
      const repoOptions = this.repoTarget.kind === 'repo-root'
        ? listRepos(this.repoTarget.reposRoot)
        : [{
            name: basename(this.repoTarget.repoPath),
            hint: basename(this.repoTarget.repoPath),
            path: this.repoTarget.repoPath,
          }];

      if (needsRepoPick) taskLogger.info('Choosing repository to operate on');
      if (needsTaskMode) taskLogger.info('Determining task mode');

      const [detectedRepoPath, taskMode] = await Promise.all([
        started.repoPath
          ? Promise.resolve(started.repoPath)
          : (this.repoTarget.kind === 'single-repo'
            ? Promise.resolve(this.repoTarget.repoPath)
            : pickRepo(this.repoTarget.reposRoot, started, this.config.claude)),
        started.taskMode != null
          ? Promise.resolve(started.taskMode)
          : resolveTaskMode({ ...started, comments: started.comments ?? [] }, this.config.claude),
      ]);

      let repoPath = detectedRepoPath;

      if (!started.repoPath && repoOptions.length > 0) {
        const confirmation = await this.waitForRepoConfirmation(started, detectedRepoPath, repoOptions, taskLogger);
        if (confirmation.kind === 'cancelled') {
          taskLogger.info('Task cancelled during repo confirmation');
          return;
        }
        repoPath = confirmation.repoPath;
        if (this.repoTarget.kind === 'single-repo') {
          repoDecisionSource = confirmation.source === 'user-confirmed'
            ? 'single-repo config (user confirmed)'
            : 'single-repo config (auto-confirmed after timeout)';
        } else {
          repoDecisionSource = confirmation.source === 'user-changed'
            ? 'repo confirmation override'
            : confirmation.source === 'user-confirmed'
              ? 'repo picker (user confirmed)'
              : 'repo picker (auto-confirmed after timeout)';
        }
      }

      taskLogger.info(`Repository selected: ${repoPath} (source: ${repoDecisionSource})`);
      taskLogger.info(`Task mode selected: ${taskMode} (source: ${taskModeDecisionSource})`);

      this.store.patchTask(key, { repoPath, taskMode, logPath });
      this.store.flushSync();
      this.emitSyncNeeded();

      writeMcpConfig(workspacePath, this.config.web.port);

      const existingPrContext = (taskMode === 'screenshot' || taskMode === 'fix-comments') && started.prUrl && started.branchName
        ? { prUrl: started.prUrl, prNumber: started.prNumber!, branchName: started.branchName }
        : undefined;
      const prompt = buildPrompt(
        { ...started, comments: started.comments ?? [] },
        this.config,
        repoPath,
        taskMode,
        existingPrContext,
        wasInterrupted
          ? {
              wasInterrupted: true,
              resumeMode: resumeMode ?? 'fresh-recovery',
              worktreePath,
              workspacePath,
              branchName: started.branchName,
              prUrl: started.prUrl,
              logPath,
            }
          : undefined,
      );

      taskLogger.info('Building Claude prompt');
      taskLogger.info(
        wasInterrupted
          ? (started.claudeSessionId ? `Launching Claude Code with session resume (${started.claudeSessionId})` : 'Launching Claude Code in recovery mode')
          : 'Launching Claude Code',
      );

      let sessionLogged = false;
      const result: ExecutionResult = await executeClaudeCode({
        prompt,
        cwd: workspacePath,
        config: this.config.claude,
        timeoutMs: 30 * 60 * 1000,
        resumeSessionId: wasInterrupted ? started.claudeSessionId : undefined,
        onSpawn: (child) => {
          this.activeChildren.set(key, child);
          this.store.patchTask(key, { activePid: child.pid });
          this.store.flushSync();
          this.emitSyncNeeded();
        },
        onEvent: (event: ClaudeEvent) => {
          logLines.push(JSON.stringify(event.raw));
          this.emit('task-output', key, JSON.stringify(event.raw));
          if (event.type === 'init' && event.sessionId && !sessionLogged) {
            sessionLogged = true;
            capturedSessionId = event.sessionId;
            taskLogger.info(`Claude session ready: ${event.sessionId}`);
          } else if (event.type === 'result') {
            const costLabel = typeof event.costUsd === 'number' ? ` ($${event.costUsd.toFixed(2)})` : '';
            if (event.isError) {
              const suffix = event.text ? `: ${truncateForLog(event.text, 200)}` : '';
              taskLogger.info(`Claude finished with error${costLabel}${suffix}`);
            } else {
              taskLogger.info(`Claude finished successfully${costLabel}`);
            }
          } else if (event.type === 'message') {
            const progressText = normalizeClaudeProgressText(event.text);
            if (progressText) {
              taskLogger.info(`Claude progress: ${truncateForLog(progressText, 300)}`);
            }
            if (event.toolUse) {
              for (const tool of event.toolUse) {
                taskLogger.info(`Claude action: ${summarizeClaudeAction(tool.name, tool.input)}`);
              }
            }
          }
        },
        onOutput: (raw: string) => {
          for (const line of raw.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('{')) {
              continue;
            }
            const suppressed = isSuppressedChildProcessLogLine(trimmed);
            logLines.push(JSON.stringify({ type: 'raw-output', text: trimmed, suppressed }));
            if (suppressed) continue;
            if (this.loggingConfig.logClaudeRawOutput || taskLogger.isConsoleLevelEnabled('debug')) {
              taskLogger.debug('Claude raw output', { text: trimmed });
            }
          }
        },
      });

      const logContent = logLines.join('\n');
      writeFileSync(logPath, logContent, 'utf-8');

      let compactLog: string | undefined;
      taskLogger.info('Generating compact Claude summary');
      try {
        compactLog = await generateCompactLog(
          logContent,
          this.store.getTask(key)?.summary ?? key,
          this.config.claude,
          workspacePath,
        );
      } catch {
        // compact log generation is best-effort; don't fail the task
      }

      const existingTask = this.store.getTask(key);
      const accumulatedCostUsd = typeof result.costUsd === 'number'
        ? (existingTask?.claudeCostUsd ?? 0) + result.costUsd
        : existingTask?.claudeCostUsd;

      this.store.patchTask(key, {
        claudeSessionId: result.sessionId ?? existingTask?.claudeSessionId,
        claudeCostUsd: accumulatedCostUsd,
        logPath,
        compactLog,
        activePid: undefined,
      });
      this.store.flushSync();
      this.emitSyncNeeded();

      if (taskMode === 'plan') {
        const planFile = planFilePath(key);
        if (existsSync(planFile)) {
          const planContent = readFileSync(planFile, 'utf-8');
          try { rmSync(planFile); } catch { /* ignore */ }
          this.store.patchTask(key, { planContent });
          this.store.flushSync();
          this.emit('task-plan-ready', key, planContent);
          this.emitSyncNeeded();

          const completedTask = this.store.getTask(key);
          if (completedTask?.status === 'completed' && completedTask.taskMode === 'plan') {
            this.ensurePlanCommentEffect(completedTask);
          }
        }
      }

      const currentStatus = this.store.getTask(key)?.status;
      if (currentStatus === 'in-progress') {
        if (!result.success) {
          throw new Error(result.resultText || 'Claude exited with failure');
        }
        this.transitionTask(key, 'complete', {
          claudeResultText: result.resultText,
          completedAt: new Date().toISOString(),
          logPath,
          activePid: undefined,
        });
      }

      taskLogger.info('Task completed');
    } catch (err) {
      const logContent = logLines.join('\n');
      writeFileSync(logPath, logContent, 'utf-8');
      taskLogger.error(`Task failed: ${(err as Error).message}`);

      let compactLog: string | undefined;
      taskLogger.info('Generating compact Claude summary from failed run');
      try {
        compactLog = await generateCompactLog(
          logContent,
          this.store.getTask(key)?.summary ?? key,
          this.config.claude,
          workspacePath,
        );
      } catch {
        // compact log generation is best-effort
      }

      const currentStatus = this.store.getTask(key)?.status;
      if (currentStatus === 'in-progress') {
        this.transitionTask(key, 'fail', {
          errorMessage: (err as Error).message,
          logPath,
          compactLog,
          activePid: undefined,
        });
      }
    } finally {
      this.activeChildren.delete(key);
      this.activeCount--;
      const current = this.store.getTask(key);
      if (current && (current.status === 'completed' || current.status === 'failed')) {
        this.cleanupWorkspace(current);
      }
      this.processQueue();
    }
  }
}

function normalizeClaudeProgressText(text?: string): string | undefined {
  if (!text) return undefined;
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized || undefined;
}

function truncateForLog(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

function summarizeClaudeAction(toolName: string, input: Record<string, unknown>): string {
  const filePath = firstNonEmptyString(input.file_path, input.path);
  const command = firstNonEmptyString(input.command);
  const pattern = firstNonEmptyString(input.pattern);
  const query = firstNonEmptyString(input.query);

  switch (toolName) {
    case 'Read':
      return filePath ? `reading ${filePath}` : 'reading a file';
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
      return filePath ? `editing ${filePath}` : 'editing files';
    case 'Bash':
      return command ? `running ${truncateForLog(command, 80)}` : 'running a shell command';
    case 'Grep':
      return pattern ? `searching for ${truncateForLog(pattern, 80)}` : 'searching the codebase';
    case 'Glob':
      return query ? `listing files matching ${truncateForLog(query, 80)}` : 'listing files';
    default: {
      const detail = filePath ?? command ?? pattern ?? query;
      return detail ? `${toolName} (${truncateForLog(detail, 80)})` : toolName;
    }
  }
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}
