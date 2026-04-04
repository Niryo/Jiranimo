import { describe, it, expect, vi } from 'vitest';
import { executeClaudeCode } from './executor.js';
import type { ClaudeConfig } from '../config/types.js';

// These tests use the real fake-claude fixture (spawns a real subprocess)
// They're fast since the fixture exits immediately

const fakeClaude = `node ${process.cwd()}/test/fixtures/fake-claude.mjs`;
const baseConfig: ClaudeConfig = { maxBudgetUsd: 2.0, command: fakeClaude };

describe('executeClaudeCode', () => {
  it('returns success result for successful execution', async () => {
    const result = await executeClaudeCode({
      prompt: 'test prompt',
      cwd: process.cwd(),
      config: { ...baseConfig, command: fakeClaude },
    });

    expect(result.success).toBe(true);
    expect(result.resultText).toContain('Task completed');
    expect(result.costUsd).toBe(0.42);
    expect(result.sessionId).toBe('fake-session-123');
    expect(result.durationMs).toBeGreaterThan(0);
  }, 15_000);

  it('returns failure result for failed execution', async () => {
    const result = await executeClaudeCode({
      prompt: 'test prompt',
      cwd: process.cwd(),
      config: baseConfig,
      env: { FAKE_CLAUDE_SCENARIO: 'failure' },
    });

    expect(result.success).toBe(false);
    expect(result.resultText).toContain('Failed to implement');
  }, 15_000);

  it('calls onEvent callback for each event', async () => {
    const events: string[] = [];
    await executeClaudeCode({
      prompt: 'test prompt',
      cwd: process.cwd(),
      config: baseConfig,
      onEvent: (event) => events.push(event.type),
    });

    expect(events).toContain('init');
    expect(events).toContain('message');
    expect(events).toContain('result');
  }, 15_000);

  it('rejects when command does not exist', async () => {
    await expect(
      executeClaudeCode({
        prompt: 'test',
        cwd: process.cwd(),
        config: { ...baseConfig, command: '/nonexistent/binary' },
      })
    ).rejects.toThrow('Failed to spawn');
  });
});
