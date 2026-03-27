import { describe, it, expect } from 'vitest';
import { buildPrompt } from './prompt-builder.js';
import type { TaskInput } from './types.js';

const baseTask: TaskInput = {
  key: 'PROJ-123',
  summary: 'Add user avatar',
  description: 'As a user, I want to see my avatar on the profile page.',
  priority: 'High',
  issueType: 'Story',
  labels: ['frontend', 'ai-ready'],
  comments: [],
  jiraUrl: 'https://test.atlassian.net/browse/PROJ-123',
};

describe('buildPrompt', () => {
  it('includes task key and summary', () => {
    const prompt = buildPrompt(baseTask);
    expect(prompt).toContain('PROJ-123');
    expect(prompt).toContain('Add user avatar');
  });

  it('includes description', () => {
    const prompt = buildPrompt(baseTask);
    expect(prompt).toContain('see my avatar on the profile page');
  });

  it('includes acceptance criteria when present', () => {
    const prompt = buildPrompt({ ...baseTask, acceptanceCriteria: 'Avatar must be 64x64' });
    expect(prompt).toContain('Acceptance Criteria');
    expect(prompt).toContain('Avatar must be 64x64');
  });

  it('omits acceptance criteria section when not present', () => {
    const prompt = buildPrompt(baseTask);
    expect(prompt).not.toContain('Acceptance Criteria');
  });

  it('includes recent comments', () => {
    const prompt = buildPrompt({
      ...baseTask,
      comments: [{ author: 'PM', body: 'Use the existing component' }],
    });
    expect(prompt).toContain('Recent Comments');
    expect(prompt).toContain('**PM**: Use the existing component');
  });

  it('limits comments to last 10', () => {
    const comments = Array.from({ length: 15 }, (_, i) => ({
      author: `User${i}`,
      body: `Comment ${i}`,
    }));
    const prompt = buildPrompt({ ...baseTask, comments });
    // Should include comments 5-14 (last 10), not 0-4
    expect(prompt).not.toContain('Comment 0');
    expect(prompt).not.toContain('Comment 4');
    expect(prompt).toContain('Comment 5');
    expect(prompt).toContain('Comment 14');
  });

  it('includes metadata (priority, type, labels, url)', () => {
    const prompt = buildPrompt(baseTask);
    expect(prompt).toContain('Priority: High');
    expect(prompt).toContain('Type: Story');
    expect(prompt).toContain('frontend, ai-ready');
    expect(prompt).toContain('https://test.atlassian.net/browse/PROJ-123');
  });

  it('includes instruction to implement without running git', () => {
    const prompt = buildPrompt(baseTask);
    expect(prompt).toContain('Do NOT run git commands');
    expect(prompt).toContain('feature branch');
  });

  it('truncates very long descriptions', () => {
    const longDesc = 'x'.repeat(15_000);
    const prompt = buildPrompt({ ...baseTask, description: longDesc });
    expect(prompt).toContain('(description truncated)');
    expect(prompt.length).toBeLessThan(15_000);
  });

  it('handles missing description', () => {
    const prompt = buildPrompt({ ...baseTask, description: '' });
    expect(prompt).toContain('No description provided');
  });

  it('appends custom prompt when provided', () => {
    const prompt = buildPrompt(baseTask, 'Focus on performance.');
    expect(prompt).toContain('Focus on performance.');
  });

  it('handles empty labels', () => {
    const prompt = buildPrompt({ ...baseTask, labels: [] });
    expect(prompt).toContain('Labels: none');
  });
});
