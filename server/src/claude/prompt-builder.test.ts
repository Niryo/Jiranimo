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
    expect(prompt).toContain('Avatar must be 64x64');
  });

  it('omits acceptance criteria when not present', () => {
    const prompt = buildPrompt(baseTask, baseConfig, repoPath);
    expect(prompt).not.toContain('acceptanceCriteria');
  });

  it('includes comments', () => {
    const prompt = buildPrompt({
      ...baseTask,
      comments: [{ author: 'PM', body: 'Use the existing component' }],
    }, baseConfig, repoPath);
    expect(prompt).toContain('PM');
    expect(prompt).toContain('Use the existing component');
  });

  it('includes all comments as-is', () => {
    const comments = Array.from({ length: 15 }, (_, i) => ({
      author: `User${i}`,
      body: `Comment ${i}`,
    }));
    const prompt = buildPrompt({ ...baseTask, comments }, baseConfig, repoPath);
    expect(prompt).toContain('Comment 0');
    expect(prompt).toContain('Comment 14');
  });

  it('includes metadata (priority, type, labels, url)', () => {
    const prompt = buildPrompt(baseTask, baseConfig, repoPath);
    expect(prompt).toContain('High');
    expect(prompt).toContain('Story');
    expect(prompt).toContain('frontend');
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

  it('includes full description without truncation', () => {
    const longDesc = 'x'.repeat(15_000);
    const prompt = buildPrompt({ ...baseTask, description: longDesc }, baseConfig, repoPath);
    expect(prompt).toContain('x'.repeat(15_000));
  });

  it('handles missing description', () => {
    const prompt = buildPrompt({ ...baseTask, description: '' }, baseConfig, repoPath);
    expect(prompt).toContain('"description": ""');
  });

  it('includes screenshot upload instructions', () => {
    const prompt = buildPrompt(baseTask, baseConfig, repoPath);
    expect(prompt).toContain('browser_screenshot');
    expect(prompt).toContain('jiranimo_upload_screenshot');
    expect(prompt).toContain('Never create a throwaway demo/mock HTML file');
    expect(prompt).toContain('jiranimo_screenshot_failed');
  });

  it('generates screenshot mode prompt when mode is screenshot', () => {
    const ctx = { prUrl: 'https://github.com/org/repo/pull/42', prNumber: 42, branchName: 'jiranimo/PROJ-123-feature' };
    const prompt = buildPrompt(baseTask, baseConfig, repoPath, 'screenshot', ctx);
    expect(prompt).toContain('screenshot');
    expect(prompt).toContain('https://github.com/org/repo/pull/42');
    expect(prompt).toContain('jiranimo/PROJ-123-feature');
    expect(prompt).toContain('gh pr edit 42');
    expect(prompt).not.toContain('gh pr create');
  });

  it('appends appendSystemPrompt when set', () => {
    const config = { ...baseConfig, claude: { ...baseConfig.claude, appendSystemPrompt: 'Focus on performance.' } };
    const prompt = buildPrompt(baseTask, config, repoPath);
    expect(prompt).toContain('Focus on performance.');
  });

  it('handles empty labels', () => {
    const prompt = buildPrompt({ ...baseTask, labels: [] }, baseConfig, repoPath);
    expect(prompt).toContain('"labels": []');
  });

  it('embeds branchPrefix and defaultBaseBranch in git instructions', () => {
    const config = { ...baseConfig, git: { ...baseConfig.git, branchPrefix: 'feat/', defaultBaseBranch: 'develop' } };
    const prompt = buildPrompt(baseTask, config, repoPath);
    expect(prompt).toContain('feat/');
    expect(prompt).toContain('develop');
  });
});
