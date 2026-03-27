import { EventEmitter } from 'node:events';
import type { ClaudeEvent } from './types.js';

export class OutputParser extends EventEmitter {
  private buffer = '';

  feed(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    // Keep the last incomplete line in the buffer
    this.buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      this.parseLine(trimmed);
    }
  }

  flush(): void {
    if (this.buffer.trim()) {
      this.parseLine(this.buffer.trim());
      this.buffer = '';
    }
  }

  private parseLine(line: string): void {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Skip malformed lines
      this.emit('parse-error', line);
      return;
    }

    const event = this.toClaudeEvent(parsed);
    if (event) {
      this.emit('event', event);
      if (event.type === 'result') {
        this.emit('result', event);
      }
    }
  }

  private toClaudeEvent(raw: Record<string, unknown>): ClaudeEvent | null {
    const type = raw.type as string | undefined;

    if (type === 'system') {
      return { type: 'init', raw };
    }

    if (type === 'assistant') {
      const message = raw.message as Record<string, unknown> | undefined;
      const content = message?.content;
      let text: string | undefined;
      if (Array.isArray(content)) {
        text = content
          .filter((c: Record<string, unknown>) => c.type === 'text')
          .map((c: Record<string, unknown>) => c.text)
          .join('');
      }
      return { type: 'message', raw, text };
    }

    if (type === 'result') {
      const subtype = raw.subtype as string | undefined;
      const isError = subtype === 'error_max_turns' || subtype === 'error';
      const resultText = raw.result as string | undefined;
      const costUsd = (raw.total_cost_usd ?? raw.cost_usd) as number | undefined;
      const sessionId = raw.session_id as string | undefined;

      return {
        type: 'result',
        raw,
        text: resultText,
        isError,
        costUsd,
        sessionId,
      };
    }

    // Unknown event type — still emit it
    return { type: 'message', raw };
  }
}
