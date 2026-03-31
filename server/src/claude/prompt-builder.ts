import type { TaskInput } from './types.js';
import type { ServerConfig } from '../config/types.js';
import type { TaskMode } from '../state/types.js';

export const planFilePath = (key: string) => `/tmp/jiranimo-${key}-plan.md`;

interface ScreenshotContext {
  prUrl: string;
  prNumber: number;
  branchName: string;
}

export function buildPrompt(
  task: TaskInput,
  config: ServerConfig,
  repoPath: string,
  mode: TaskMode = 'implement',
  screenshotContext?: ScreenshotContext,
): string {
  const { branchPrefix, defaultBaseBranch, pushRemote, createDraftPr } = config.git;
  const taskJson = JSON.stringify(task, null, 2);
  const appendSection = config.claude.appendSystemPrompt ? `\n\n${config.claude.appendSystemPrompt}` : '';

  if (mode === 'screenshot' && screenshotContext) {
    const { prUrl, prNumber, branchName } = screenshotContext;
    return `You are adding a screenshot to a completed PR. The implementation is already done — do not change any code.

## Task
\`\`\`json
${taskJson}
\`\`\`

### Context
- Branch: \`${branchName}\`
- PR: ${prUrl}

The Jira comments in the task above contain instructions on how to screenshot this feature. Read the most recent comment that mentions "screenshot" and follow those instructions exactly.

**Step 1 - Check out the branch** (read-only, no new commits needed):
\`\`\`
git -C ${repoPath} worktree add /tmp/jiranimo-${task.key} ${branchName}
cd /tmp/jiranimo-${task.key}
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
git -C ${repoPath} worktree remove /tmp/jiranimo-${task.key}
\`\`\`${appendSection}`;
  }

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

**Step 4 — Screenshot (frontend tasks only)**
If your implementation touches any UI files (HTML, CSS, frontend JS, browser extension files), attach a screenshot of the real, working feature to the PR.

**How to get the screenshot — try in this order:**
1. **Run existing tests that produce screenshots.** Look at the project's E2E or integration tests. If there are tests that exercise the UI you changed and they save screenshots to disk, run those tests. Use the resulting screenshot file — this is the most authentic evidence a developer would provide.
2. **Start the dev server and capture it.** If there are no relevant test screenshots, start the app with its standard dev command (check \`package.json\` scripts), wait for it to be ready, then use Playwright's \`browser_screenshot\` MCP tool or \`npx playwright screenshot <url> <file>\` to capture the running feature.

**Rules:**
- Screenshot the REAL running feature. Do NOT create a fake or demo HTML page.
- Do not use GUI app launchers (\`open\`, \`osascript\`, \`xdg-open\`) — they require a display and will not work.

If you cannot take a screenshot after trying all reasonable approaches, call \`jiranimo_screenshot_failed\` with a \`reason\` describing what you tried.

If your changes are server-only, skip this step (set \`SCREENSHOT_B64\` to empty string).

**Step 5 — Create a PR** (include screenshot in body if taken):
\`\`\`bash
SCREENSHOT_B64=$(base64 -i /tmp/jiranimo-${task.key}-screenshot.png 2>/dev/null | tr -d '\\n' || echo "")
gh pr create ${createDraftPr ? '--draft ' : ''}--title "[${task.key}] ${task.summary}" --body "Implements ${task.key}. Jira: ${task.jiraUrl}\${SCREENSHOT_B64:+\\n\\ndata:image/png;base64,\${SCREENSHOT_B64}}"
\`\`\`

**Step 6 - Report back using the jiranimo MCP tools** (available as \`jiranimo_*\`):
- \`jiranimo_progress\` — send progress updates as you work (task_key="${task.key}")
- \`jiranimo_report_pr\` — once the PR is created, report its url, number, and branch name (task_key="${task.key}")
- \`jiranimo_complete\` — when all work is done (task_key="${task.key}")
- \`jiranimo_fail\` — if you hit an unrecoverable error (task_key="${task.key}")

**Clean up the worktree**:
\`\`\`
git -C ${repoPath} worktree remove /tmp/jiranimo-${task.key}
\`\`\`${appendSection}`;
}
