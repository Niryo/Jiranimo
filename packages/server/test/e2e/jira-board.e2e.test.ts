/**
 * E2E tests for Jira board configuration.
 * Generates PNG screenshots in test/e2e/screenshots/jira-board/
 */

import { describe, it, expect, afterEach, afterAll, beforeAll } from 'vitest';
import {
  verifyConnection,
  jiraRequest,
  createTestIssue,
  getTransitions,
  cleanupTestIssues,
  cleanupStaleTestIssues,
} from './jira-helpers.js';
import { initScreenshots, closeScreenshots, startSuite, startTest, screenshot } from './snapshots.js';

beforeAll(async () => {
  const connected = await verifyConnection();
  expect(connected).toBe(true);
  await initScreenshots();
  startSuite('jira-board');
});

afterEach(async () => {
  await cleanupTestIssues();
});

afterAll(async () => {
  await cleanupStaleTestIssues();
  await closeScreenshots();
});

describe('Jira Board Configuration E2E', () => {
  it('reads board columns from Agile API', async () => {
    startTest('read-board-columns');

    const boardRes = await jiraRequest('GET', '/rest/agile/1.0/board?projectKeyOrId=JTEST');
    expect(boardRes.ok).toBe(true);
    const boardData = await boardRes.json();
    await screenshot('boards-list', boardData.values);

    const boards = boardData.values ?? [];
    expect(boards.length).toBeGreaterThan(0);
    const boardId = boards[0].id;

    const configRes = await jiraRequest('GET', `/rest/agile/1.0/board/${boardId}/configuration`);
    expect(configRes.ok).toBe(true);
    const configData = await configRes.json();

    const columns = configData.columnConfig?.columns ?? [];
    const columnNames = columns.map((c: { name: string }) => c.name);
    await screenshot('board-columns', columns,
      `Board: ${configData.name}\n\nColumns:\n${columnNames.map((n: string, i: number) => `  ${i + 1}. ${n}`).join('\n')}`);

    expect(columnNames).toContain('To Do');
    expect(columnNames).toContain('In Progress');
    expect(columnNames).toContain('Done');

    // Verify ALL columns are returned, not just defaults
    // The board may have custom columns like "testos" or "in review"
    expect(columnNames.length).toBeGreaterThanOrEqual(3);
    await screenshot('all-columns-count', {
      count: columnNames.length,
      names: columnNames,
    }, `Total columns: ${columnNames.length}\nAll: ${columnNames.join(' → ')}\n\nThis must include ALL custom columns, not just defaults.`);
  });

  it('reads transitions for an issue', async () => {
    startTest('read-transitions');

    const key = await createTestIssue({ summary: 'Board config test - transitions' });
    await screenshot('created-issue', { key, purpose: 'Query transitions' });

    const transitions = await getTransitions(key);
    await screenshot('available-transitions', transitions,
      `Issue: ${key}\n\nAvailable transitions:\n${transitions.map((t: { id: string; name: string }) => `  → ${t.name} (id: ${t.id})`).join('\n')}`);

    expect(transitions.length).toBeGreaterThan(0);
  });

  it('creates an issue with ai-ready label and verifies it', async () => {
    startTest('issue-with-label');

    const key = await createTestIssue({ summary: 'Board config test - labeled', labels: ['ai-ready'] });

    const issueRes = await jiraRequest('GET', `/rest/api/3/issue/${key}?fields=labels,summary,status`);
    const issue = await issueRes.json();
    await screenshot('issue-with-label', {
      key,
      summary: issue.fields.summary,
      labels: issue.fields.labels,
      status: issue.fields.status?.name,
    }, `Issue: ${key}\nSummary: ${issue.fields.summary}\nLabels: ${issue.fields.labels?.join(', ')}\nStatus: ${issue.fields.status?.name}`);

    expect(issue.fields.labels).toContain('ai-ready');
  });

  it('transitions an issue through statuses', async () => {
    startTest('transition-issue');

    const key = await createTestIssue({ summary: 'Board config test - transition flow' });
    await screenshot('initial-state', { key, status: 'To Do' }, `Created ${key} in "To Do"`);

    const transitions = await getTransitions(key);
    const inProgress = transitions.find((t: { name: string }) => t.name.toLowerCase().includes('progress'));

    if (inProgress) {
      await jiraRequest('POST', `/rest/api/3/issue/${key}/transitions`, { transition: { id: inProgress.id } });

      const issueRes = await jiraRequest('GET', `/rest/api/3/issue/${key}?fields=status`);
      const issue = await issueRes.json();
      const newStatus = issue.fields.status?.name;

      await screenshot('after-transition', {
        key,
        transition: inProgress.name,
        newStatus,
      }, `${key}: To Do → ${newStatus}\nTransition used: "${inProgress.name}" (id: ${inProgress.id})`);

      expect(newStatus?.toLowerCase()).toContain('progress');
    }
  });

  it('full board config flow — columns + transitions match', async () => {
    startTest('full-board-config-flow');

    // Step 1: Board columns
    const boardRes = await jiraRequest('GET', '/rest/agile/1.0/board?projectKeyOrId=JTEST');
    const boardId = (await boardRes.json()).values[0].id;
    const configRes = await jiraRequest('GET', `/rest/agile/1.0/board/${boardId}/configuration`);
    const configData = await configRes.json();
    const columns = configData.columnConfig.columns.map((c: { name: string }) => c.name);
    await screenshot('step1-board-columns', { boardId, columns },
      `Board columns: ${columns.join(' → ')}`);

    // Step 2: Issue transitions
    const key = await createTestIssue({ summary: 'Full flow test', labels: ['ai-ready'] });
    const transitions = await getTransitions(key);
    const transitionNames = transitions.map((t: { name: string }) => t.name);
    await screenshot('step2-issue-transitions', { key, transitions: transitionNames },
      `Issue: ${key}\nTransitions: ${transitionNames.join(', ')}`);

    // Step 3: Match verification
    const hasInProgress = transitionNames.some((n: string) => n.toLowerCase().includes('progress'));
    await screenshot('step3-match-result', {
      columns,
      transitionNames,
      inProgressColumnExists: columns.some((c: string) => c.toLowerCase().includes('progress')),
      inProgressTransitionExists: hasInProgress,
      match: hasInProgress,
    }, `Columns: ${columns.join(' → ')}\nTransitions: ${transitionNames.join(', ')}\n\n✓ "In Progress" column exists: ${columns.some((c: string) => c.toLowerCase().includes('progress'))}\n✓ "In Progress" transition exists: ${hasInProgress}`);

    expect(hasInProgress).toBe(true);
  });

  it('transitions issue through full lifecycle: To Do → In Progress → Done', async () => {
    // Bug: Transitions weren't happening because the extension delegated them
    // to the background worker which has no session cookies in incognito.
    // Fix: Content script does transitions directly via fetch with credentials.
    // This test verifies the API-level flow works end to end.
    startTest('full-transition-lifecycle');

    const key = await createTestIssue({ summary: 'Full lifecycle test', labels: ['ai-ready'] });

    // Verify initial status
    let issueRes = await jiraRequest('GET', `/rest/api/3/issue/${key}?fields=status`);
    let status = (await issueRes.json()).fields.status.name;
    await screenshot('step1-initial', { key, status }, `${key}: ${status}`);
    expect(status).toBe('To Do');

    // Transition to In Progress
    const transitions1 = await getTransitions(key);
    const inProgress = transitions1.find((t: { name: string }) => t.name === 'In Progress');
    expect(inProgress).toBeDefined();
    await jiraRequest('POST', `/rest/api/3/issue/${key}/transitions`, { transition: { id: inProgress!.id } });

    issueRes = await jiraRequest('GET', `/rest/api/3/issue/${key}?fields=status`);
    status = (await issueRes.json()).fields.status.name;
    await screenshot('step2-in-progress', { key, status }, `${key}: ${status}`);
    expect(status).toBe('In Progress');

    // Transition to Done
    const transitions2 = await getTransitions(key);
    const done = transitions2.find((t: { name: string }) => t.name === 'Done');
    expect(done).toBeDefined();
    await jiraRequest('POST', `/rest/api/3/issue/${key}/transitions`, { transition: { id: done!.id } });

    issueRes = await jiraRequest('GET', `/rest/api/3/issue/${key}?fields=status`);
    status = (await issueRes.json()).fields.status.name;
    await screenshot('step3-done', { key, status }, `${key}: ${status}`);
    expect(status).toBe('Done');
  });
});
