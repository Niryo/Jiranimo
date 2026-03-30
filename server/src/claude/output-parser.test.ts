import { describe, it, expect, vi } from 'vitest';
import { OutputParser } from './output-parser.js';
import type { ClaudeEvent } from './types.js';

function collectEvents(parser: OutputParser): ClaudeEvent[] {
  const events: ClaudeEvent[] = [];
  parser.on('event', (e: ClaudeEvent) => events.push(e));
  return events;
}

describe('OutputParser', () => {
  it('parses a system init event', () => {
    const parser = new OutputParser();
    const events = collectEvents(parser);

    parser.feed('{"type":"system","subtype":"init","session_id":"abc"}\n');
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('init');
  });

  it('parses an assistant message with text content', () => {
    const parser = new OutputParser();
    const events = collectEvents(parser);

    parser.feed(JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Hello world' }] },
    }) + '\n');

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('message');
    expect(events[0].text).toBe('Hello world');
  });

  it('parses a success result', () => {
    const parser = new OutputParser();
    const events = collectEvents(parser);

    parser.feed(JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: 'Task completed',
      total_cost_usd: 1.5,
      session_id: 'sess-123',
    }) + '\n');

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('result');
    expect(events[0].isError).toBe(false);
    expect(events[0].text).toBe('Task completed');
    expect(events[0].costUsd).toBe(1.5);
    expect(events[0].sessionId).toBe('sess-123');
  });

  it('parses an error result', () => {
    const parser = new OutputParser();
    const events = collectEvents(parser);

    parser.feed(JSON.stringify({
      type: 'result',
      subtype: 'error',
      result: 'Something failed',
    }) + '\n');

    expect(events[0].isError).toBe(true);
  });

  it('parses error_max_turns as error', () => {
    const parser = new OutputParser();
    const events = collectEvents(parser);

    parser.feed(JSON.stringify({
      type: 'result',
      subtype: 'error_max_turns',
      result: 'Too many turns',
    }) + '\n');

    expect(events[0].isError).toBe(true);
  });

  it('parses error_max_budget_usd as error', () => {
    const parser = new OutputParser();
    const events = collectEvents(parser);

    parser.feed(JSON.stringify({
      type: 'result',
      subtype: 'error_max_budget_usd',
      result: 'Budget exceeded',
    }) + '\n');

    expect(events[0].isError).toBe(true);
  });

  it('emits result event separately', () => {
    const parser = new OutputParser();
    const resultHandler = vi.fn();
    parser.on('result', resultHandler);

    parser.feed(JSON.stringify({ type: 'result', subtype: 'success', result: 'done' }) + '\n');
    expect(resultHandler).toHaveBeenCalledOnce();
  });

  it('handles multiple events in one chunk', () => {
    const parser = new OutputParser();
    const events = collectEvents(parser);

    const lines = [
      JSON.stringify({ type: 'system', subtype: 'init' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }),
      JSON.stringify({ type: 'result', subtype: 'success', result: 'done' }),
    ].join('\n') + '\n';

    parser.feed(lines);
    expect(events).toHaveLength(3);
    expect(events.map(e => e.type)).toEqual(['init', 'message', 'result']);
  });

  it('handles chunked input across multiple feed calls', () => {
    const parser = new OutputParser();
    const events = collectEvents(parser);

    const fullLine = JSON.stringify({ type: 'system', subtype: 'init' });
    // Split in the middle
    parser.feed(fullLine.slice(0, 10));
    expect(events).toHaveLength(0);
    parser.feed(fullLine.slice(10) + '\n');
    expect(events).toHaveLength(1);
  });

  it('skips malformed JSON lines and emits parse-error', () => {
    const parser = new OutputParser();
    const events = collectEvents(parser);
    const parseErrors: string[] = [];
    parser.on('parse-error', (line: string) => parseErrors.push(line));

    parser.feed('not json\n' + JSON.stringify({ type: 'system' }) + '\n');
    expect(events).toHaveLength(1);
    expect(parseErrors).toHaveLength(1);
    expect(parseErrors[0]).toBe('not json');
  });

  it('skips empty lines', () => {
    const parser = new OutputParser();
    const events = collectEvents(parser);

    parser.feed('\n\n' + JSON.stringify({ type: 'system' }) + '\n\n');
    expect(events).toHaveLength(1);
  });

  it('flush processes remaining buffer', () => {
    const parser = new OutputParser();
    const events = collectEvents(parser);

    // Feed without trailing newline
    parser.feed(JSON.stringify({ type: 'system', subtype: 'init' }));
    expect(events).toHaveLength(0);
    parser.flush();
    expect(events).toHaveLength(1);
  });

  it('handles unknown event types gracefully', () => {
    const parser = new OutputParser();
    const events = collectEvents(parser);

    parser.feed(JSON.stringify({ type: 'unknown_type', data: 'foo' }) + '\n');
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('message'); // falls through to default
  });
});
