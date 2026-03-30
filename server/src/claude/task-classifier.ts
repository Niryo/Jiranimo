import { tmpdir } from 'node:os';
import { executeClaudeCode } from './executor.js';
import type { TaskMode } from '../state/types.js';
import type { TaskInput } from './types.js';

export async function classifyTask(task: Pick<TaskInput, 'key' | 'summary' | 'description'>): Promise<TaskMode> {
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
    config: { model: 'claude-haiku-4-5-20251001', maxBudgetUsd: 1 },
  });

  return result.resultText?.trim().toLowerCase().startsWith('plan') ? 'plan' : 'implement';
}
