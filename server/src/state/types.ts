export type TaskStatus = 'queued' | 'in-progress' | 'interrupted' | 'completed' | 'failed';
export type TaskMode = 'plan' | 'implement' | 'screenshot' | 'fix-comments';
export type RecoveryState = 'none' | 'resume-pending' | 'resume-cancelled' | 'resuming';
export type ResumeMode = 'claude-session' | 'fresh-recovery';
export type EffectType = 'pipeline-status-sync' | 'completion-comment' | 'plan-comment';
export type EffectStatus = 'pending' | 'claimed';
export type JiraBoardType = 'scrum' | 'kanban';

export interface GithubReviewCommentRecord {
  id: number;
  fingerprint: string;
  kind: 'review' | 'conversation';
  author: string;
  body: string;
  path?: string;
  line?: number;
  url?: string;
  created?: string;
  updated?: string;
}

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
  githubReviewComments?: GithubReviewCommentRecord[];
  fixedGithubCommentFingerprints?: string[];
  pendingGithubCommentFingerprints?: string[];
  subtasks?: Array<{ key: string; summary: string; status: string }>;
  linkedIssues?: Array<{ type: string; key: string; summary: string; status: string }>;
  attachments?: Array<{ filename: string; mimeType: string; url: string }>;
  assignee?: string;
  reporter?: string;
  components?: string[];
  parentKey?: string;
  jiraUrl: string;
  status: TaskStatus;
  repoPath?: string;
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
  isCompleteSnapshot?: boolean;
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
