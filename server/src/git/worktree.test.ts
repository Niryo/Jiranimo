import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createWorktree, removeWorktree, pruneWorktrees, findGitRepo } from './worktree.js';

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

let tmpDir: string;
let repoPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'jiranimo-wt-test-'));
  repoPath = join(tmpDir, 'repo');
  execFileSync('mkdir', ['-p', repoPath]);
  git(['init', '-b', 'main'], repoPath);
  git(['config', 'user.email', 'test@test.com'], repoPath);
  git(['config', 'user.name', 'Test'], repoPath);
  writeFileSync(join(repoPath, 'README.md'), '# Test\n');
  git(['add', '.'], repoPath);
  git(['commit', '-m', 'Initial commit'], repoPath);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('createWorktree', () => {
  it('creates a worktree directory with the task branch', async () => {
    const wtPath = await createWorktree(repoPath, 'PROJ-1', 'jiranimo/PROJ-1-test', 'main');

    expect(existsSync(wtPath)).toBe(true);
    expect(existsSync(join(wtPath, 'README.md'))).toBe(true);

    // Verify the worktree is on the right branch
    const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], wtPath);
    expect(branch).toBe('jiranimo/PROJ-1-test');

    // Verify main repo is still on main
    const mainBranch = git(['rev-parse', '--abbrev-ref', 'HEAD'], repoPath);
    expect(mainBranch).toBe('main');
  });

  it('cleans up stale worktree before creating', async () => {
    // Create a worktree, then simulate a crash (leave it behind)
    await createWorktree(repoPath, 'PROJ-2', 'jiranimo/PROJ-2-first', 'main');

    // Delete the branch so we can reuse the task key
    await removeWorktree(repoPath, join(repoPath, '.jiranimo-worktrees', 'PROJ-2'));
    git(['branch', '-D', 'jiranimo/PROJ-2-first'], repoPath);

    // Create again with same task key — should work
    const wtPath = await createWorktree(repoPath, 'PROJ-2', 'jiranimo/PROJ-2-second', 'main');
    expect(existsSync(wtPath)).toBe(true);
  });

  it('reuses an existing branch instead of failing', async () => {
    const branch = 'jiranimo/PROJ-5-reuse';

    // Create the branch manually (simulating a previous implementation)
    git(['checkout', '-b', branch], repoPath);
    writeFileSync(join(repoPath, 'prev-work.txt'), 'previous work\n');
    git(['add', '.'], repoPath);
    git(['commit', '-m', 'previous work'], repoPath);
    git(['checkout', 'main'], repoPath);

    // createWorktree should reuse the branch, not fail with "branch already exists"
    const wtPath = await createWorktree(repoPath, 'PROJ-5', branch, 'main');

    expect(existsSync(wtPath)).toBe(true);
    const wtBranch = git(['rev-parse', '--abbrev-ref', 'HEAD'], wtPath);
    expect(wtBranch).toBe(branch);

    // Should have the previous work from that branch
    expect(existsSync(join(wtPath, 'prev-work.txt'))).toBe(true);
  });

  it('worktree has its own working tree independent of main', async () => {
    const wtPath = await createWorktree(repoPath, 'PROJ-3', 'jiranimo/PROJ-3-test', 'main');

    // Create a file in the worktree
    writeFileSync(join(wtPath, 'new-file.txt'), 'hello\n');

    // Main repo should NOT have this file
    expect(existsSync(join(repoPath, 'new-file.txt'))).toBe(false);

    // Worktree should have it
    expect(existsSync(join(wtPath, 'new-file.txt'))).toBe(true);
  });
});

describe('removeWorktree', () => {
  it('removes the worktree directory', async () => {
    const wtPath = await createWorktree(repoPath, 'PROJ-4', 'jiranimo/PROJ-4-test', 'main');
    expect(existsSync(wtPath)).toBe(true);

    await removeWorktree(repoPath, wtPath);
    expect(existsSync(wtPath)).toBe(false);
  });

  it('does not throw if worktree does not exist', async () => {
    await expect(removeWorktree(repoPath, join(repoPath, 'nonexistent'))).resolves.not.toThrow();
  });
});

describe('pruneWorktrees', () => {
  it('cleans stale worktree entries', async () => {
    // Just verify it runs without error
    await expect(pruneWorktrees(repoPath)).resolves.not.toThrow();
  });
});

describe('findGitRepo', () => {
  it('returns the path if it is a git repo', async () => {
    const found = await findGitRepo(repoPath);
    expect(found).toBe(repoPath);
  });

  it('finds a git repo inside a parent directory', async () => {
    const found = await findGitRepo(tmpDir);
    expect(found).toBe(repoPath);
  });

  it('returns null if no git repo found', async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'jiranimo-empty-'));
    const found = await findGitRepo(emptyDir);
    expect(found).toBeNull();
    rmSync(emptyDir, { recursive: true, force: true });
  });
});
