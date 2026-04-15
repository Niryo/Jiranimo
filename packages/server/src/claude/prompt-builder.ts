import type { ServerConfig } from '../config/types.js';
import type { GithubReviewCommentRecord, TaskMode } from '../state/types.js';

interface PromptTask {
  key: string;
  summary: string;
  description: string;
  acceptanceCriteria?: string;
  priority: string;
  issueType: string;
  labels: string[];
  comments: Array<{ author: string; body: string; created?: string }>;
  githubReviewComments?: GithubReviewCommentRecord[];
  subtasks?: Array<{ key: string; summary: string; status: string }>;
  linkedIssues?: Array<{ type: string; key: string; summary: string; status: string }>;
  attachments?: Array<{ filename: string; mimeType: string; url: string }>;
  assignee?: string;
  reporter?: string;
  components?: string[];
  parentKey?: string;
  jiraUrl: string;
  branchName?: string;
  prUrl?: string;
  prNumber?: number;
  previousTaskMode?: TaskMode;
  planContent?: string;
}

export const planFilePath = (key: string) => `/tmp/jiranimo-${key}-plan.md`;

function toPromptContext(task: PromptTask): Record<string, unknown> {
  const ctx: Record<string, unknown> = {
    key: task.key,
    summary: task.summary,
    description: task.description,
    issueType: task.issueType,
    priority: task.priority,
    jiraUrl: task.jiraUrl,
  };

  if (task.acceptanceCriteria) ctx.acceptanceCriteria = task.acceptanceCriteria;
  if (task.labels?.length) ctx.labels = task.labels;
  if (task.components?.length) ctx.components = task.components;
  if (task.comments?.length) ctx.comments = task.comments;
  if (task.githubReviewComments?.length) ctx.githubReviewComments = task.githubReviewComments;
  if (task.subtasks?.length) ctx.subtasks = task.subtasks;
  if (task.linkedIssues?.length) ctx.linkedIssues = task.linkedIssues;
  if (task.attachments?.length) ctx.attachments = task.attachments;
  if (task.parentKey) ctx.parentKey = task.parentKey;
  if (task.assignee) ctx.assignee = task.assignee;
  if (task.reporter) ctx.reporter = task.reporter;

  return ctx;
}

interface ScreenshotContext {
  prUrl: string;
  prNumber: number;
  branchName: string;
}

interface RecoveryContext {
  wasInterrupted: boolean;
  resumeMode: 'claude-session' | 'fresh-recovery';
  worktreePath?: string;
  workspacePath?: string;
  branchName?: string;
  prUrl?: string;
  logPath?: string;
}

export function buildPrompt(
  task: PromptTask,
  config: ServerConfig,
  repoPath: string,
  mode: TaskMode = 'implement',
  screenshotContext?: ScreenshotContext,
  recoveryContext?: RecoveryContext,
): string {
  const { branchPrefix, defaultBaseBranch, pushRemote, createDraftPr } = config.git;
  const taskJson = JSON.stringify(toPromptContext(task), null, 2);
  const appendSection = config.claude.appendSystemPrompt ? `\n\n${config.claude.appendSystemPrompt}` : '';
  const worktreePath = recoveryContext?.worktreePath ?? `/tmp/jiranimo-${task.key}`;
  const existingPlanSection = task.planContent?.trim()
    ? `

### Existing Technical Plan
${mode === 'implement'
    ? 'A previous Jiranimo planning run produced the plan below. Treat it as your implementation baseline unless newer Jira comments clearly supersede it.'
    : 'A previous Jiranimo planning run produced the plan below. Refine or replace it only as needed based on the latest Jira comments.'}
\`\`\`md
${task.planContent.trim()}
\`\`\``
    : '';
  const recoverySection = recoveryContext?.wasInterrupted
    ? `

### Recovery Context
- The previous run was interrupted and you are resuming work.
- Resume mode: \`${recoveryContext.resumeMode}\`
- Worktree path: \`${worktreePath}\`
- Claude workspace path: \`${recoveryContext.workspacePath ?? 'unknown'}\`
- Previous branch: \`${recoveryContext.branchName ?? 'unknown'}\`
- Existing PR: ${recoveryContext.prUrl ?? 'none'}
- Previous log path: \`${recoveryContext.logPath ?? 'unknown'}\`

Before making any further changes, inspect the current repo state carefully:
- Run \`git -C ${worktreePath} status\`
- Review changed files and diffs
- Inspect recent commits if any exist
- Review the existing PR if one already exists
- Use the restored Claude conversation history if available, but still verify the filesystem before acting
`
    : '';

  if (mode === 'screenshot' && screenshotContext) {
    const { prUrl, prNumber, branchName } = screenshotContext;
    return `You are adding a screenshot to a completed PR. The implementation is already done — do not change any code.

## Task
\`\`\`json
${taskJson}
\`\`\`${existingPlanSection}

### Context
- Branch: \`${branchName}\`
- PR: ${prUrl}

The Jira comments in the task above contain instructions on how to screenshot this feature. Read the most recent comment that mentions "screenshot" and follow those instructions exactly.

**Step 1 - Check out the branch** (read-only, no new commits needed):
\`\`\`
git -C ${repoPath} worktree add ${worktreePath} ${branchName}
cd ${worktreePath}
\`\`\`

**Step 2 - Take the screenshot** following the instructions in the Jira comments.
- Save the screenshot to \`/tmp/jiranimo-${task.key}-screenshot.png\`
- Do NOT create a fake page — use the real running application
- Do not use GUI app launchers (\`open\`, \`osascript\`, \`xdg-open\`)

**Step 3 - Embed in the PR description**:
\`\`\`bash
SCREENSHOT_B64=$(base64 -i /tmp/jiranimo-${task.key}-screenshot.png | tr -d '\\n')
CURRENT_BODY=$(gh pr view ${prNumber} --json body --jq '.body')
gh pr edit ${prNumber} --body "\${CURRENT_BODY}

data:image/png;base64,\${SCREENSHOT_B64}"
\`\`\`

**Step 4 - Report back**:
- \`jiranimo_complete\` — once the screenshot is posted (task_key="${task.key}")
- \`jiranimo_fail\` — only if you truly cannot take the screenshot (task_key="${task.key}")

**Clean up the worktree**:
\`\`\`
git -C ${repoPath} worktree remove ${worktreePath}
\`\`\`${appendSection}`;
  }

  if (mode === 'fix-comments' && screenshotContext) {
    const { prUrl, prNumber, branchName } = screenshotContext;
    return `You are updating an existing PR to address new GitHub PR comments. Do not create a new branch or a new PR.

## Task
\`\`\`json
${taskJson}
\`\`\`${recoverySection}
${existingPlanSection}

### Context
- Branch: \`${branchName}\`
- PR: ${prUrl}

The task JSON may include \`githubReviewComments\`. Those are the new GitHub PR comments that have not been fixed yet, including both inline code review comments and general PR conversation comments. Address every one of them in this run.

**Step 1 - Check out the existing branch**:
\`\`\`bash
if [ ! -d "${worktreePath}" ]; then
  git -C ${repoPath} worktree add ${worktreePath} ${branchName}
fi
cd ${worktreePath}
\`\`\`

**Step 2 - Review the PR feedback and implement the fixes**:
- Use the \`githubReviewComments\` entries in the task JSON as your source of truth for what needs fixing
- Inspect the current PR state with \`gh pr view ${prNumber} --comments\`
- Make the smallest correct set of code and test changes needed to address the comments
- Keep the existing branch and PR; do not open a replacement PR

**Step 3 - Run verification**:
- Run the relevant tests for the changed area
- If there are no focused tests, run the smallest meaningful validation you can explain clearly

**Step 4 - Commit and push to the existing branch**:
\`\`\`bash
git add -A
git commit -m "fix(${task.key}): address PR review comments"
git push -u ${pushRemote} ${branchName}
\`\`\`

**Step 5 - Report back using the jiranimo MCP tools** (available as \`jiranimo_*\`):
- \`jiranimo_progress\` — send progress updates as you work (task_key="${task.key}")
- \`jiranimo_complete\` — when the PR branch is updated (task_key="${task.key}")
- \`jiranimo_fail\` — if you hit an unrecoverable error (task_key="${task.key}")

**Clean up the worktree**:
\`\`\`
git -C ${repoPath} worktree remove ${worktreePath}
\`\`\`${appendSection}`;
  }

  if (mode === 'continue-work') {
    const branchName = task.branchName ?? screenshotContext?.branchName;
    const prUrl = task.prUrl ?? screenshotContext?.prUrl;
    const prNumber = task.prNumber ?? screenshotContext?.prNumber;

    if (!branchName) {
      throw new Error(`Continue-work mode requires an existing branch for ${task.key}`);
    }

    return `You are continuing work on an existing Jira task that was previously implemented by Jiranimo. Reuse the existing branch and PR if one already exists.

## Task
\`\`\`json
${taskJson}
\`\`\`${recoverySection}
${existingPlanSection}

### Context
- Branch: \`${branchName}\`
- Existing PR: ${prUrl ?? 'none'}

The task JSON may include:
- \`comments\`: the latest Jira ticket comments. Review them carefully for new requests, QA feedback, regressions, or follow-up scope.
- \`githubReviewComments\`: any new GitHub PR comments that still need to be addressed.

This run is not a fresh implementation. First verify the current implementation state, then make the smallest correct follow-up changes needed.

**Step 1 - Check out the existing branch**:
\`\`\`bash
if [ ! -d "${worktreePath}" ]; then
  git -C ${repoPath} worktree add ${worktreePath} ${branchName}
fi
cd ${worktreePath}
\`\`\`

**Step 2 - Verify the current implementation before changing code**:
- Run \`git status\`
- Inspect the current branch diff and recent commits
- If a PR exists, inspect it with ${prNumber ? `\`gh pr view ${prNumber} --comments\`` : '`gh pr view --comments` if you can resolve it from the branch'}
- Read the latest Jira comments from the task JSON
- Review any \`githubReviewComments\` entries in the task JSON
- Determine what is already fixed versus what still needs attention

**Step 3 - Continue the implementation on the same branch**:
- Address all unresolved GitHub review comments provided in \`githubReviewComments\`
- Address any Jira follow-up comments that require more work
- Verify the feature still behaves correctly end to end after your changes
- Keep the existing branch and PR; do not create a replacement branch or PR

**Step 4 - Run verification**:
- Run the relevant tests for the changed area
- If there are no focused tests, run the smallest meaningful validation you can explain clearly

**Step 5 - Commit and push only if changes were required**:
\`\`\`bash
git add -A
git commit -m "fix(${task.key}): address follow-up feedback"
git push -u ${pushRemote} ${branchName}
\`\`\`
- Do not create an empty commit. If the implementation already satisfies the feedback, explain that clearly in your final report instead.

**Step 6 - Report back using the jiranimo MCP tools** (available as \`jiranimo_*\`):
- \`jiranimo_progress\` — send progress updates as you work (task_key="${task.key}")
- \`jiranimo_complete\` — when the existing branch is verified and updated as needed (task_key="${task.key}")
- \`jiranimo_fail\` — if you hit an unrecoverable error (task_key="${task.key}")

**Clean up the worktree**:
\`\`\`
git -C ${repoPath} worktree remove ${worktreePath}
\`\`\`${appendSection}`;
  }

  if (mode === 'plan') {
    return `You are creating a technical plan for a Jira task. Explore the repository to understand the codebase, then write a structured plan. Do NOT write any code or commit anything.

## Task
\`\`\`json
${taskJson}
\`\`\`${existingPlanSection}

### Your Workspace & Planning Instructions

The repository is at: \`${repoPath}\`

**Step 1 - Fetch latest remote state** (required before branch creation):
\`\`\`bash
git -C ${repoPath} fetch origin
\`\`\`

**Step 2 - Create a worktree** for exploration:
\`\`\`bash
git -C ${repoPath} worktree add ${worktreePath} -b ${branchPrefix}${task.key}-plan origin/${defaultBaseBranch}
cd ${worktreePath}
pwd  # must show ${worktreePath} — abort if it does not
\`\`\`
If \`origin/${defaultBaseBranch}\` does not exist, detect the actual default branch first:
\`git -C ${repoPath} remote show ${pushRemote} | grep 'HEAD branch'\`

**Step 3 - Write the plan** to \`${planFilePath(task.key)}\` — do NOT commit this file or anything else.

**Step 4 - Report back using the jiranimo MCP tools** (available as \`jiranimo_*\`):
- \`jiranimo_progress\` — send progress updates as you work (task_key="${task.key}")
- \`jiranimo_complete\` — when the plan file is written (task_key="${task.key}")
- \`jiranimo_fail\` — if you hit an unrecoverable error (task_key="${task.key}")

**Clean up the worktree**:
\`\`\`
git -C ${repoPath} worktree remove ${worktreePath}
\`\`\`${appendSection}`;
  }

  return `You are implementing a Jira task as a software engineer. You have full access to the repository and must handle all git operations yourself.

## Task
\`\`\`json
${taskJson}
\`\`\`
${recoverySection}
${existingPlanSection}

### Your Workspace & Git Instructions

The repository you should work on is at: \`${repoPath}\`

**Step 1 - Fetch latest remote state** (required before branch creation):
\`\`\`bash
git -C ${repoPath} fetch origin
\`\`\`

**Step 2 - Create a worktree** for isolation:
\`\`\`bash
if [ ! -d "${worktreePath}" ]; then
  git -C ${repoPath} worktree add ${worktreePath} -b ${branchPrefix}${task.key}-<short-slug> origin/${defaultBaseBranch}
fi
cd ${worktreePath}
pwd  # must show ${worktreePath} — if it does not, STOP and call jiranimo_fail
git branch --show-current  # must NOT be master or main — if it is, STOP and call jiranimo_fail
\`\`\`
If \`origin/${defaultBaseBranch}\` does not exist, detect the actual default branch first:
\`git -C ${repoPath} remote show ${pushRemote} | grep 'HEAD branch'\`

**Step 3 - Implement** the changes described above. Write or update tests as appropriate and ensure they pass.

**Step 4 - Commit and push**:
\`\`\`
git add -A
git commit -m "<type>(${task.key}): <short description>"
git push -u ${pushRemote} <branch-name>
\`\`\`
Use conventional commit types: \`feat\` for features, \`fix\` for bugs, \`chore\` for other work.

**Step 5 — Screenshot (frontend tasks only)**
If your implementation touches any UI files (HTML, CSS, frontend JS, browser extension files), take a screenshot of the real running feature.

Think of yourself as a developer who just finished implementing this feature and wants to show it working. How would you demo it to a colleague? Do that — use the real app, the real dev server, the real test suite.

**How to get the screenshot — you MUST try both before giving up:**
1. **Run existing E2E/integration tests.** Look in the project's test directories for Playwright or similar tests that exercise the UI you changed. Actually run them — don't assume they're broken or excluded. If they save screenshots to disk, copy the result to \`/tmp/jiranimo-${task.key}-screenshot.png\`. For browser extensions specifically, E2E tests that load the extension in a real Chromium are the correct path and likely the only one available.
2. **Start the app and capture it.** If no E2E tests exist, start the app with its standard dev command (check \`package.json\` scripts), then use the \`browser_screenshot\` MCP tool or \`npx playwright screenshot --viewport-size "1280,720" <url> /tmp/jiranimo-${task.key}-screenshot.png\`.

Ask yourself: how would a developer on this project run and view the feature they just built? Do exactly that, then take the screenshot.

**Non-negotiable rules:**
- Screenshot the REAL running feature. Never create a throwaway demo/mock HTML file just to screenshot it — that is not evidence the feature works, and it's not how a real developer would do it.
- Do not give up after a brief look. Actually attempt to run the tests or start the app before concluding it's impossible.
- After taking the screenshot, verify it's correct and actually shows the feature working. Print to stdout what you actually see on the screenshot.

Call \`jiranimo_screenshot_failed\` only if you genuinely tried both approaches and both failed — and explain exactly what commands you ran and what errors you got.

If your changes are server-only, skip this step.

**Step 6 — Upload the screenshot and create a PR**:
If a screenshot was taken, call \`jiranimo_upload_screenshot\` with \`file_path="/tmp/jiranimo-${task.key}-screenshot.png"\`. It returns a URL — use it in the PR body as \`![Screenshot](<url>)\`.

\`\`\`bash
gh pr create ${createDraftPr ? '--draft ' : ''}--title "#${task.key} ${task.summary}" --body "Implements ${task.key}. Jira: ${task.jiraUrl}
# append screenshot line here if upload succeeded: ![Screenshot](<url>)"
\`\`\`

**Step 6b — Verify the screenshot is in the PR body** (required if a screenshot was uploaded):
Run \`gh pr view --json body --jq '.body'\` and confirm it contains the screenshot URL. If not, run \`gh pr edit\` to add it.

**Step 7 - Report back using the jiranimo MCP tools** (available as \`jiranimo_*\`):
- \`jiranimo_progress\` — send progress updates as you work (task_key="${task.key}")
- \`jiranimo_report_pr\` — once the PR is created, report its url, number, and branch name (task_key="${task.key}")
- \`jiranimo_complete\` — when all work is done (task_key="${task.key}")
- \`jiranimo_fail\` — if you hit an unrecoverable error (task_key="${task.key}")

**Clean up the worktree**:
\`\`\`
git -C ${repoPath} worktree remove ${worktreePath}
\`\`\`${appendSection}`;
}
