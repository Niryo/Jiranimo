import { execFile } from 'node:child_process';
import type { GithubReviewCommentRecord } from '../state/types.js';

const GH_API_MAX_BUFFER = 10 * 1024 * 1024;

interface PullRequestRef {
  owner: string;
  repo: string;
  prNumber: number;
}

interface RawPullRequestReviewComment {
  id?: number;
  body?: string;
  path?: string;
  line?: number;
  original_line?: number;
  html_url?: string;
  created_at?: string;
  updated_at?: string;
  user?: {
    login?: string;
  };
}

interface RawIssueComment {
  id?: number;
  body?: string;
  html_url?: string;
  created_at?: string;
  updated_at?: string;
  user?: {
    login?: string;
  };
}

function parsePullRequestUrl(prUrl: string): PullRequestRef {
  let url: URL;
  try {
    url = new URL(prUrl);
  } catch {
    throw new Error(`Invalid PR URL: ${prUrl}`);
  }

  const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/|$)/);
  if (!match) {
    throw new Error(`Unsupported PR URL: ${prUrl}`);
  }

  return {
    owner: match[1],
    repo: match[2],
    prNumber: Number(match[3]),
  };
}

function fingerprintForComment(
  kind: GithubReviewCommentRecord['kind'],
  comment: Pick<RawPullRequestReviewComment, 'id' | 'updated_at' | 'created_at'>,
): string | undefined {
  if (typeof comment.id !== 'number') {
    return undefined;
  }
  const timestamp = comment.updated_at ?? comment.created_at;
  return timestamp ? `${kind}:${comment.id}:${timestamp}` : undefined;
}

function toGithubReviewCommentRecord(comment: RawPullRequestReviewComment): GithubReviewCommentRecord | undefined {
  if (typeof comment.id !== 'number' || typeof comment.body !== 'string' || comment.body.trim().length === 0) {
    return undefined;
  }

  const fingerprint = fingerprintForComment('review', comment);
  if (!fingerprint) {
    return undefined;
  }

  return {
    id: comment.id,
    fingerprint,
    kind: 'review',
    author: comment.user?.login || 'unknown',
    body: comment.body,
    path: typeof comment.path === 'string' ? comment.path : undefined,
    line: typeof comment.line === 'number'
      ? comment.line
      : (typeof comment.original_line === 'number' ? comment.original_line : undefined),
    url: typeof comment.html_url === 'string' ? comment.html_url : undefined,
    created: typeof comment.created_at === 'string' ? comment.created_at : undefined,
    updated: typeof comment.updated_at === 'string' ? comment.updated_at : undefined,
  };
}

function toGithubConversationCommentRecord(comment: RawIssueComment): GithubReviewCommentRecord | undefined {
  if (typeof comment.id !== 'number' || typeof comment.body !== 'string' || comment.body.trim().length === 0) {
    return undefined;
  }

  const fingerprint = fingerprintForComment('conversation', comment);
  if (!fingerprint) {
    return undefined;
  }

  return {
    id: comment.id,
    fingerprint,
    kind: 'conversation',
    author: comment.user?.login || 'unknown',
    body: comment.body,
    url: typeof comment.html_url === 'string' ? comment.html_url : undefined,
    created: typeof comment.created_at === 'string' ? comment.created_at : undefined,
    updated: typeof comment.updated_at === 'string' ? comment.updated_at : undefined,
  };
}

async function fetchPaginatedGhApi<T>(path: string): Promise<T[]> {
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(
      'gh',
      ['api', path, '--paginate', '--slurp'],
      { maxBuffer: GH_API_MAX_BUFFER },
      (error, resultStdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(resultStdout);
      },
    );
  });

  const parsed = JSON.parse(stdout) as unknown;
  const pages = Array.isArray(parsed) ? parsed : [];
  return pages.flatMap(page => Array.isArray(page) ? page as T[] : []);
}

export async function fetchPendingGithubReviewComments(
  prUrl: string,
  handledFingerprints: string[] = [],
): Promise<GithubReviewCommentRecord[]> {
  const { owner, repo, prNumber } = parsePullRequestUrl(prUrl);
  const handled = new Set(handledFingerprints);

  const [reviewComments, conversationComments] = await Promise.all([
    fetchPaginatedGhApi<RawPullRequestReviewComment>(`repos/${owner}/${repo}/pulls/${prNumber}/comments`),
    fetchPaginatedGhApi<RawIssueComment>(`repos/${owner}/${repo}/issues/${prNumber}/comments`),
  ]);

  return [...reviewComments.map(toGithubReviewCommentRecord), ...conversationComments.map(toGithubConversationCommentRecord)]
    .filter((comment): comment is GithubReviewCommentRecord => !!comment && !handled.has(comment.fingerprint))
    .sort((a, b) => {
      const left = a.updated ?? a.created ?? '';
      const right = b.updated ?? b.created ?? '';
      return left.localeCompare(right);
    });
}
