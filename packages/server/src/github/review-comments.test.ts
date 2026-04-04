import { beforeEach, describe, expect, it, vi } from 'vitest';

const execFileMock = vi.fn();

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
}));

describe('fetchPendingGithubReviewComments', () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it('fetches both review comments and PR conversation comments', async () => {
    execFileMock
      .mockImplementationOnce((_file, _args, _opts, cb) => {
        cb(
          null,
          JSON.stringify([[
            {
              id: 101,
              body: 'Fix the variable name',
              path: 'src/app.ts',
              line: 12,
              html_url: 'https://github.com/org/repo/pull/42#discussion_r1',
              created_at: '2026-04-03T10:00:00Z',
              updated_at: '2026-04-03T10:00:00Z',
              user: { login: 'reviewer1' },
            },
          ]]),
          '',
        );
      })
      .mockImplementationOnce((_file, _args, _opts, cb) => {
        cb(
          null,
          JSON.stringify([[
            {
              id: 202,
              body: 'Can we simplify the rollout plan too?',
              html_url: 'https://github.com/org/repo/pull/42#issuecomment-1',
              created_at: '2026-04-03T11:00:00Z',
              updated_at: '2026-04-03T11:00:00Z',
              user: { login: 'reviewer2' },
            },
          ]]),
          '',
        );
      });

    const { fetchPendingGithubReviewComments } = await import('./review-comments.js');
    const comments = await fetchPendingGithubReviewComments('https://github.com/org/repo/pull/42');

    expect(execFileMock).toHaveBeenCalledTimes(2);
    expect(execFileMock.mock.calls[0]?.[1]).toEqual(['api', 'repos/org/repo/pulls/42/comments', '--paginate', '--slurp']);
    expect(execFileMock.mock.calls[1]?.[1]).toEqual(['api', 'repos/org/repo/issues/42/comments', '--paginate', '--slurp']);
    expect(comments).toEqual([
      {
        id: 101,
        fingerprint: 'review:101:2026-04-03T10:00:00Z',
        kind: 'review',
        author: 'reviewer1',
        body: 'Fix the variable name',
        path: 'src/app.ts',
        line: 12,
        url: 'https://github.com/org/repo/pull/42#discussion_r1',
        created: '2026-04-03T10:00:00Z',
        updated: '2026-04-03T10:00:00Z',
      },
      {
        id: 202,
        fingerprint: 'conversation:202:2026-04-03T11:00:00Z',
        kind: 'conversation',
        author: 'reviewer2',
        body: 'Can we simplify the rollout plan too?',
        path: undefined,
        line: undefined,
        url: 'https://github.com/org/repo/pull/42#issuecomment-1',
        created: '2026-04-03T11:00:00Z',
        updated: '2026-04-03T11:00:00Z',
      },
    ]);
  });

  it('filters out handled fingerprints across both comment kinds', async () => {
    execFileMock
      .mockImplementationOnce((_file, _args, _opts, cb) => {
        cb(
          null,
          JSON.stringify([[
            {
              id: 101,
              body: 'Already handled review comment',
              created_at: '2026-04-03T10:00:00Z',
              updated_at: '2026-04-03T10:00:00Z',
              user: { login: 'reviewer1' },
            },
          ]]),
          '',
        );
      })
      .mockImplementationOnce((_file, _args, _opts, cb) => {
        cb(
          null,
          JSON.stringify([[
            {
              id: 202,
              body: 'New conversation comment',
              created_at: '2026-04-03T11:00:00Z',
              updated_at: '2026-04-03T11:00:00Z',
              user: { login: 'reviewer2' },
            },
          ]]),
          '',
        );
      });

    const { fetchPendingGithubReviewComments } = await import('./review-comments.js');
    const comments = await fetchPendingGithubReviewComments(
      'https://github.com/org/repo/pull/42',
      ['review:101:2026-04-03T10:00:00Z'],
    );

    expect(comments).toHaveLength(1);
    expect(comments[0]?.kind).toBe('conversation');
    expect(comments[0]?.fingerprint).toBe('conversation:202:2026-04-03T11:00:00Z');
  });
});
