import { EventEmitter } from 'node:events';
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import type { ServerConfig } from '../config/types.js';
import type { TaskRecord, TaskStatus, EffectRecord, JiraBoardType } from '../state/types.js';
import type { ClaudeEvent, ExecutionResult, TaskInput } from '../claude/types.js';
import { StateStore, boardTrackingKey } from '../state/store.js';
import { transition } from './state-machine.js';
import { buildPrompt, planFilePath } from '../claude/prompt-builder.js';
import { resolveTaskMode } from '../claude/task-classifier.js';
import { executeClaudeCode } from '../claude/executor.js';
import { pickRepo } from '../repo-picker.js';
import { writeMcpConfig, deleteMcpConfig } from '../mcp/server.js';
import type { RepoTarget } from '../runtime-target.js';
import { createLogger, isSuppressedChildProcessLogLine, resolveLoggingConfig, type Logger } from '../logging/logger.js';
import { fetchPendingGithubReviewComments } from '../github/review-comments.js';
import { generateCompactLog } from '../claude/compact-log-generator.js';

const RESUME_GRACE_MS = 15_000;
const EFFECT_CLAIM_LEASE_MS = 30_000;
const WORKSPACE_ROOT = resolve(tmpdir(), 'jiranimo-workspaces');

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
  private logger: Logger;
  private loggingConfig: ReturnType<typeof resolveLoggingConfig>;

  constructor(store: StateStore, config: ServerConfig, repoTarget: RepoTarget) {
    super();
    this.store = store;
    this.config = config;
    this.repoTarget = repoTarget;
    this.logger = createLogger(config, 'pipeline');
    this.loggingConfig = resolveLoggingConfig(config);
    this.recoverOnStartup();
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
    const jiraHost = jiraHostFromUrl(input.jiraUrl);
    const initialTrackedBoards = [...new Set([
      ...(existing?.trackedBoards ?? []),
      boardTrackingKey(jiraHost, input.boardId),
    ])];

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
      trackedBoards: initialTrackedBoards,
      submittedFromBoardId: input.boardId,
      lastSeenOnBoardAt: now,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    const persisted = this.store.upsertTask(task);
    this.store.enqueueTask(task.key);
    this.store.flushSync();
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

  syncBoardPresence(input: {
    boardId: string;
    jiraHost: string;
    boardType: JiraBoardType;
    projectKey?: string;
    issueKeys: string[];
  }): {
    boardKey: string;
    syncedAt: string;
    deletedTaskKeys: string[];
    updatedTaskKeys: string[];
  } {
    const result = this.store.reconcileBoardPresence(input);
    this.store.flushSync();
    this.emitSyncNeeded();
    return result;
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
    const concurrencyLabel = this.config.pipeline.concurrency === 0 ? 'unlimited' : String(this.config.pipeline.concurrency);
    const taskLogger = this.logger.child(key);
    taskLogger.info('Task started', {
      summary: task.summary,
      activeCount: this.activeCount,
      concurrency: concurrencyLabel,
      resumed: wasInterrupted,
    });

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
      const [repoPath, taskMode] = await Promise.all([
        started.repoPath
          ? Promise.resolve(started.repoPath)
          : (this.repoTarget.kind === 'single-repo'
            ? Promise.resolve(this.repoTarget.repoPath)
            : pickRepo(this.repoTarget.reposRoot, started)),
        started.taskMode != null
          ? Promise.resolve(started.taskMode)
          : resolveTaskMode({ ...started, comments: started.comments ?? [] }),
      ]);

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
            taskLogger.info('Claude session started', { sessionId: event.sessionId });
          } else if (event.type === 'result') {
            taskLogger.info('Claude result received', {
              success: !event.isError,
              summary: event.text?.slice(0, 200) || '',
            });
          } else if (event.text) {
            taskLogger.debug('Claude message', { text: event.text });
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

      writeFileSync(logPath, logLines.join('\n'), 'utf-8');

      let compactLog: string | undefined;
      const compactSessionId = result.sessionId ?? capturedSessionId;
      if (compactSessionId) {
        try {
          compactLog = await generateCompactLog(compactSessionId, this.config.claude, workspacePath);
        } catch {
          // compact log generation is best-effort; don't fail the task
        }
      }

      this.store.patchTask(key, {
        claudeSessionId: result.sessionId ?? this.store.getTask(key)?.claudeSessionId,
        claudeCostUsd: result.costUsd,
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

      taskLogger.info('Task completed', { logPath });
    } catch (err) {
      writeFileSync(logPath, logLines.join('\n'), 'utf-8');
      taskLogger.error('Task failed', { error: (err as Error).message, logPath });

      let compactLog: string | undefined;
      if (capturedSessionId) {
        try {
          compactLog = await generateCompactLog(capturedSessionId, this.config.claude, workspacePath);
        } catch {
          // compact log generation is best-effort
        }
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
