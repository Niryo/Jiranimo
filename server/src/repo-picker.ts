import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { executeClaudeCode } from './claude/executor.js';

interface TaskSummary {
  key: string;
  summary: string;
  description?: string;
}

function listRepos(reposRoot: string): Array<{ name: string; hint: string }> {
  const entries = readdirSync(reposRoot, { withFileTypes: true });
  const repos: Array<{ name: string; hint: string }> = [];

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

    repos.push({ name: entry.name, hint });
  }

  return repos;
}

export async function pickRepo(reposRoot: string, task: TaskSummary): Promise<string> {
  const repos = listRepos(reposRoot);

  if (repos.length === 0) {
    throw new Error(`No git repositories found in ${reposRoot}`);
  }

  if (repos.length === 1) {
    return join(reposRoot, repos[0].name);
  }

  const repoList = repos.map(r => `- ${r.hint}`).join('\n');
  const description = task.description ? task.description.slice(0, 500) : '';

  const prompt = `Given this Jira task, which repository should be modified? Respond with ONLY the repository directory name, exactly as it appears in the list below (preserve capitalization), nothing else.

Task: ${task.key} - ${task.summary}
${description ? `\nDescription: ${description}` : ''}

Available repositories:
${repoList}`;

  const result = await executeClaudeCode({
    prompt,
    cwd: tmpdir(),
    config: { model: 'claude-haiku-4-5-20251001' },
  });

  if (!result.success || !result.resultText) {
    throw new Error(`Repo discovery failed: ${result.resultText ?? 'no response'}`);
  }

  const rawName = result.resultText.trim();
  // Strip any path separators or leading dashes Claude might include
  const repoName = rawName.replace(/^[-\s]+/, '').split(/[\s/]/)[0];

  const matched = repos.find(r => r.name === repoName);
  if (!matched) {
    throw new Error(
      `Repo discovery returned "${rawName}" which does not match any repository in ${reposRoot}. Available: ${repos.map(r => r.name).join(', ')}`
    );
  }

  return join(reposRoot, matched.name);
}
