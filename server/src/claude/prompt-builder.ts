import type { TaskInput } from './types.js';
import type { ServerConfig } from '../config/types.js';
import type { TaskMode } from '../state/types.js';

export const planFilePath = (key: string) => `/tmp/jiranimo-${key}-plan.md`;

export function buildPrompt(task: TaskInput, config: ServerConfig, repoPath: string, mode: TaskMode = 'implement'): string {
  const { branchPrefix, defaultBaseBranch, pushRemote, createDraftPr } = config.git;
  const taskJson = JSON.stringify(task, null, 2);
  const appendSection = config.claude.appendSystemPrompt ? `\n\n${config.claude.appendSystemPrompt}` : '';

  if (mode === 'plan') {
    return `You are creating a technical plan for a Jira task. Explore the repository to understand the codebase, then write a structured plan. Do NOT write any code or commit anything.

## Task
\`\`\`json
${taskJson}
\`\`\`

### Your Workspace & Planning Instructions

The repository is at: \`${repoPath}\`

**Step 1 - Create a worktree** for exploration:
\`\`\`
git -C ${repoPath} worktree add /tmp/jiranimo-${task.key} -b ${branchPrefix}${task.key}-plan origin/${defaultBaseBranch}
cd /tmp/jiranimo-${task.key}
\`\`\`
If \`origin/${defaultBaseBranch}\` does not exist, detect the actual default branch first:
\`git -C ${repoPath} remote show ${pushRemote} | grep 'HEAD branch'\`

**Step 2 - Write the plan** to \`${planFilePath(task.key)}\` — do NOT commit this file or anything else.

**Step 3 - Report back using the jiranimo MCP tools** (available as \`jiranimo_*\`):
- \`jiranimo_progress\` — send progress updates as you work (task_key="${task.key}")
- \`jiranimo_complete\` — when the plan file is written (task_key="${task.key}")
- \`jiranimo_fail\` — if you hit an unrecoverable error (task_key="${task.key}")

**Clean up the worktree**:
\`\`\`
git -C ${repoPath} worktree remove /tmp/jiranimo-${task.key}
\`\`\`${appendSection}`;
  }

  const prStep = createDraftPr
    ? `\n**Step 6 — Create a draft PR**:\n\`\`\`\ngh pr create --draft --title "[${task.key}] ${task.summary}" --body "Implements ${task.key}. Jira: ${task.jiraUrl}"\n\`\`\`\n`
    : '';

  return `You are implementing a Jira task as a software engineer. You have full access to the repository and must handle all git operations yourself.

## Task
\`\`\`json
${taskJson}
\`\`\`

### Your Workspace & Git Instructions

The repository you should work on is at: \`${repoPath}\`

**Step 1 - Create a worktree** for isolation:
\`\`\`
git -C ${repoPath} worktree add /tmp/jiranimo-${task.key} -b ${branchPrefix}${task.key}-<short-slug> origin/${defaultBaseBranch}
cd /tmp/jiranimo-${task.key}
\`\`\`
If \`origin/${defaultBaseBranch}\` does not exist, detect the actual default branch first:
\`git -C ${repoPath} remote show ${pushRemote} | grep 'HEAD branch'\`

**Step 2 - Implement** the changes described above. Write or update tests as appropriate and ensure they pass.

**Step 3 - Commit and push**:
\`\`\`
git add -A
git commit -m "<type>(${task.key}): <short description>"
git push -u ${pushRemote} <branch-name>
\`\`\`
Use conventional commit types: \`feat\` for features, \`fix\` for bugs, \`chore\` for other work.
${prStep}
**Step 4 - Report back using the jiranimo MCP tools** (available as \`jiranimo_*\`):
- \`jiranimo_progress\` — send progress updates as you work (task_key="${task.key}")
- \`jiranimo_report_pr\` — once the PR is created, report its url, number, and branch name (task_key="${task.key}")
- \`jiranimo_complete\` — when all work is done (task_key="${task.key}")
- \`jiranimo_fail\` — if you hit an unrecoverable error (task_key="${task.key}")

**Clean up the worktree**:
\`\`\`
git -C ${repoPath} worktree remove /tmp/jiranimo-${task.key}
\`\`\`${appendSection}`;
}
