import { describe, expect, it } from 'vitest';
import { formatStartupFailureMessage } from './error-format.js';

describe('formatStartupFailureMessage', () => {
  it('keeps single-line errors compact', () => {
    expect(formatStartupFailureMessage(new Error('Boom'))).toBe('Startup failed: Boom');
  });

  it('formats multi-line startup errors for terminal readability', () => {
    expect(formatStartupFailureMessage(new Error([
      'Missing required CLI tools before starting Jiranimo:',
      '- Claude Code CLI: command `claude` was not found in PATH.',
      '- GitHub CLI: command `gh` was not found in PATH.',
    ].join('\n')))).toBe([
      'Startup failed',
      '',
      'Missing required CLI tools before starting Jiranimo:',
      '  - Claude Code CLI: command `claude` was not found in PATH.',
      '  - GitHub CLI: command `gh` was not found in PATH.',
    ].join('\n'));
  });

  it('adds ANSI colors when requested', () => {
    const formatted = formatStartupFailureMessage(new Error([
      'Missing required CLI tools before starting Jiranimo:',
      '- Claude Code CLI: command `claude` was not found in PATH.',
    ].join('\n')), { color: true });

    expect(formatted).toContain('\u001B[1m\u001B[31mStartup failed\u001B[0m');
    expect(formatted).toContain('\u001B[1m\u001B[33mMissing required CLI tools before starting Jiranimo:\u001B[0m');
    expect(formatted).toContain('\u001B[31m- Claude Code CLI: command `claude` was not found in PATH.\u001B[0m');
  });
});
