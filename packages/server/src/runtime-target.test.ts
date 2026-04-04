import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveRepoTarget, resolveStartupPath } from './runtime-target.js';

describe('resolveStartupPath', () => {
  it('throws when the positional path argument is missing', () => {
    expect(() => resolveStartupPath(['node', 'src/index.ts'], '/work')).toThrow(
      'Usage: jiranimo <path-to-repo-or-repos>'
    );
  });

  it('resolves a relative path against the launch directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'jiranimo-runtime-target-'));
    const target = join(root, 'repos');
    mkdirSync(target);

    expect(resolveStartupPath(['node', 'src/index.ts', './repos'], root)).toBe(target);

    rmSync(root, { recursive: true, force: true });
  });

  it('accepts an absolute path unchanged', () => {
    const target = mkdtempSync(join(tmpdir(), 'jiranimo-runtime-target-'));

    expect(resolveStartupPath(['node', 'src/index.ts', target], '/unused')).toBe(target);

    rmSync(target, { recursive: true, force: true });
  });

  it('throws when the provided path does not exist', () => {
    expect(() => resolveStartupPath(['node', 'src/index.ts', '/does/not/exist'], '/work')).toThrow(
      'Path not found: /does/not/exist'
    );
  });
});

describe('resolveRepoTarget', () => {
  it('uses direct repo mode when the path itself is a git repository', () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'jiranimo-single-repo-'));
    mkdirSync(join(repoPath, '.git'));

    expect(resolveRepoTarget(repoPath)).toEqual({ kind: 'single-repo', repoPath });

    rmSync(repoPath, { recursive: true, force: true });
  });

  it('uses repo-root mode when the path contains repositories', () => {
    const reposRoot = mkdtempSync(join(tmpdir(), 'jiranimo-repo-root-'));
    const childRepo = join(reposRoot, 'app');
    mkdirSync(join(childRepo, '.git'), { recursive: true });
    writeFileSync(join(childRepo, 'package.json'), JSON.stringify({ name: 'app' }));

    expect(resolveRepoTarget(reposRoot)).toEqual({ kind: 'repo-root', reposRoot });

    rmSync(reposRoot, { recursive: true, force: true });
  });
});
