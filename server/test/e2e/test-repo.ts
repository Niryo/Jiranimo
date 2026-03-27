/**
 * Creates and manages a temporary git repo for E2E pipeline tests.
 * The repo is a real git repo with an initial commit, used as the
 * working directory for Claude Code (or fake-claude) during tests.
 */

import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

export interface TestRepo {
  path: string;
  git: (...args: string[]) => string;
  readFile: (relativePath: string) => string;
  fileExists: (relativePath: string) => boolean;
  listFiles: () => string[];
  cleanup: () => void;
}

/**
 * Create a fresh git repo with a basic project structure.
 * Returns helpers for interacting with it.
 */
export function createTestRepo(): TestRepo {
  const repoPath = mkdtempSync(join(tmpdir(), 'jiranimo-e2e-repo-'));

  function git(...args: string[]): string {
    return execFileSync('git', args, { cwd: repoPath, encoding: 'utf-8' }).trim();
  }

  // Initialize repo with 'main' as default branch
  git('init', '-b', 'main');
  git('config', 'user.email', 'test@jiranimo.dev');
  git('config', 'user.name', 'Jiranimo Test');

  // Create a basic project structure
  writeFileSync(join(repoPath, 'README.md'), '# Test Project\n\nA test project for Jiranimo E2E tests.\n');
  mkdirSync(join(repoPath, 'src'), { recursive: true });
  writeFileSync(join(repoPath, 'src', 'index.ts'), 'console.log("hello");\n');
  writeFileSync(join(repoPath, 'package.json'), JSON.stringify({ name: 'test-project', version: '1.0.0' }, null, 2) + '\n');

  git('add', '-A');
  git('commit', '-m', 'Initial commit');

  return {
    path: repoPath,
    git,
    readFile: (relativePath: string) => readFileSync(join(repoPath, relativePath), 'utf-8'),
    fileExists: (relativePath: string) => existsSync(join(repoPath, relativePath)),
    listFiles: () => {
      const result: string[] = [];
      function walk(dir: string, prefix = '') {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (entry.name === '.git') continue;
          const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.isDirectory()) walk(join(dir, entry.name), rel);
          else result.push(rel);
        }
      }
      walk(repoPath);
      return result;
    },
    cleanup: () => rmSync(repoPath, { recursive: true, force: true }),
  };
}
