import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadConfig } from './loader.js';
import * as fs from 'node:fs';

vi.mock('node:fs');

const validConfig = JSON.stringify({
  repoPath: '/tmp/repo',
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
    expect(config.repoPath).toBe('/tmp/repo');
    expect(config.claude.maxBudgetUsd).toBe(2.0);
  });

  it('applies defaults for missing optional fields', () => {
    vi.mocked(fs.readFileSync).mockReturnValue(validConfig);

    const config = loadConfig({ configPath: '/fake/config.json' });
    expect(config.git.branchPrefix).toBe('jiranimo/');
    expect(config.web.port).toBe(3456);
    expect(config.pipeline.concurrency).toBe(1);
  });

  it('throws on missing config file', () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error('ENOENT');
    });

    expect(() => loadConfig({ searchPaths: ['/nonexistent/config.json'] }))
      .toThrow('Config file not found');
  });

  it('throws on invalid JSON', () => {
    vi.mocked(fs.readFileSync).mockReturnValue('not json{{{');

    expect(() => loadConfig({ configPath: '/fake/config.json' }))
      .toThrow('Invalid JSON');
  });

  it('throws on schema validation failure with descriptive message', () => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({}));

    expect(() => loadConfig({ configPath: '/fake/config.json' }))
      .toThrow('Invalid config');
  });

  it('resolves $ENV_VAR references in string values', () => {
    process.env.TEST_REPO_PATH = '/resolved/path';

    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ repoPath: '$TEST_REPO_PATH' })
    );

    const config = loadConfig({ configPath: '/fake/config.json' });
    expect(config.repoPath).toBe('/resolved/path');

    delete process.env.TEST_REPO_PATH;
  });

  it('throws when referenced env var is not set', () => {
    delete process.env.NONEXISTENT_VAR;

    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ repoPath: '$NONEXISTENT_VAR' })
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
    expect(config.repoPath).toBe('/tmp/repo');
    // findConfigFile reads once to check existence, loadConfig reads again to parse
    expect(callCount).toBe(3);
  });
});
