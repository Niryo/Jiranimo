import { describe, it, expect } from 'vitest';
import { buildPrTitle, buildPrBody } from './pr.js';

describe('buildPrTitle', () => {
  it('formats title with issue key', () => {
    expect(buildPrTitle('PROJ-123', 'Add user avatar'))
      .toBe('[PROJ-123] Add user avatar');
  });
});

describe('buildPrBody', () => {
  const baseOpts = {
    issueKey: 'PROJ-123',
    summary: 'Add user avatar',
    description: 'As a user, I want to see my avatar.',
    jiraUrl: 'https://test.atlassian.net/browse/PROJ-123',
    resultText: 'Created the avatar component.',
  };

  it('includes summary section', () => {
    const body = buildPrBody(baseOpts);
    expect(body).toContain('## Summary');
    expect(body).toContain('PROJ-123');
    expect(body).toContain('Add user avatar');
  });

  it('includes Jira link', () => {
    const body = buildPrBody(baseOpts);
    expect(body).toContain('https://test.atlassian.net/browse/PROJ-123');
  });

  it('includes implementation notes', () => {
    const body = buildPrBody(baseOpts);
    expect(body).toContain('Created the avatar component.');
  });

  it('includes cost when provided', () => {
    const body = buildPrBody({ ...baseOpts, costUsd: 1.234 });
    expect(body).toContain('$1.23');
  });

  it('includes duration when provided', () => {
    const body = buildPrBody({ ...baseOpts, durationMs: 125_000 });
    expect(body).toContain('2m 5s');
  });

  it('omits cost/duration when not provided', () => {
    const body = buildPrBody(baseOpts);
    expect(body).not.toContain('Cost:');
    expect(body).not.toContain('Duration:');
  });

  it('includes Jiranimo attribution', () => {
    const body = buildPrBody(baseOpts);
    expect(body).toContain('Jiranimo');
    expect(body).toContain('review carefully');
  });
});
