/**
 * Jira REST API helpers for E2E tests.
 * Uses API token auth (from .env.test) instead of session cookies.
 */

import dotenv from 'dotenv';
import { resolve } from 'node:path';

// Load .env.test from project root
dotenv.config({ path: resolve(import.meta.dirname, '..', '..', '..', '..', '.env.test') });

const JIRA_HOST = process.env.JIRA_HOST;
const JIRA_EMAIL = process.env.JIRA_EMAIL;
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN;

const configured = !!(JIRA_HOST && JIRA_EMAIL && JIRA_API_TOKEN && JIRA_API_TOKEN !== 'your-api-token-here');

const auth = Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString('base64');

const testRunId = `test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const createdIssueKeys: string[] = [];

export async function jiraRequest(method: string, path: string, body?: unknown): Promise<Response> {
  const url = `https://${JIRA_HOST}${path}`;
  const options: RequestInit = {
    method,
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
  };
  if (body) {
    options.body = JSON.stringify(body);
  }
  return fetch(url, options);
}

/**
 * Search issues using JQL (uses the new POST /search/jql endpoint).
 */
async function searchIssues(jql: string, fields: string[] = ['key'], maxResults = 50): Promise<Array<Record<string, unknown>>> {
  const res = await jiraRequest('POST', '/rest/api/3/search/jql', {
    jql,
    fields,
    maxResults,
  });
  if (!res.ok) return [];
  const data = await res.json();
  return data.issues ?? [];
}

export async function getActiveSprintId(boardId: number): Promise<number | null> {
  const res = await jiraRequest('GET', `/rest/agile/1.0/board/${boardId}/sprint?state=active`);
  if (!res.ok) return null;
  const data = await res.json();
  return data.values?.[0]?.id ?? null;
}

export async function addIssuesToSprint(sprintId: number, issueKeys: string[]): Promise<void> {
  const res = await jiraRequest('POST', `/rest/agile/1.0/sprint/${sprintId}/issue`, {
    issues: issueKeys,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to add issues to sprint ${sprintId}: ${res.status} ${text}`);
  }
}

async function sprintContainsIssue(sprintId: number, issueKey: string): Promise<boolean> {
  const maxResults = 50;
  let startAt = 0;

  while (true) {
    const res = await jiraRequest(
      'GET',
      `/rest/agile/1.0/sprint/${sprintId}/issue?fields=summary&maxResults=${maxResults}&startAt=${startAt}`,
    );
    if (!res.ok) {
      return false;
    }

    const data = await res.json() as {
      issues?: Array<{ key?: string }>;
      total?: number;
      startAt?: number;
      maxResults?: number;
      isLast?: boolean;
    };
    const issues = data.issues ?? [];

    if (issues.some((issue) => issue.key === issueKey)) {
      return true;
    }

    const total = Number(data.total ?? 0);
    const nextStartAt = startAt + issues.length;
    const isLastPage = data.isLast === true || issues.length === 0 || nextStartAt >= total;
    if (isLastPage) {
      return false;
    }

    startAt = nextStartAt;
  }
}

async function waitForIssueInSprint(
  sprintId: number,
  issueKey: string,
  timeoutMs = 90_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await sprintContainsIssue(sprintId, issueKey)) {
      return true;
    }

    await new Promise(resolve => setTimeout(resolve, 2_000));
  }

  return false;
}

export async function createTestIssue(fields: {
  summary: string;
  projectKey?: string;
  issueType?: string;
  labels?: string[];
  boardId?: number; // if provided, issue is added to the active sprint
}): Promise<string> {
  const projectKey = fields.projectKey ?? 'JTEST';
  const res = await jiraRequest('POST', '/rest/api/3/issue', {
    fields: {
      project: { key: projectKey },
      summary: `${testRunId}: ${fields.summary}`,
      issuetype: { name: fields.issueType ?? 'Task' },
      labels: fields.labels ?? [],
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to create issue (${res.status}): ${text}`);
  }

  const data = await res.json();
  const key = data.key;
  createdIssueKeys.push(key);

  if (fields.boardId) {
    const sprintId = await getActiveSprintId(fields.boardId);
    if (sprintId) {
      await addIssuesToSprint(sprintId, [key]);
      const visibleInSprint = await waitForIssueInSprint(sprintId, key);
      if (!visibleInSprint) {
        throw new Error(
          `Issue ${key} was added to sprint ${sprintId} but never appeared in sprint issues within 90000ms`
        );
      }
    }
  }

  return key;
}

export async function deleteIssue(key: string): Promise<void> {
  const res = await jiraRequest('DELETE', `/rest/api/3/issue/${key}?deleteSubtasks=true`);
  if (!res.ok && res.status !== 404) {
    console.warn(`Failed to delete ${key}: ${res.status}`);
  }
}

export async function getIssue(key: string): Promise<Record<string, unknown>> {
  const res = await jiraRequest('GET', `/rest/api/3/issue/${key}?fields=status,comment`);
  if (!res.ok) throw new Error(`Failed to get issue ${key}: ${res.status}`);
  return res.json();
}

export async function getIssueComments(key: string): Promise<Array<{ body: unknown }>> {
  const res = await jiraRequest('GET', `/rest/api/3/issue/${key}/comment`);
  if (!res.ok) throw new Error(`Failed to get comments for ${key}: ${res.status}`);
  const data = await res.json();
  return data.comments ?? [];
}

export async function getTransitions(key: string): Promise<Array<{ id: string; name: string }>> {
  const res = await jiraRequest('GET', `/rest/api/3/issue/${key}/transitions`);
  if (!res.ok) throw new Error(`Failed to get transitions for ${key}: ${res.status}`);
  const data = await res.json();
  return data.transitions ?? [];
}

export async function transitionIssue(key: string, transitionId: string): Promise<void> {
  const res = await jiraRequest('POST', `/rest/api/3/issue/${key}/transitions`, {
    transition: { id: transitionId },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to transition ${key}: ${text}`);
  }
}

export async function addComment(key: string, text: string): Promise<void> {
  const res = await jiraRequest('POST', `/rest/api/3/issue/${key}/comment`, {
    body: {
      type: 'doc',
      version: 1,
      content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
    },
  });
  if (!res.ok) throw new Error(`Failed to add comment to ${key}: ${res.status}`);
}

export async function cleanupTestIssues(): Promise<void> {
  if (createdIssueKeys.length === 0) return;
  await Promise.all(createdIssueKeys.map(key => deleteIssue(key)));
  createdIssueKeys.length = 0;
}

export async function cleanupStaleTestIssues(projectKey = 'JTEST'): Promise<void> {
  // Delete ALL test issues in the project (summaries start with "test-<timestamp>")
  const jql = `project = ${projectKey} AND summary ~ "test-" ORDER BY created ASC`;
  const issues = await searchIssues(jql, ['key'], 100);
  if (issues.length > 0) {
    await Promise.all(issues.map(issue => deleteIssue(issue.key as string)));
  }
}

export async function verifyConnection(): Promise<boolean> {
  if (!configured) return false;
  try {
    const res = await jiraRequest('GET', '/rest/api/3/myself');
    return res.ok;
  } catch {
    return false;
  }
}

export { testRunId };
