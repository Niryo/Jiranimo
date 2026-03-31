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
If your implementation touches any UI files (HTML, CSS, frontend JS, browser extension files), take a screenshot of the real running feature.

Think of yourself as a developer who just finished implementing this feature and wants to show it working. How would you demo it to a colleague? Do that — use the real app, the real dev server, the real test suite.

**How to get the screenshot:**
1. **Run existing E2E/integration tests.** Check the project's test directory for Playwright or similar tests that exercise the UI you changed. Run them — if they save screenshots to disk, copy the result to \`/tmp/jiranimo-${task.key}-screenshot.png\`.
2. **Start the dev server and capture it.** If no test screenshots exist, start the app with its standard dev command (check \`package.json\` scripts), then use the \`browser_screenshot\` MCP tool or \`npx playwright screenshot --viewport-size "1280,720" <url> /tmp/jiranimo-${task.key}-screenshot.png\`.

Ask yourself: how would a developer on this project run and view the feature they just built? Do exactly that, then take the screenshot.

**Non-negotiable rules:**
- Screenshot the REAL running feature. Never create a throwaway demo/mock HTML file just to screenshot it — that is not evidence the feature works, and it's not how a real developer would do it.
- After taking the screenshot, ask yourself again to make sure- is this really how a developer would capture their work to show a teammate? If not, adjust your approach until it is.
If you genuinely cannot screenshot the real app after trying all three approaches, call \`jiranimo_screenshot_failed\` with a \`reason\`.

If your changes are server-only, skip this step.

**Step 5 — Create a PR with the screenshot embedded in the body**:
\`\`\`bash
# Resize screenshot to max 900px wide so the base64 fits in the PR body
if [ -f /tmp/jiranimo-${task.key}-screenshot.png ]; then
  sips -Z 900 /tmp/jiranimo-${task.key}-screenshot.png --out /tmp/jiranimo-${task.key}-screenshot-small.png 2>/dev/null \\
    || cp /tmp/jiranimo-${task.key}-screenshot.png /tmp/jiranimo-${task.key}-screenshot-small.png
  SCREENSHOT_B64=$(base64 -i /tmp/jiranimo-${task.key}-screenshot-small.png | tr -d '\\n')
else
  SCREENSHOT_B64=""
fi
gh pr create ${createDraftPr ? '--draft ' : ''}--title "[${task.key}] ${task.summary}" --body "Implements ${task.key}. Jira: ${task.jiraUrl}\${SCREENSHOT_B64:+\\n\\ndata:image/png;base64,\${SCREENSHOT_B64}}"
\`\`\`

**Step 5b — Verify the screenshot is in the PR body** (required if a screenshot was taken):
\`\`\`bash
gh pr view --json body --jq '.body' | grep -q "data:image/png;base64" \\
  && echo "Screenshot verified in PR body" \\
  || { [ -n "\$SCREENSHOT_B64" ] && echo "WARNING: screenshot missing from PR body — fixing..." && gh pr edit --body "\$(gh pr view --json body --jq '.body')\\n\\ndata:image/png;base64,\${SCREENSHOT_B64}"; }
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
