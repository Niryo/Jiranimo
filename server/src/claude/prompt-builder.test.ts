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
  boardId: '2',
  boardType: 'scrum',
  projectKey: 'PROJ',
};

const baseConfig: ServerConfig = {
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

  it('generates fix-comments mode prompt when mode is fix-comments', () => {
    const ctx = { prUrl: 'https://github.com/org/repo/pull/42', prNumber: 42, branchName: 'jiranimo/PROJ-123-feature' };
    const prompt = buildPrompt({
      ...baseTask,
      githubReviewComments: [{
        id: 101,
        fingerprint: '101:2026-04-03T10:00:00Z',
        kind: 'review',
        author: 'reviewer',
        body: 'Please rename this helper',
        path: 'src/app.ts',
        line: 42,
      }],
    } as any, baseConfig, repoPath, 'fix-comments', ctx);
    expect(prompt).toContain('existing PR');
    expect(prompt).toContain('githubReviewComments');
    expect(prompt).toContain('Please rename this helper');
    expect(prompt).toContain('gh pr view 42 --comments');
    expect(prompt).toContain('git push -u origin jiranimo/PROJ-123-feature');
    expect(prompt).not.toContain('gh pr create');
  });

  it('includes the saved plan when implementing a previously planned ticket', () => {
    const prompt = buildPrompt({
      ...baseTask,
      previousTaskMode: 'plan',
      planContent: '# Technical Plan\n\n1. Update API\n2. Add tests\n',
    }, baseConfig, repoPath, 'implement');
    expect(prompt).toContain('### Existing Technical Plan');
    expect(prompt).toContain('Treat it as your implementation baseline');
    expect(prompt).toContain('1. Update API');
  });

  it('includes the saved plan when refining a previously planned ticket', () => {
    const prompt = buildPrompt({
      ...baseTask,
      previousTaskMode: 'plan',
      planContent: '# Technical Plan\n\n1. Explore edge cases\n',
    }, baseConfig, repoPath, 'plan');
    expect(prompt).toContain('### Existing Technical Plan');
    expect(prompt).toContain('Refine or replace it only as needed');
    expect(prompt).toContain('1. Explore edge cases');
  });

  it('appends appendSystemPrompt when set', () => {
    const config = { ...baseConfig, claude: { ...baseConfig.claude, appendSystemPrompt: 'Focus on performance.' } };
    const prompt = buildPrompt(baseTask, config, repoPath);
    expect(prompt).toContain('Focus on performance.');
  });

  it('handles empty labels', () => {
    const prompt = buildPrompt({ ...baseTask, labels: [] }, baseConfig, repoPath);
    expect(prompt).not.toContain('"labels"');
  });

  it('excludes internal pipeline fields from prompt context', () => {
    const taskWithInternals = {
      ...baseTask,
      status: 'in-progress',
      runId: 'abc-123',
      attempt: 2,
      worktreePath: '/tmp/jiranimo-PROJ-123',
      workspacePath: '/tmp/jiranimo-workspaces/PROJ-123',
      logPath: '/home/.jiranimo/logs/PROJ-123.jsonl',
      claudeCostUsd: 0.05,
      recoveryState: 'none',
      trackedBoards: ['host:1'],
      createdAt: '2026-01-01T00:00:00Z',
    };
    const prompt = buildPrompt(taskWithInternals as any, baseConfig, repoPath);
    expect(prompt).not.toContain('"worktreePath"');
    expect(prompt).not.toContain('"workspacePath"');
    expect(prompt).not.toContain('"runId"');
    expect(prompt).not.toContain('"attempt"');
    expect(prompt).not.toContain('"recoveryState"');
    expect(prompt).not.toContain('"trackedBoards"');
    expect(prompt).not.toContain('"claudeCostUsd"');
    expect(prompt).not.toContain('"createdAt"');
    expect(prompt).not.toContain('"repoPath"');
  });

  it('omits empty arrays from prompt context', () => {
    const prompt = buildPrompt({ ...baseTask, labels: [], comments: [] }, baseConfig, repoPath);
    expect(prompt).not.toContain('"labels"');
    expect(prompt).not.toContain('"comments"');
  });

  it('includes non-empty labels and comments', () => {
    const prompt = buildPrompt({
      ...baseTask,
      labels: ['frontend'],
      comments: [{ author: 'PM', body: 'Use existing button component' }],
    }, baseConfig, repoPath);
    expect(prompt).toContain('"labels"');
    expect(prompt).toContain('frontend');
    expect(prompt).toContain('"comments"');
    expect(prompt).toContain('Use existing button component');
  });

  it('includes GitHub review comments in prompt context when present', () => {
    const prompt = buildPrompt({
      ...baseTask,
      githubReviewComments: [{
        id: 101,
        fingerprint: '101:2026-04-03T10:00:00Z',
        kind: 'conversation',
        author: 'reviewer',
        body: 'Please rename this helper',
      }],
    } as any, baseConfig, repoPath);
    expect(prompt).toContain('"githubReviewComments"');
    expect(prompt).toContain('Please rename this helper');
  });

  it('embeds branchPrefix and defaultBaseBranch in git instructions', () => {
    const config = { ...baseConfig, git: { ...baseConfig.git, branchPrefix: 'feat/', defaultBaseBranch: 'develop' } };
    const prompt = buildPrompt(baseTask, config, repoPath);
    expect(prompt).toContain('feat/');
    expect(prompt).toContain('develop');
  });
});
