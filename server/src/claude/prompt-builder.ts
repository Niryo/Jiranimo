import type { TaskInput } from './types.js';
import type { ServerConfig } from '../config/types.js';

export function buildPrompt(task: TaskInput, config: ServerConfig, repoPath: string): string {
  const sections: string[] = [];

  sections.push(
    `You are implementing a Jira task as a software engineer. You have full access to the repository and must handle all git operations yourself.`
  );

  sections.push(`## Task\n\`\`\`json\n${JSON.stringify(task, null, 2)}\n\`\`\``);

  // Git + MCP instructions
  const { branchPrefix, defaultBaseBranch, pushRemote, createDraftPr } = config.git;
  const prStep = createDraftPr ? `
**Step 6 — Create a draft PR**:
\`\`\`
gh pr create --draft --title "[${task.key}] ${task.summary}" --body "Implements ${task.key}. Jira: ${task.jiraUrl}"
\`\`\`
` : '';

  sections.push(`### Your Workspace & Git Instructions

The repository you should work on is at: \`${repoPath}\`

Complete these steps in order:

**Step 1 — Create a worktree** for isolation:
\`\`\`
git -C ${repoPath} worktree add /tmp/jiranimo-${task.key} -b ${branchPrefix}${task.key}-<short-slug> origin/${defaultBaseBranch}
cd /tmp/jiranimo-${task.key}
\`\`\`
If \`origin/${defaultBaseBranch}\` does not exist, detect the actual default branch first:
\`git -C ${repoPath} remote show ${pushRemote} | grep 'HEAD branch'\`

**Step 2 — Understand the codebase** — read the structure, patterns, and conventions before writing any code.

**Step 3 — Implement** the changes described above, following existing code style.

**Step 4 — Write or update tests** as appropriate and ensure they pass.

**Step 5 — Commit and push**:
\`\`\`
git add -A
git commit -m "<type>(${task.key}): <short description>"
git push -u ${pushRemote} <branch-name>
\`\`\`
Use conventional commit types: \`feat\` for features, \`fix\` for bugs, \`chore\` for other work.
${prStep}
**Step 7 — Report back using the jiranimo MCP tools** (available as \`jiranimo_*\`):
- \`jiranimo_progress\` — send progress updates as you work (task_key="${task.key}")
- \`jiranimo_report_pr\` — once the PR is created, report its url, number, and branch name (task_key="${task.key}")
- \`jiranimo_complete\` — when all work is done (task_key="${task.key}")
- \`jiranimo_fail\` — if you hit an unrecoverable error (task_key="${task.key}")

**Step 8 — Clean up the worktree**:
\`\`\`
git -C ${repoPath} worktree remove /tmp/jiranimo-${task.key}
\`\`\``);

  if (config.claude.appendSystemPrompt) {
    sections.push(config.claude.appendSystemPrompt);
  }

  return sections.join('\n\n');
}
