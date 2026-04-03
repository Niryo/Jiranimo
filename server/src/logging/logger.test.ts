import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_LOGGING_CONFIG, createLogger, isSuppressedChildProcessLogLine, resolveLoggingConfig } from './logger.js';

let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

describe('resolveLoggingConfig', () => {
  it('returns defaults when logging config is omitted', () => {
    expect(resolveLoggingConfig({})).toEqual(DEFAULT_LOGGING_CONFIG);
  });

  it('merges provided values with defaults', () => {
    expect(resolveLoggingConfig({
      logging: {
        level: 'debug',
        logHttpRequests: false,
        logHttpBodies: true,
        logClaudeRawOutput: true,
      },
    })).toEqual({
      level: 'debug',
      logHttpRequests: false,
      logHttpBodies: true,
      logClaudeRawOutput: true,
    });
  });
});

describe('isSuppressedChildProcessLogLine', () => {
  it('suppresses Chrome updater noise', () => {
    expect(isSuppressedChildProcessLogLine(
      '[34638:35466485:0401/120613.618878:VERBOSE1:chrome/updater/updater.cc:470] UpdaterMain (--wake) returned 0.',
    )).toBe(true);
    expect(isSuppressedChildProcessLogLine(
      '[34635:35466481:0401/120613.742156:VERBOSE1:chrome/updater/app/app_wakeall.cc:66] `/Library/Application Support/Google/GoogleUpdater/...` exited 0',
    )).toBe(true);
  });

  it('keeps meaningful non-browser lines', () => {
    expect(isSuppressedChildProcessLogLine('npm ERR! missing script: dev')).toBe(false);
  });
});

describe('createLogger', () => {
  it('does not write below-threshold entries to the log file', () => {
    const logsDir = mkdtempSync(join(tmpdir(), 'jiranimo-logger-test-'));
    tempDirs.push(logsDir);
    const logger = createLogger({
      logsDir,
      logging: { level: 'info', logHttpRequests: false, logHttpBodies: false, logClaudeRawOutput: false },
    });

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      logger.debug('debug-noise');
      logger.info('useful-line');
    } finally {
      consoleSpy.mockRestore();
    }

    const file = readFileSync(join(logsDir, 'server.log'), 'utf-8');
    expect(file).toContain('useful-line');
    expect(file).not.toContain('debug-noise');
  });
});
