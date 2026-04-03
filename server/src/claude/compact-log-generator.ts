import Anthropic from '@anthropic-ai/sdk';

interface LogEvent {
  type: string;
  message?: { content?: Array<{ type: string; text?: string; name?: string; input?: unknown }> };
  session_id?: string;
  subtype?: string;
  result?: string;
  cost_usd?: number;
}

function extractReadableContent(logContent: string): string {
  const lines = logContent.split('\n').filter(l => l.trim());
  const parts: string[] = [];

  for (const line of lines) {
    let event: LogEvent;
    try { event = JSON.parse(line); } catch { continue; }

    switch (event.type) {
      case 'assistant': {
        const blocks = event.message?.content ?? [];
        for (const block of blocks) {
          if (block.type === 'text' && block.text) {
            parts.push(`[Claude]: ${block.text}`);
          } else if (block.type === 'tool_use') {
            parts.push(`[Tool call]: ${block.name}`);
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
    }
  }

  return parts.join('\n\n');
}

export async function generateCompactLog(logContent: string, taskSummary: string): Promise<string> {
  const readable = extractReadableContent(logContent);
  if (!readable.trim()) {
    return 'No conversation content found in log.';
  }

  const client = new Anthropic();

  const message = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content: `You are summarizing a task execution log for a developer dashboard. The task was: "${taskSummary}"

Below is the execution log showing what the AI agent did. Create a compact, human-readable summary that covers:
1. What the agent did (key steps and decisions)
2. Any important findings or issues encountered
3. The final outcome

Keep it concise (5-15 bullet points or a short paragraph). Focus on what matters to a developer reviewing this task.

EXECUTION LOG:
${readable.slice(0, 12000)}`,
      },
    ],
  });

  const content = message.content[0];
  return content.type === 'text' ? content.text : 'Failed to generate compact log.';
}
