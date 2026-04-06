import { describe, it, expect, vi, beforeEach } from 'vitest';
import { classifyTask, decidePlannedTaskNextMode, resolveTaskMode } from './task-classifier.js';

vi.mock('./executor.js', () => ({
  executeClaudeCode: vi.fn(),
}));

describe('task-classifier', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('classifies standard implementation tasks', async () => {
    const { executeClaudeCode } = await import('./executor.js');
    vi.mocked(executeClaudeCode).mockResolvedValueOnce({
      success: true,
      resultText: 'implement',
      durationMs: 100,
    });

    const mode = await classifyTask({
      key: 'PROJ-123',
      summary: 'Build the feature',
      description: 'Implement the new endpoint',
    }, { command: 'my-claude' });

    expect(mode).toBe('implement');
    expect(vi.mocked(executeClaudeCode).mock.calls[0]?.[0].prompt).toContain('Classify this Jira task');
    expect(vi.mocked(executeClaudeCode).mock.calls[0]?.[0].config.command).toBe('my-claude');
  });

  it('decides to implement a previously planned ticket when comments approve it', async () => {
    const { executeClaudeCode } = await import('./executor.js');
    vi.mocked(executeClaudeCode).mockResolvedValueOnce({
      success: true,
      resultText: 'implement',
      durationMs: 100,
    });

    const mode = await decidePlannedTaskNextMode({
      key: 'PROJ-456',
      summary: 'Follow up on plan',
      description: 'Previously planned task',
      planContent: '# Technical Plan\n\n1. Add API\n2. Add tests\n',
      comments: [{ author: 'PM', body: "Perfect, let's do it", created: '2026-04-02T09:00:00.000Z' }],
    }, { command: 'my-claude' });

    expect(mode).toBe('implement');
    expect(vi.mocked(executeClaudeCode).mock.calls[0]?.[0].prompt).toContain("Perfect, let's do it");
    expect(vi.mocked(executeClaudeCode).mock.calls[0]?.[0].prompt).toContain('previous Jiranimo run already produced a technical plan');
    expect(vi.mocked(executeClaudeCode).mock.calls[0]?.[0].config.command).toBe('my-claude');
  });

  it('defaults previously planned tickets to more planning when comments are ambiguous', async () => {
    const { executeClaudeCode } = await import('./executor.js');
    vi.mocked(executeClaudeCode).mockResolvedValueOnce({
      success: true,
      resultText: 'plan',
      durationMs: 100,
    });

    const mode = await resolveTaskMode({
      key: 'PROJ-789',
      summary: 'Need clarity',
      description: 'Previously planned task',
      previousTaskMode: 'plan',
      planContent: '# Technical Plan\n\n1. Investigate\n',
      comments: [{ author: 'Designer', body: 'Can we think through one more edge case?' }],
    }, { command: 'my-claude' });

    expect(mode).toBe('plan');
    expect(vi.mocked(executeClaudeCode).mock.calls[0]?.[0].prompt).toContain('Be conservative');
    expect(vi.mocked(executeClaudeCode).mock.calls[0]?.[0].config.command).toBe('my-claude');
  });
});
