import { describe, expect, it } from 'vitest';
import { DEFAULT_LOGGING_CONFIG, isSuppressedChildProcessLogLine, resolveLoggingConfig } from './logger.js';

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
