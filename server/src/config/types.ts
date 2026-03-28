export interface ClaudeConfig {
  model?: string;
  maxBudgetUsd: number;
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

export interface ServerConfig {
  reposRoot: string;
  claude: ClaudeConfig;
  pipeline: PipelineConfig;
  git: GitConfig;
  web: WebConfig;
  logsDir?: string;
  statePath?: string;
}
