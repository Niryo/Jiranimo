export type TaskStatus = 'queued' | 'in-progress' | 'completed' | 'failed';
export type TaskMode = 'plan' | 'implement' | 'screenshot';

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
  planContent?: string;
  errorMessage?: string;
  logPath?: string;
  screenshotFailed?: boolean;
  screenshotFailReason?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface AppState {
  tasks: Record<string, TaskRecord>;
}
