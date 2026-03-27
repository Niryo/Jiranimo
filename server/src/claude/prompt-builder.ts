import type { TaskInput } from './types.js';

const MAX_DESCRIPTION_LENGTH = 10_000;
const MAX_COMMENTS = 10;

export function buildPrompt(task: TaskInput, appendPrompt?: string): string {
  const sections: string[] = [];

  sections.push(`You are implementing a Jira task. Your working directory contains one or more git repositories. Find the correct project, navigate into it, and implement the task.`);
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

  // Instructions
  sections.push(`### Instructions
1. Look at the available projects in the current directory and identify the correct one for this task.
2. Navigate into the correct project directory.
3. Create a new git branch for this task (e.g. jiranimo/${task.key}-short-description).
4. Read the codebase to understand the existing architecture, patterns, and conventions.
5. Implement the changes described above, following existing code style.
6. Write or update tests as appropriate.
7. Ensure the code compiles and lints cleanly.
8. Commit your changes with a descriptive message referencing ${task.key}.
9. Push the branch if a remote is configured.`);

  if (appendPrompt) {
    sections.push(appendPrompt);
  }

  return sections.join('\n\n');
}
