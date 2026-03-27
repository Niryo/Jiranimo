import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GitConfig } from '../config/types.js';

const exec = promisify(execFile);

export function slugify(text: string, maxLength = 40): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, maxLength)
    .replace(/-$/, '');
}

export function branchName(prefix: string, issueKey: string, summary: string): string {
  const slug = slugify(summary);
  const rid = Math.random().toString(36).substring(2, 5);
  return `${prefix}${issueKey}-${slug}-${rid}`;
}

export function commitType(issueType: string): string {
  const lower = issueType.toLowerCase();
  if (lower === 'bug') return 'fix';
  if (lower === 'story' || lower === 'feature') return 'feat';
  return 'chore';
}

export function commitMessage(issueKey: string, summary: string, issueType: string): string {
  return `${commitType(issueType)}(${issueKey}): ${summary}`;
}

async function git(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await exec('git', args, { cwd });
    return stdout.trim();
  } catch (err: unknown) {
    const e = err as { stderr?: string; message: string };
    const stderr = e.stderr?.trim();
    throw new Error(stderr || e.message);
  }
}

export async function setupBranch(
  cwd: string,
  issueKey: string,
  summary: string,
  config: GitConfig,
  baseBranchOverride?: string,
): Promise<string> {
  const base = baseBranchOverride ?? config.defaultBaseBranch;
  const branch = branchName(config.branchPrefix, issueKey, summary);

  // Try to fetch from remote — skip gracefully if no remote exists
  const hasRemote = await git(['remote'], cwd).then(r => r.length > 0).catch(() => false);
  if (hasRemote) {
    await git(['fetch', config.pushRemote], cwd);
  }

  await git(['checkout', base], cwd);

  if (hasRemote) {
    await git(['pull', config.pushRemote, base], cwd).catch(() => {
      // Pull may fail if remote branch doesn't exist yet — that's ok
    });
  }

  await git(['checkout', '-b', branch], cwd);

  return branch;
}


export async function commitAndPush(
  cwd: string,
  branch: string,
  issueKey: string,
  summary: string,
  issueType: string,
  jiraUrl: string,
  remote: string,
): Promise<void> {
  await git(['add', '-A'], cwd);

  const msg = `${commitMessage(issueKey, summary, issueType)}\n\nImplemented by Jiranimo + Claude Code\nJira: ${jiraUrl}`;
  await git(['commit', '-m', msg], cwd);

  // Push only if remote exists
  const hasRemote = await git(['remote'], cwd).then(r => r.length > 0).catch(() => false);
  if (hasRemote) {
    await git(['push', '-u', remote, branch], cwd);
  }
}
