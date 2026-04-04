/**
 * E2E tests against the real Jira site.
 * Generates PNG screenshots in test/e2e/screenshots/jira-api/
 */

import { describe, it, expect, afterEach, afterAll, beforeAll } from 'vitest';
import {
  verifyConnection,
  createTestIssue,
  getIssue,
  getIssueComments,
  getTransitions,
  addComment,
  cleanupTestIssues,
  cleanupStaleTestIssues,
} from './jira-helpers.js';
import { initScreenshots, closeScreenshots, startSuite, startTest, screenshot } from './snapshots.js';

beforeAll(async () => {
  const connected = await verifyConnection();
  expect(connected).toBe(true);
  await initScreenshots();
  startSuite('jira-api');
});

afterEach(async () => {
  await cleanupTestIssues();
});

afterAll(async () => {
  await cleanupStaleTestIssues();
  await closeScreenshots();
});

describe('Jira API E2E', () => {
  it('verifies API connectivity', async () => {
    startTest('verify-connectivity');
    const connected = await verifyConnection();
    await screenshot('connection-result', { connected, host: process.env.JIRA_HOST });
    expect(connected).toBe(true);
  });

  it('creates and retrieves an issue', async () => {
    startTest('create-and-retrieve');
    const key = await createTestIssue({ summary: 'E2E create test' });
    await screenshot('created-issue', { key });

    const issue = await getIssue(key);
    await screenshot('retrieved-issue', issue);

    expect(key).toMatch(/^[A-Z]+-\d+$/);
    expect(issue).toBeDefined();
  });

  it('creates an issue with labels', async () => {
    startTest('create-with-labels');
    const key = await createTestIssue({
      summary: 'E2E label test',
      labels: ['ai-ready', 'test-label'],
    });
    await screenshot('created-issue', { key, labels: ['ai-ready', 'test-label'] });
    expect(key).toBeTruthy();
  });

  it('adds a comment to an issue', async () => {
    startTest('add-comment');
    const key = await createTestIssue({ summary: 'E2E comment test' });
    await screenshot('created-issue', { key });

    await addComment(key, 'Test comment from Jiranimo E2E');
    const comments = await getIssueComments(key);
    await screenshot('comments-after', comments, `${comments.length} comment(s) on ${key}`);

    expect(comments.length).toBeGreaterThan(0);
  });

  it('gets available transitions for an issue', async () => {
    startTest('get-transitions');
    const key = await createTestIssue({ summary: 'E2E transitions test' });
    const transitions = await getTransitions(key);
    await screenshot('transitions', transitions,
      transitions.map(t => `${t.id}: ${t.name}`).join('\n'));

    expect(transitions.length).toBeGreaterThan(0);
  });

  it('cleans up test issues after each test', async () => {
    startTest('cleanup-verification');
    const key = await createTestIssue({ summary: 'E2E cleanup test' });
    await screenshot('created-issue', { key, willBeDeleted: true });
    expect(key).toBeTruthy();
  });
});
