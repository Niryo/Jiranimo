import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadConfig } from './loader.js';
import * as fs from 'node:fs';

vi.mock('node:fs');

const validConfig = JSON.stringify({
  claude: { model: 'sonnet' },
});

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('loadConfig', () => {
  it('loads and parses a valid config file', () => {
    vi.mocked(fs.readFileSync).mockReturnValue(validConfig);

    const config = loadConfig({ configPath: '/fake/config.json' });
    expect(config.claude.model).toBe('sonnet');
  });

  it('applies defaults for missing optional fields', () => {
    vi.mocked(fs.readFileSync).mockReturnValue(validConfig);

    const config = loadConfig({ configPath: '/fake/config.json' });
    expect(config.git.branchPrefix).toBe('jiranimo/');
    expect(config.claude.maxBudgetUsd).toBeUndefined();
    expect(config.web.port).toBe(3456);
    expect(config.pipeline.concurrency).toBe(1);
    expect(config.logging?.level).toBe('info');
    expect(config.logging?.logHttpRequests).toBe(true);
  });

  it('returns defaults when no config file is found', () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error('ENOENT');
    });

    const config = loadConfig({ searchPaths: ['/nonexistent/config.json'] });
    expect(config.claude.maxBudgetUsd).toBeUndefined();
    expect(config.web.port).toBe(3456);
  });

  it('throws on invalid JSON', () => {
    vi.mocked(fs.readFileSync).mockReturnValue('not json{{{');

    expect(() => loadConfig({ configPath: '/fake/config.json' }))
      .toThrow('Invalid JSON');
  });

  it('throws on schema validation failure with descriptive message', () => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ web: { port: 0 } }));

    expect(() => loadConfig({ configPath: '/fake/config.json' }))
      .toThrow('Invalid config');
  });

  it('resolves $ENV_VAR references in string values', () => {
    process.env.TEST_APPEND_PROMPT = 'Always run tests';

    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ claude: { maxBudgetUsd: 2.0, appendSystemPrompt: '$TEST_APPEND_PROMPT' } })
    );

    const config = loadConfig({ configPath: '/fake/config.json' });
    expect(config.claude.appendSystemPrompt).toBe('Always run tests');

    delete process.env.TEST_APPEND_PROMPT;
  });

  it('throws when referenced env var is not set', () => {
    delete process.env.NONEXISTENT_VAR;

    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ claude: { maxBudgetUsd: 2.0, appendSystemPrompt: '$NONEXISTENT_VAR' } })
    );

    expect(() => loadConfig({ configPath: '/fake/config.json' }))
      .toThrow('Environment variable NONEXISTENT_VAR is not set');
  });

  it('searches multiple paths when no configPath given', () => {
    let callCount = 0;
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      callCount++;
      if (callCount === 1) throw new Error('ENOENT');
      return validConfig;
    });

    const config = loadConfig({ searchPaths: ['/first/config.json', '/second/config.json'] });
    expect(config.claude.model).toBe('sonnet');
    // findConfigFile reads once to check existence, loadConfig reads again to parse
    expect(callCount).toBe(3);
  });

  it('prefers JIRANIMO_CONFIG when no configPath is provided', () => {
    process.env.JIRANIMO_CONFIG = '/env/config.json';
    vi.mocked(fs.readFileSync).mockReturnValue(validConfig);

    const config = loadConfig();

    expect(config.claude.model).toBe('sonnet');
    expect(fs.readFileSync).toHaveBeenCalledWith('/env/config.json', 'utf-8');

    delete process.env.JIRANIMO_CONFIG;
  });

  it('ignores legacy repo location keys in older config files', () => {
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        repoPath: '/legacy/path',
        reposRoot: '/legacy/root',
        repoName: 'legacy-repo',
        git: { defaultBaseBranch: 'develop' },
      })
    );

    const config = loadConfig({ configPath: '/fake/config.json' });
    expect(config.git.defaultBaseBranch).toBe('develop');
    expect(config).not.toHaveProperty('repoPath');
    expect(config).not.toHaveProperty('reposRoot');
    expect(config).not.toHaveProperty('repoName');
  });
});
