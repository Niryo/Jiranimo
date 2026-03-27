import { describe, it, expect } from 'vitest';
import { serverConfigSchema } from './schema.js';

const validMinimal = {
  repoPath: '/tmp/repo',
};

const validFull = {
  repoPath: '/tmp/repo',
  claude: { model: 'sonnet', maxBudgetUsd: 5.0, allowedTools: ['Edit', 'Read'] },
  pipeline: { concurrency: 3 },
  git: { branchPrefix: 'auto/', defaultBaseBranch: 'develop', pushRemote: 'upstream', createDraftPr: false },
  web: { port: 8080, host: '0.0.0.0' },
};

describe('serverConfigSchema', () => {
  it('accepts minimal valid config and applies defaults', () => {
    const result = serverConfigSchema.parse(validMinimal);
    expect(result.repoPath).toBe('/tmp/repo');
    expect(result.claude.maxBudgetUsd).toBe(2.0);
    expect(result.pipeline.concurrency).toBe(1);
    expect(result.git.branchPrefix).toBe('jiranimo/');
    expect(result.git.defaultBaseBranch).toBe('main');
    expect(result.git.pushRemote).toBe('origin');
    expect(result.git.createDraftPr).toBe(true);
    expect(result.web.port).toBe(3456);
    expect(result.web.host).toBe('127.0.0.1');
  });

  it('accepts full valid config with all fields', () => {
    const result = serverConfigSchema.parse(validFull);
    expect(result.claude.model).toBe('sonnet');
    expect(result.claude.maxBudgetUsd).toBe(5.0);
    expect(result.pipeline.concurrency).toBe(3);
    expect(result.git.branchPrefix).toBe('auto/');
    expect(result.web.port).toBe(8080);
  });

  it('rejects config with missing repoPath', () => {
    const result = serverConfigSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('rejects config with empty repoPath', () => {
    const result = serverConfigSchema.safeParse({ repoPath: '' });
    expect(result.success).toBe(false);
  });

  it('rejects negative maxBudgetUsd', () => {
    const result = serverConfigSchema.safeParse({
      ...validMinimal,
      claude: { maxBudgetUsd: -1 },
    });
    expect(result.success).toBe(false);
  });

  it('rejects zero concurrency', () => {
    const result = serverConfigSchema.safeParse({
      ...validMinimal,
      pipeline: { concurrency: 0 },
    });
    expect(result.success).toBe(false);
  });

  it('rejects port out of range', () => {
    expect(serverConfigSchema.safeParse({ ...validMinimal, web: { port: 0 } }).success).toBe(false);
    expect(serverConfigSchema.safeParse({ ...validMinimal, web: { port: 70000 } }).success).toBe(false);
  });

  it('rejects non-integer concurrency', () => {
    const result = serverConfigSchema.safeParse({
      ...validMinimal,
      pipeline: { concurrency: 1.5 },
    });
    expect(result.success).toBe(false);
  });
});
