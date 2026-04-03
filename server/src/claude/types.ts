import type { JiraBoardType } from '../state/types.js';

export interface TaskInput {
  key: string;
  summary: string;
  description: string;
  acceptanceCriteria?: string;
  priority: string;
  issueType: string;
  labels: string[];
  comments: Array<{ author: string; body: string; created?: string }>;
  subtasks?: Array<{ key: string; summary: string; status: string }>;
  linkedIssues?: Array<{ type: string; key: string; summary: string; status: string }>;
  attachments?: Array<{ filename: string; mimeType: string; url: string }>;
  assignee?: string;
  reporter?: string;
  components?: string[];
  parentKey?: string;
  jiraUrl: string;
  boardId: string;
  boardType: JiraBoardType;
  projectKey?: string;
}

export interface ExecutionResult {
  success: boolean;
  resultText: string;
  sessionId?: string;
  costUsd?: number;
  durationMs: number;
}

export type ClaudeEventType = 'init' | 'message' | 'result';

export interface ClaudeToolUse {
  name: string;
  input: Record<string, unknown>;
}

export interface ClaudeEvent {
  type: ClaudeEventType;
  raw: Record<string, unknown>;
  text?: string;
  toolUse?: ClaudeToolUse[];
  isError?: boolean;
  costUsd?: number;
  sessionId?: string;
}
