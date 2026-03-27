import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'jiranimo-git-test-'));
  git(['init'], tmpDir);
  git(['config', 'user.email', 'test@test.com'], tmpDir);
  git(['config', 'user.name', 'Test'], tmpDir);
  // Create initial commit
  writeFileSync(join(tmpDir, 'README.md'), '# Test\n');
  git(['add', '.'], tmpDir);
  git(['commit', '-m', 'Initial commit'], tmpDir);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('git operations on temp repo', () => {
  it('creates a branch', () => {
    git(['checkout', '-b', 'jiranimo/PROJ-1-test-branch'], tmpDir);
    const branches = git(['branch', '--list'], tmpDir);
    expect(branches).toContain('jiranimo/PROJ-1-test-branch');
  });

  it('commits changes', () => {
    git(['checkout', '-b', 'jiranimo/PROJ-1-test'], tmpDir);
    writeFileSync(join(tmpDir, 'feature.ts'), 'export const x = 1;\n');
    git(['add', '.'], tmpDir);
    git(['commit', '-m', 'feat(PROJ-1): Add feature'], tmpDir);

    const log = git(['log', '--oneline', '-1'], tmpDir);
    expect(log).toContain('feat(PROJ-1): Add feature');
  });

  it('branch exists after checkout', () => {
    git(['checkout', '-b', 'test-branch'], tmpDir);
    const current = git(['rev-parse', '--abbrev-ref', 'HEAD'], tmpDir);
    expect(current).toBe('test-branch');
  });

  it('commit includes all staged files', () => {
    git(['checkout', '-b', 'jiranimo/PROJ-2-multi'], tmpDir);
    writeFileSync(join(tmpDir, 'a.ts'), 'const a = 1;\n');
    writeFileSync(join(tmpDir, 'b.ts'), 'const b = 2;\n');
    git(['add', '-A'], tmpDir);
    git(['commit', '-m', 'chore(PROJ-2): Add files'], tmpDir);

    const files = git(['diff', '--name-only', 'HEAD~1', 'HEAD'], tmpDir);
    expect(files).toContain('a.ts');
    expect(files).toContain('b.ts');
  });
});
