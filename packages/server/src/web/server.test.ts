import { describe, expect, it } from 'vitest';
import { shouldSkipHttpLog } from './server.js';

describe('shouldSkipHttpLog', () => {
  it('skips noisy internal effect lease traffic', () => {
    expect(shouldSkipHttpLog('POST', '/api/effects/effect-123/claim')).toBe(true);
    expect(shouldSkipHttpLog('POST', '/api/effects/effect-123/ack')).toBe(true);
  });

  it('skips task status polling endpoints', () => {
    expect(shouldSkipHttpLog('GET', '/api/tasks')).toBe(true);
    expect(shouldSkipHttpLog('GET', '/api/tasks/PROJ-1')).toBe(true);
    expect(shouldSkipHttpLog('GET', '/api/sync')).toBe(true);
  });

  it('keeps meaningful mutating API requests', () => {
    expect(shouldSkipHttpLog('POST', '/api/tasks')).toBe(false);
    expect(shouldSkipHttpLog('POST', '/api/tasks/PROJ-1/retry')).toBe(false);
    expect(shouldSkipHttpLog('DELETE', '/api/tasks/PROJ-1')).toBe(false);
  });

  it('keeps non-polling task endpoints visible', () => {
    expect(shouldSkipHttpLog('GET', '/api/tasks/PROJ-1/logs')).toBe(false);
  });
});
