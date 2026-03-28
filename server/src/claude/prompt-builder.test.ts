import { describe, it, expect } from 'vitest';
import { buildPrompt } from './prompt-builder.js';
import type { TaskInput } from './types.js';
import type { ServerConfig } from '../config/types.js';

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

const baseConfig: ServerConfig = {
  reposRoot: '/home/dev/repos',
  claude: { maxBudgetUsd: 2.0 },
  pipeline: { concurrency: 1 },
  git: { branchPrefix: 'jiranimo/', defaultBaseBranch: 'main', pushRemote: 'origin', createDraftPr: true },
  web: { port: 3456, host: '127.0.0.1' },
};

const repoPath = '/home/dev/repos/my-app';

describe('buildPrompt', () => {
  it('includes task key and summary', () => {
    const prompt = buildPrompt(baseTask, baseConfig, repoPath);
    expect(prompt).toContain('PROJ-123');
    expect(prompt).toContain('Add user avatar');
  });

  it('includes description', () => {
    const prompt = buildPrompt(baseTask, baseConfig, repoPath);
    expect(prompt).toContain('see my avatar on the profile page');
  });

  it('includes acceptance criteria when present', () => {
    const prompt = buildPrompt({ ...baseTask, acceptanceCriteria: 'Avatar must be 64x64' }, baseConfig, repoPath);
    expect(prompt).toContain('Acceptance Criteria');
    expect(prompt).toContain('Avatar must be 64x64');
  });

  it('omits acceptance criteria section when not present', () => {
    const prompt = buildPrompt(baseTask, baseConfig, repoPath);
    expect(prompt).not.toContain('Acceptance Criteria');
  });

  it('includes recent comments', () => {
    const prompt = buildPrompt({
      ...baseTask,
      comments: [{ author: 'PM', body: 'Use the existing component' }],
    }, baseConfig, repoPath);
    expect(prompt).toContain('Recent Comments');
    expect(prompt).toContain('**PM**: Use the existing component');
  });

  it('limits comments to last 10', () => {
    const comments = Array.from({ length: 15 }, (_, i) => ({
      author: `User${i}`,
      body: `Comment ${i}`,
    }));
    const prompt = buildPrompt({ ...baseTask, comments }, baseConfig, repoPath);
    expect(prompt).not.toContain('Comment 0');
    expect(prompt).not.toContain('Comment 4');
    expect(prompt).toContain('Comment 5');
    expect(prompt).toContain('Comment 14');
  });

  it('includes metadata (priority, type, labels, url)', () => {
    const prompt = buildPrompt(baseTask, baseConfig, repoPath);
    expect(prompt).toContain('Priority: High');
    expect(prompt).toContain('Type: Story');
    expect(prompt).toContain('frontend, ai-ready');
    expect(prompt).toContain('https://test.atlassian.net/browse/PROJ-123');
  });

  it('includes git instructions with repoPath', () => {
    const prompt = buildPrompt(baseTask, baseConfig, repoPath);
    expect(prompt).toContain(repoPath);
    expect(prompt).toContain('worktree add');
    expect(prompt).toContain('git push');
  });

  it('includes MCP tool instructions', () => {
    const prompt = buildPrompt(baseTask, baseConfig, repoPath);
    expect(prompt).toContain('jiranimo_progress');
    expect(prompt).toContain('jiranimo_report_pr');
    expect(prompt).toContain('jiranimo_complete');
    expect(prompt).toContain('jiranimo_fail');
  });

  it('includes draft PR step when createDraftPr is true', () => {
    const prompt = buildPrompt(baseTask, baseConfig, repoPath);
    expect(prompt).toContain('gh pr create --draft');
  });

  it('omits draft PR step when createDraftPr is false', () => {
    const config = { ...baseConfig, git: { ...baseConfig.git, createDraftPr: false } };
    const prompt = buildPrompt(baseTask, config, repoPath);
    expect(prompt).not.toContain('gh pr create --draft');
  });

  it('truncates very long descriptions', () => {
    const longDesc = 'x'.repeat(15_000);
    const prompt = buildPrompt({ ...baseTask, description: longDesc }, baseConfig, repoPath);
    expect(prompt).toContain('(description truncated)');
    expect(prompt.length).toBeLessThan(15_000 + 5000);
  });

  it('handles missing description', () => {
    const prompt = buildPrompt({ ...baseTask, description: '' }, baseConfig, repoPath);
    expect(prompt).toContain('No description provided');
  });

  it('appends appendSystemPrompt when set', () => {
    const config = { ...baseConfig, claude: { ...baseConfig.claude, appendSystemPrompt: 'Focus on performance.' } };
    const prompt = buildPrompt(baseTask, config, repoPath);
    expect(prompt).toContain('Focus on performance.');
  });

  it('handles empty labels', () => {
    const prompt = buildPrompt({ ...baseTask, labels: [] }, baseConfig, repoPath);
    expect(prompt).toContain('Labels: none');
  });

  it('embeds branchPrefix and defaultBaseBranch in git instructions', () => {
    const config = { ...baseConfig, git: { ...baseConfig.git, branchPrefix: 'feat/', defaultBaseBranch: 'develop' } };
    const prompt = buildPrompt(baseTask, config, repoPath);
    expect(prompt).toContain('feat/');
    expect(prompt).toContain('develop');
  });
});
