import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

const exec = promisify(execFile);

const WORKTREE_DIR = '.jiranimo-worktrees';

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await exec('git', args, { cwd });
  return stdout.trim();
}

/**
 * Check if a ref (branch, remote ref, etc.) exists.
 */
async function refExists(repoPath: string, ref: string): Promise<boolean> {
  return git(['rev-parse', '--verify', ref], repoPath)
    .then(() => true)
    .catch(() => false);
}

/**
 * Resolve the best start point for a new branch.
 * Tries in order: remote/baseBranch, local baseBranch, HEAD.
 */
async function resolveStartPoint(
  repoPath: string,
  baseBranch: string,
  remote: string | undefined,
  hasRemote: boolean,
): Promise<string> {
  if (hasRemote && remote) {
    const remoteRef = `${remote}/${baseBranch}`;
    if (await refExists(repoPath, remoteRef)) return remoteRef;
  }
  if (await refExists(repoPath, baseBranch)) return baseBranch;
  // Last resort: use whatever HEAD points to
  return 'HEAD';
}

/**
 * Create a git worktree for a task.
 * Returns the absolute path to the worktree directory.
 *
 * If the branch already exists (e.g. re-implementing a ticket),
 * the worktree is created from the existing branch instead of making a new one.
 */
export async function createWorktree(
  repoPath: string,
  taskKey: string,
  branchName: string,
  baseBranch: string,
  remote?: string,
): Promise<string> {
  const worktreePath = join(repoPath, WORKTREE_DIR, taskKey);

  // Clean up stale worktree if it exists from a previous crash
  if (existsSync(worktreePath)) {
    await removeWorktree(repoPath, worktreePath).catch(() => {});
  }

  // Fetch latest from remote if available
  const hasRemote = await git(['remote'], repoPath).then(r => r.length > 0).catch(() => false);
  if (hasRemote && remote) {
    await git(['fetch', remote], repoPath).catch(() => {});
  }

  // If the branch already exists, reuse it; otherwise create a new one
  if (await refExists(repoPath, branchName)) {
    await git(['worktree', 'add', worktreePath, branchName], repoPath);
    // Pull latest changes so we start from an up-to-date branch
    if (hasRemote && remote) {
      await git(['pull', remote, branchName], worktreePath).catch(() => {});
    }
  } else {
    const startPoint = await resolveStartPoint(repoPath, baseBranch, remote, hasRemote);
    await git(['worktree', 'add', worktreePath, '-b', branchName, startPoint], repoPath);
  }

  return worktreePath;
}

/**
 * Remove a worktree and its branch.
 */
export async function removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
  try {
    await git(['worktree', 'remove', worktreePath, '--force'], repoPath);
  } catch {
    // If remove fails, try pruning
    await git(['worktree', 'prune'], repoPath).catch(() => {});
  }
}

/**
 * Clean up stale worktree entries (e.g., after crashes).
 * Call on server startup.
 */
export async function pruneWorktrees(repoPath: string): Promise<void> {
  await git(['worktree', 'prune'], repoPath).catch(() => {});
}

/**
 * Find the first git repository inside a directory.
 * A directory is a git repo if it contains a `.git` directory (not just being inside one).
 */
export async function findGitRepo(rootPath: string): Promise<string | null> {
  // Check if rootPath itself has a .git directory
  if (existsSync(join(rootPath, '.git'))) {
    return rootPath;
  }

  // Scan subdirectories for a .git directory
  const { readdirSync } = await import('node:fs');
  for (const entry of readdirSync(rootPath, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const subPath = join(rootPath, entry.name);
    if (existsSync(join(subPath, '.git'))) {
      return subPath;
    }
  }

  return null;
}
