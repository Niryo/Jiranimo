import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { executeClaudeCode } from './claude/executor.js';
import type { ClaudeConfig } from './config/types.js';

interface TaskSummary {
  key: string;
  summary: string;
  description?: string;
}

export interface RepoCandidate {
  name: string;
  hint: string;
  path: string;
  readme?: string;
}

export function listRepos(reposRoot: string): RepoCandidate[] {
  const entries = readdirSync(reposRoot, { withFileTypes: true });
  const repos: RepoCandidate[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const repoPath = join(reposRoot, entry.name);
    if (!existsSync(join(repoPath, '.git'))) continue;

    let hint = entry.name;
    const pkgPath = join(repoPath, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { name?: string; description?: string };
        const extra = pkg.description || pkg.name;
        if (extra && extra !== entry.name) hint = `${entry.name} — ${extra}`;
      } catch {
        // ignore malformed package.json
      }
    }

    let readme: string | undefined;
    for (const readmeName of ['README.md', 'README.MD', 'readme.md', 'README']) {
      const readmePath = join(repoPath, readmeName);
      if (existsSync(readmePath)) {
        try {
          readme = readFileSync(readmePath, 'utf-8').slice(0, 2000);
        } catch {
          // ignore unreadable readme
        }
        break;
      }
    }

    repos.push({ name: entry.name, hint, path: repoPath, readme });
  }

  return repos;
}

function normalizeRepoName(rawName: string): string {
  return rawName.replace(/^[-\s]+/, '').split(/[\s/]/)[0];
}

export async function pickRepo(reposRoot: string, task: TaskSummary, claudeConfig?: ClaudeConfig): Promise<string> {
  const repos = listRepos(reposRoot);

  if (repos.length === 0) {
    throw new Error(`No git repositories found in ${reposRoot}`);
  }

  if (repos.length === 1) {
    return repos[0].path;
  }

  const repoList = repos
    .map(r => {
      let entry = `- ${r.hint}`;
      if (r.readme) entry += `\n  README:\n${r.readme.split('\n').map(l => `    ${l}`).join('\n')}`;
      return entry;
    })
    .join('\n\n');
  const description = task.description ? task.description.slice(0, 500) : '';

  const prompt = `Given this Jira task, which repository should be modified? Respond with ONLY the repository directory name, exactly as it appears in the list below (preserve capitalization), nothing else.

Task: ${task.key} - ${task.summary}
${description ? `\nDescription: ${description}` : ''}

Available repositories:
${repoList}`;

  const result = await executeClaudeCode({
    prompt,
    cwd: tmpdir(),
    config: { ...claudeConfig, model: 'claude-sonnet-4-6' },
  });

  if (!result.success || !result.resultText) {
    throw new Error(`Repo discovery failed: ${result.resultText ?? 'no response'}`);
  }

  const rawName = result.resultText.trim();
  const repoName = normalizeRepoName(rawName);

  const matched = repos.find(r => r.name === repoName);
  if (!matched) {
    throw new Error(
      `Repo discovery returned "${rawName}" which does not match any repository in ${reposRoot}. Available: ${repos.map(r => r.name).join(', ')}`
    );
  }

  return matched.path;
}
