import { tmpdir } from 'node:os';
import { executeClaudeCode } from './executor.js';
import type { TaskMode } from '../state/types.js';
import type { TaskInput } from './types.js';
import type { ClaudeConfig } from '../config/types.js';

function normalizeMode(text: string | undefined, fallback: TaskMode = 'plan'): TaskMode {
  return text?.trim().toLowerCase().startsWith('implement') ? 'implement' : fallback;
}

export async function classifyTask(
  task: Pick<TaskInput, 'key' | 'summary' | 'description'>,
  claudeConfig?: ClaudeConfig,
): Promise<TaskMode> {
  const description = task.description?.slice(0, 800) ?? '';

  const prompt = `Classify this Jira task as either a planning/design task or an implementation task.

Task: ${task.key} - ${task.summary}
${description ? `\nDescription: ${description}` : ''}

Respond with ONLY one word: "plan" or "implement".
- "plan": design, investigation, analysis, architecture, proposal, research, spike, exploration, RFC
- "implement": feature, bug fix, chore, refactor, tests, or any concrete code change`;

  const result = await executeClaudeCode({
    prompt,
    cwd: tmpdir(),
    config: { ...claudeConfig, model: 'claude-haiku-4-5-20251001' },
  });

  return result.resultText?.trim().toLowerCase().startsWith('plan') ? 'plan' : 'implement';
}

export async function decidePlannedTaskNextMode(
  task: Pick<TaskInput, 'key' | 'summary' | 'description' | 'comments'> & { planContent?: string },
  claudeConfig?: ClaudeConfig,
): Promise<TaskMode> {
  const description = task.description?.slice(0, 1_200) ?? '';
  const planContent = task.planContent?.slice(0, 4_000) ?? '';
  const comments = task.comments.length > 0
    ? task.comments
      .map((comment, index) =>
        `${index + 1}. ${comment.author}${comment.created ? ` (${comment.created})` : ''}: ${comment.body}`.slice(0, 1_200))
      .join('\n')
    : 'No Jira comments were provided.';

  const prompt = `A previous Jiranimo run already produced a technical plan for this Jira task.
Decide whether the next run should implement that existing plan or continue planning/refining it.

Task: ${task.key} - ${task.summary}
${description ? `\nDescription: ${description}` : ''}
${planContent ? `\nExisting plan:\n${planContent}` : ''}

Jira comments:
${comments}

Respond with ONLY one word: "implement" or "plan".
- "implement": the comments clearly approve proceeding with the existing plan, for example "perfect, let's do it", "approved", "go ahead", "implement this", "ship it"
- "plan": the comments ask for revisions, more thinking, more design, or they do not clearly approve implementation yet

Be conservative: if the comments are ambiguous, respond "plan".`;

  const result = await executeClaudeCode({
    prompt,
    cwd: tmpdir(),
    config: { ...claudeConfig, model: 'claude-haiku-4-5-20251001' },
  });

  return normalizeMode(result.resultText, 'plan');
}

export async function resolveTaskMode(
  task: Pick<TaskInput, 'key' | 'summary' | 'description' | 'comments'> & { previousTaskMode?: TaskMode; planContent?: string },
  claudeConfig?: ClaudeConfig,
): Promise<TaskMode> {
  if (task.previousTaskMode === 'plan') {
    return decidePlannedTaskNextMode(task, claudeConfig);
  }

  return classifyTask(task, claudeConfig);
}
