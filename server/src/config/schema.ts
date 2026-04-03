import { z } from 'zod';

const DEFAULT_ALLOWED_TOOLS = [
  'Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep',
];

const claudeConfigSchema = z.object({
  model: z.string().optional(),
  maxBudgetUsd: z.number().positive(),
  allowedTools: z.array(z.string()).default(DEFAULT_ALLOWED_TOOLS),
  appendSystemPrompt: z.string().optional(),
  effortLevel: z.string().optional(),
  command: z.string().optional(),
});

const pipelineConfigSchema = z.object({
  // 0 = unlimited (all queued tasks run in parallel); positive integer = cap
  concurrency: z.number().int().min(0).default(0),
});

const gitConfigSchema = z.object({
  branchPrefix: z.string().default('jiranimo/'),
  defaultBaseBranch: z.string().default('main'),
  pushRemote: z.string().default('origin'),
  createDraftPr: z.boolean().default(true),
});

const webConfigSchema = z.object({
  port: z.number().int().min(1).max(65535).default(3456),
  host: z.string().default('127.0.0.1'),
});

const loggingConfigSchema = z.object({
  level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  logHttpRequests: z.boolean().default(true),
  logHttpBodies: z.boolean().default(false),
  logClaudeRawOutput: z.boolean().default(false),
});

export const serverConfigSchema = z.object({
  logsDir: z.string().optional(),
  statePath: z.string().optional(),
  claude: claudeConfigSchema.default({ maxBudgetUsd: 2.0, allowedTools: DEFAULT_ALLOWED_TOOLS }),
  pipeline: pipelineConfigSchema.default({ concurrency: 1 }),
  git: gitConfigSchema.default({
    branchPrefix: 'jiranimo/',
    defaultBaseBranch: 'main',
    pushRemote: 'origin',
    createDraftPr: true,
  }),
  web: webConfigSchema.default({ port: 3456, host: '127.0.0.1' }),
  logging: loggingConfigSchema.default({
    level: 'info',
    logHttpRequests: true,
    logHttpBodies: false,
    logClaudeRawOutput: false,
  }),
});

export type ServerConfigInput = z.input<typeof serverConfigSchema>;
