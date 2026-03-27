import { describe, it, expect, vi, beforeEach } from 'vitest';
const { JiraApi } = require('./jira-api.js');

// Mock fetch
const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

beforeEach(() => {
  vi.clearAllMocks();
  JiraApi.init('https://test.atlassian.net');
});

describe('JiraApi', () => {
  describe('init', () => {
    it('sets base URL and strips trailing slash', () => {
      JiraApi.init('https://test.atlassian.net/');
      expect(JiraApi._baseUrl).toBe('https://test.atlassian.net');
    });
  });

  describe('getIssue', () => {
    it('calls the correct URL with fields', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ fields: { summary: 'Test' } }),
      });

      const result = await JiraApi.getIssue('PROJ-1');
      expect(mockFetch).toHaveBeenCalledOnce();
      const url = mockFetch.mock.calls[0][0];
      expect(url).toContain('/rest/api/3/issue/PROJ-1');
      expect(url).toContain('fields=');
      expect(result.fields.summary).toBe('Test');
    });
  });

  describe('getTransitions', () => {
    it('returns transitions array', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          transitions: [
            { id: '21', name: 'In Progress' },
            { id: '31', name: 'Done' },
          ],
        }),
      });

      const transitions = await JiraApi.getTransitions('PROJ-1');
      expect(transitions).toHaveLength(2);
      expect(transitions[0].name).toBe('In Progress');
    });
  });

  describe('transitionIssue', () => {
    it('sends POST with transition id', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, status: 204, json: () => Promise.resolve(null) });

      await JiraApi.transitionIssue('PROJ-1', '21');
      expect(mockFetch.mock.calls[0][1].method).toBe('POST');
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.transition.id).toBe('21');
    });
  });

  describe('addComment', () => {
    it('sends ADF formatted comment', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, status: 201, json: () => Promise.resolve({}) });

      await JiraApi.addComment('PROJ-1', 'Hello world');
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.body.type).toBe('doc');
      expect(body.body.content[0].content[0].text).toBe('Hello world');
    });
  });

  describe('error handling', () => {
    it('throws on non-ok response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: () => Promise.resolve('Not found'),
      });

      await expect(JiraApi.getIssue('NOPE-1')).rejects.toThrow('404');
    });

    it('throws on network error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      await expect(JiraApi.getIssue('PROJ-1')).rejects.toThrow('Network error');
    });
  });
});
