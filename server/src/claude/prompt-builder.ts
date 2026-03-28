import type { TaskInput } from './types.js';
import type { ServerConfig } from '../config/types.js';

const MAX_DESCRIPTION_LENGTH = 10_000;
const MAX_COMMENTS = 10;

export function buildPrompt(task: TaskInput, config: ServerConfig, repoPath: string): string {
  const sections: string[] = [];

  sections.push(
    `You are implementing a Jira task as a software engineer. You have full access to the repository and must handle all git operations yourself.`
  );
  sections.push(`## Task: ${task.key} - ${task.summary}`);

  // Description
  let description = task.description || 'No description provided.';
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    description = description.slice(0, MAX_DESCRIPTION_LENGTH) + '\n\n... (description truncated)';
  }
  sections.push(`### Description\n${description}`);

  // Acceptance criteria
  if (task.acceptanceCriteria) {
    sections.push(`### Acceptance Criteria\n${task.acceptanceCriteria}`);
  }

  // Subtasks
  if (task.subtasks && task.subtasks.length > 0) {
    const lines = task.subtasks.map(s => `- [${s.status === 'Done' ? 'x' : ' '}] ${s.key}: ${s.summary} (${s.status})`);
    sections.push(`### Subtasks\n${lines.join('\n')}`);
  }

  // Linked issues
  if (task.linkedIssues && task.linkedIssues.length > 0) {
    const lines = task.linkedIssues.map(l => `- ${l.type}: ${l.key} — ${l.summary} (${l.status})`);
    sections.push(`### Linked Issues\n${lines.join('\n')}`);
  }

  // Parent issue
  if (task.parentKey) {
    sections.push(`### Parent Issue\n${task.parentKey}`);
  }

  // Comments
  if (task.comments.length > 0) {
    const recent = task.comments.slice(-MAX_COMMENTS);
    const commentLines = recent.map(c => {
      const date = c.created ? ` (${new Date(c.created).toLocaleDateString()})` : '';
      return `**${c.author}**${date}: ${c.body}`;
    }).join('\n\n');
    sections.push(`### Recent Comments\n${commentLines}`);
  }

  // Attachments
  if (task.attachments && task.attachments.length > 0) {
    const lines = task.attachments.map(a => `- ${a.filename} (${a.mimeType})`);
    sections.push(`### Attachments\n${lines.join('\n')}`);
  }

  // Metadata
  const metaLines = [
    `- Priority: ${task.priority}`,
    `- Type: ${task.issueType}`,
    `- Labels: ${task.labels.join(', ') || 'none'}`,
  ];
  if (task.assignee) metaLines.push(`- Assignee: ${task.assignee}`);
  if (task.reporter) metaLines.push(`- Reporter: ${task.reporter}`);
  if (task.components && task.components.length > 0) metaLines.push(`- Components: ${task.components.join(', ')}`);
  metaLines.push(`- Jira: ${task.jiraUrl}`);
  sections.push(`### Metadata\n${metaLines.join('\n')}`);

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
