export interface ClaudeConfig {
  model?: string;
  maxBudgetUsd?: number;
  allowedTools?: string[];
  appendSystemPrompt?: string;
  effortLevel?: string;
  command?: string; // override claude binary path (for testing)
}

export interface PipelineConfig {
  concurrency: number;
}

export interface GitConfig {
  branchPrefix: string;
  defaultBaseBranch: string;
  pushRemote: string;
  createDraftPr: boolean;
}

export interface WebConfig {
  port: number;
  host: string;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LoggingConfig {
  level: LogLevel;
  logHttpRequests: boolean;
  logHttpBodies: boolean;
  logClaudeRawOutput: boolean;
}

export interface ServerConfig {
  claude: ClaudeConfig;
  pipeline: PipelineConfig;
  git: GitConfig;
  web: WebConfig;
  logging?: LoggingConfig;
  logsDir?: string;
  statePath?: string;
}
