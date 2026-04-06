import { executeClaudeCode } from './executor.js';
import type { ClaudeConfig } from '../config/types.js';

interface LogEvent {
  type: string;
  message?: { content?: Array<{ type: string; text?: string; name?: string; input?: unknown }> };
  result?: string;
  subtype?: string;
  cost_usd?: number;
}

const MAX_LOG_CHARS = 20_000;

export async function generateCompactLog(
  logContent: string,
  taskSummary: string,
  config: ClaudeConfig,
  cwd: string,
): Promise<string> {
  const readable = extractReadableContent(logContent);
  if (!readable.trim()) {
    return 'No conversation content found in log.';
  }

  const prompt = [
    'You are summarizing an AI agent execution log for a developer following task progress.',
    `Task: "${taskSummary}"`,
    '',
    'Write a concise but sufficiently detailed summary that covers:',
    '1. The main steps the agent took',
    '2. Important findings, decisions, or deviations',
    '3. Any problems or failures encountered',
    '4. The final outcome',
    '',
    'Rules:',
    '- Use 5-12 bullet points.',
    '- Focus on task-specific implementation details, not filler.',
    '- Prefer what changed in the repo, what was discovered, and how the task was solved.',
    '- Do not spend bullets on routine workflow boilerplate such as worktree setup/cleanup, generic git add/commit/push, PR creation, or Jira status/reporting unless something unusual happened there.',
    '- Mention concrete files, commands, tools, or errors when they materially explain the implementation.',
    '- Do not mention token usage, compaction, or transcript mechanics.',
    '- Do not invent details that are not in the log.',
    '',
    'Execution log:',
    excerptReadableLog(readable),
  ].join('\n');

  const result = await executeClaudeCode({
    prompt,
    cwd,
    config,
  });

  if (!result.resultText.trim()) {
    throw new Error('No compact log generated');
  }

  return result.resultText.trim();
}

function extractReadableContent(logContent: string): string {
  const lines = logContent.split('\n').filter(line => line.trim());
  const parts: string[] = [];

  for (const line of lines) {
    let event: LogEvent;
    try {
      event = JSON.parse(line) as LogEvent;
    } catch {
      continue;
    }

    switch (event.type) {
      case 'assistant': {
        const blocks = event.message?.content ?? [];
        for (const block of blocks) {
          if (block.type === 'text' && block.text) {
            parts.push(`[Claude] ${block.text}`);
          } else if (block.type === 'tool_use') {
            const toolName = block.name ?? 'unknown';
            if (isRoutineToolAction(toolName, block.input)) {
              continue;
            }
            const inputLabel = summarizeToolInput(block.input);
            parts.push(`[Tool] ${toolName}${inputLabel ? `(${inputLabel})` : ''}`);
          }
        }
        break;
      }
      case 'result': {
        const cost = typeof event.cost_usd === 'number' ? ` (cost: $${event.cost_usd.toFixed(4)})` : '';
        const resultText = event.result ? `\n${event.result}` : '';
        parts.push(`[Result: ${event.subtype ?? 'unknown'}${cost}]${resultText}`);
        break;
      }
      default:
        break;
    }
  }

  return parts.join('\n\n');
}

function excerptReadableLog(readable: string): string {
  if (readable.length <= MAX_LOG_CHARS) {
    return readable;
  }

  const head = readable.slice(0, Math.floor(MAX_LOG_CHARS / 2));
  const tail = readable.slice(-Math.ceil(MAX_LOG_CHARS / 2));
  return `${head}\n\n[... middle of log omitted for length ...]\n\n${tail}`;
}

function summarizeToolInput(input: unknown): string {
  if (!input || typeof input !== 'object') return '';

  const record = input as Record<string, unknown>;
  const preferredKeys = ['file_path', 'command', 'path', 'task_key', 'pr_url'];

  for (const key of preferredKeys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      return truncate(value.trim(), 80);
    }
  }

  const firstEntry = Object.entries(record).find(([, value]) => typeof value === 'string' && value.trim());
  if (firstEntry) {
    return truncate(String(firstEntry[1]).trim(), 80);
  }

  return '';
}

function isRoutineToolAction(name: string, input: unknown): boolean {
  if (name === 'TodoWrite') return true;
  if (name === 'ToolSearch' && isRoutineToolSearch(input)) return true;
  if (name.startsWith('mcp__jiranimo__') && name !== 'mcp__jiranimo__jiranimo_fail') return true;

  const command = typeof (input as Record<string, unknown> | undefined)?.command === 'string'
    ? String((input as Record<string, unknown>).command).trim()
    : '';
  if (!command) return false;

  return isRoutineCommand(command);
}

function isRoutineToolSearch(input: unknown): boolean {
  if (!input || typeof input !== 'object') return false;
  const query = typeof (input as Record<string, unknown>).query === 'string'
    ? String((input as Record<string, unknown>).query)
    : '';

  return query.includes('select:TodoWrite')
    || query.includes('jiranimo_report_pr')
    || query.includes('jiranimo_complete')
    || query.includes('jiranimo_progress');
}

function isRoutineCommand(command: string): boolean {
  const normalized = command.replace(/\s+/g, ' ').trim().toLowerCase();

  return /git(?:\s+-[a-z]\s+\S+)*\s+remote show\b/.test(normalized)
    || /\bgit add\b/.test(normalized)
    || /\bgit commit\b/.test(normalized)
    || /\bgit push\b/.test(normalized)
    || /\bgh pr create\b/.test(normalized)
    || /\bworktree remove\b/.test(normalized)
    || /\bworktree add\b/.test(normalized)
    || (normalized.includes('/tmp/jiranimo-') && normalized.includes('worktree'));
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}
