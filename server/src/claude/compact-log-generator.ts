import { executeClaudeCode } from './executor.js';
import type { ClaudeConfig } from '../config/types.js';

export async function generateCompactLog(
  sessionId: string,
  config: ClaudeConfig,
  cwd: string,
): Promise<string> {
  const result = await executeClaudeCode({
    prompt: '/compact',
    cwd,
    config,
    resumeSessionId: sessionId,
  });
  if (!result.resultText) {
    throw new Error('No compact log generated');
  }
  return result.resultText;
}
