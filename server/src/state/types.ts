export type TaskStatus = 'queued' | 'in-progress' | 'interrupted' | 'completed' | 'failed';
export type TaskMode = 'plan' | 'implement' | 'screenshot';
export type RecoveryState = 'none' | 'resume-pending' | 'resume-cancelled' | 'resuming';
export type ResumeMode = 'claude-session' | 'fresh-recovery';
export type EffectType = 'pipeline-status-sync' | 'completion-comment' | 'plan-comment';
export type EffectStatus = 'pending' | 'claimed';
export type JiraBoardType = 'scrum' | 'kanban';

export interface EffectRecord {
  id: string;
  type: EffectType;
  taskKey: string;
  jiraHost: string;
  payload: Record<string, unknown>;
  status: EffectStatus;
  claimedBy?: string;
  claimExpiresAt?: string;
  claimEpoch?: number;
  createdAt: string;
  updatedAt: string;
}

export interface TaskRecord {
  key: string;
  summary: string;
  description: string;
  acceptanceCriteria?: string;
  priority: string;
  issueType: string;
  labels: string[];
  comments?: Array<{ author: string; body: string; created?: string }>;
  subtasks?: Array<{ key: string; summary: string; status: string }>;
  linkedIssues?: Array<{ type: string; key: string; summary: string; status: string }>;
  attachments?: Array<{ filename: string; mimeType: string; url: string }>;
  assignee?: string;
  reporter?: string;
  components?: string[];
  parentKey?: string;
  jiraUrl: string;
  status: TaskStatus;
  branchName?: string;
  prUrl?: string;
  prNumber?: number;
  claudeSessionId?: string;
  claudeCostUsd?: number;
  claudeResultText?: string;
  taskMode?: TaskMode;
  previousTaskMode?: TaskMode;
  planContent?: string;
  errorMessage?: string;
  logPath?: string;
  workspacePath?: string;
  worktreePath?: string;
  activePid?: number;
  runId?: string;
  attempt?: number;
  recoveryState?: RecoveryState;
  resumeAfter?: string;
  resumeReason?: string;
  resumeMode?: ResumeMode;
  screenshotFailed?: boolean;
  screenshotFailReason?: string;
  trackedBoards: string[];
  lastSeenOnBoardAt?: string;
  submittedFromBoardId?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface BoardPresenceSnapshot {
  boardId: string;
  jiraHost: string;
  boardType: JiraBoardType;
  projectKey?: string;
  issueKeys: string[];
  syncedAt: string;
}

export interface AppMeta {
  serverEpoch: number;
  revision: number;
}

export interface AppState {
  meta: AppMeta;
  tasks: Record<string, TaskRecord>;
  queue: string[];
  effects: Record<string, EffectRecord>;
  boards: Record<string, BoardPresenceSnapshot>;
}
