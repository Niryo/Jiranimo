import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

export type RepoTarget =
  | { kind: 'single-repo'; repoPath: string }
  | { kind: 'repo-root'; reposRoot: string };

const USAGE = 'Usage: jiranimo <path-to-repo-or-repos>';

export function resolveStartupPath(
  argv = process.argv,
  launchDir = process.env.INIT_CWD ?? process.cwd(),
): string {
  const rawPath = argv[2]?.trim();

  if (!rawPath) {
    throw new Error(USAGE);
  }

  const resolvedPath = resolve(launchDir, rawPath);

  if (!existsSync(resolvedPath)) {
    throw new Error(`Path not found: ${resolvedPath}\n${USAGE}`);
  }

  const stats = statSync(resolvedPath);
  if (!stats.isDirectory()) {
    throw new Error(`Path must be a directory: ${resolvedPath}\n${USAGE}`);
  }

  return resolvedPath;
}

export function resolveRepoTarget(targetPath: string): RepoTarget {
  if (existsSync(join(targetPath, '.git'))) {
    return { kind: 'single-repo', repoPath: targetPath };
  }

  return { kind: 'repo-root', reposRoot: targetPath };
}
