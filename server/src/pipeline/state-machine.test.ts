import { describe, it, expect } from 'vitest';
import { transition } from './state-machine.js';

describe('state machine', () => {
  it('queued + start = in-progress', () => {
    expect(transition('queued', 'start')).toBe('in-progress');
  });

  it('in-progress + complete = completed', () => {
    expect(transition('in-progress', 'complete')).toBe('completed');
  });

  it('in-progress + fail = failed', () => {
    expect(transition('in-progress', 'fail')).toBe('failed');
  });

  it('failed + retry = queued', () => {
    expect(transition('failed', 'retry')).toBe('queued');
  });

  it('throws on invalid: queued + complete', () => {
    expect(() => transition('queued', 'complete')).toThrow('Invalid transition');
  });

  it('throws on invalid: completed + start', () => {
    expect(() => transition('completed', 'start')).toThrow('Invalid transition');
  });

  it('throws on invalid: completed + retry', () => {
    expect(() => transition('completed', 'retry')).toThrow('Invalid transition');
  });

  it('queued + fail = failed (config error)', () => {
    expect(transition('queued', 'fail')).toBe('failed');
  });

  it('throws on invalid: failed + complete', () => {
    expect(() => transition('failed', 'complete')).toThrow('Invalid transition');
  });

  it('error message includes status and action', () => {
    expect(() => transition('completed', 'fail')).toThrow('"fail" to task in "completed"');
  });
});
