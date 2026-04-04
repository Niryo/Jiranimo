import { describe, expect, it, vi } from 'vitest';
import { assertRequiredCliToolsAvailable } from './required-tools.js';

describe('assertRequiredCliToolsAvailable', () => {
  it('checks the default claude and gh executables', () => {
    const checker = vi.fn(() => ({ available: true }));

    expect(() => assertRequiredCliToolsAvailable({ claude: {} }, checker)).not.toThrow();

    expect(checker).toHaveBeenCalledTimes(2);
    expect(checker).toHaveBeenNthCalledWith(1, 'claude', ['--version']);
    expect(checker).toHaveBeenNthCalledWith(2, 'gh', ['--version']);
  });

  it('checks the executable from a configured claude command override', () => {
    const checker = vi.fn(() => ({ available: true }));

    expect(() => assertRequiredCliToolsAvailable({
      claude: { command: 'node /tmp/fake-claude.mjs' },
    }, checker)).not.toThrow();

    expect(checker).toHaveBeenNthCalledWith(1, 'node', ['--version']);
    expect(checker).toHaveBeenNthCalledWith(2, 'gh', ['--version']);
  });

  it('throws a clear startup error when required tools are missing', () => {
    const checker = vi.fn((program: string) => {
      if (program === 'claude') {
        return { available: false, reason: 'was not found in PATH' };
      }
      return { available: false, reason: 'was not found in PATH' };
    });

    expect(() => assertRequiredCliToolsAvailable({ claude: {} }, checker)).toThrow(
      'Missing required CLI tools before starting Jiranimo:\n'
      + '- Claude Code CLI: command `claude` was not found in PATH. Install Claude Code and make sure `claude` command is available.\n'
      + '- GitHub CLI: command `gh` was not found in PATH. Install GitHub CLI and make sure `gh` command is available.',
    );
  });

  it('mentions the configured claude command in failures', () => {
    const checker = vi.fn((program: string) => (
      program === 'node'
        ? { available: false, reason: 'was not found in PATH' }
        : { available: true }
    ));

    expect(() => assertRequiredCliToolsAvailable({
      claude: { command: 'node /tmp/fake-claude.mjs' },
    }, checker)).toThrow(
      'Claude Code CLI: command `node /tmp/fake-claude.mjs` (executable `node`) was not found in PATH. Fix `claude.command` or make sure that executable is installed and on PATH.',
    );
  });
});
