/**
 * Jira REST API helpers for the Chrome extension.
 * All requests use the browser's session cookies (via host_permissions).
 */

// @ts-check

const JiraApi = {
  /** @type {string} */
  _baseUrl: '',

  /**
   * @param {string} baseUrl - e.g. "https://mycompany.atlassian.net"
   */
  init(baseUrl) {
    this._baseUrl = baseUrl.replace(/\/$/, '');
  },

  /**
   * @param {string} method
   * @param {string} path
   * @param {object} [body]
   * @returns {Promise<any>}
   */
  async request(method, path, body) {
    const url = `${this._baseUrl}${path}`;
    const options = {
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    if (body) {
      options.body = JSON.stringify(body);
    }
    const res = await fetch(url, options);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Jira API ${method} ${path} failed (${res.status}): ${text}`);
    }
    if (res.status === 204) return null;
    return res.json();
  },

  /**
   * Fetch full issue details.
   * @param {string} issueKey
   * @returns {Promise<object>}
   */
  async getIssue(issueKey) {
    return this.request('GET',
      `/rest/api/3/issue/${issueKey}?fields=summary,description,priority,issuetype,labels,comment,status,parent`
    );
  },

  /**
   * Get available transitions for an issue.
   * @param {string} issueKey
   * @returns {Promise<Array<{id: string, name: string}>>}
   */
  async getTransitions(issueKey) {
    const data = await this.request('GET', `/rest/api/3/issue/${issueKey}/transitions`);
    return data.transitions || [];
  },

  /**
   * Transition an issue to a new status.
   * @param {string} issueKey
   * @param {string} transitionId
   * @returns {Promise<void>}
   */
  async transitionIssue(issueKey, transitionId) {
    await this.request('POST', `/rest/api/3/issue/${issueKey}/transitions`, {
      transition: { id: transitionId },
    });
  },

  /**
   * Post a comment on an issue (ADF format).
   * @param {string} issueKey
   * @param {string} text - Plain text comment
   * @returns {Promise<void>}
   */
  async addComment(issueKey, text) {
    await this.request('POST', `/rest/api/3/issue/${issueKey}/comment`, {
      body: {
        type: 'doc',
        version: 1,
        content: [{
          type: 'paragraph',
          content: [{ type: 'text', text }],
        }],
      },
    });
  },

  /**
   * Get current user info (for testing connectivity).
   * @returns {Promise<{accountId: string, displayName: string}>}
   */
  async getMyself() {
    return this.request('GET', '/rest/api/3/myself');
  },
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { JiraApi };
} else if (typeof globalThis !== 'undefined') {
  globalThis.JiraApi = JiraApi;
}
