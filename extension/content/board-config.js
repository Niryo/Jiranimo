/**
 * Guided board configuration UI.
 * Shows a modal on first visit to an unconfigured board.
 * Reads column names from Jira REST API (via background worker).
 */

// @ts-check
/* global chrome */

const BoardConfig = {
  /**
   * Show the configuration modal.
   * @param {string} boardId
   * @param {function} onSave - called with the saved config
   */
  async show(boardId, onSave) {
    console.log('[Jiranimo] Loading board columns from API...');

    // Get columns from Jira API via background worker
    const columns = await this._fetchBoardColumns(boardId);
    console.log('[Jiranimo] Board columns:', columns);

    if (columns.length === 0) {
      console.warn('[Jiranimo] No columns found — falling back to defaults');
      columns.push('To Do', 'In Progress', 'Done');
    }

    // Create overlay
    const overlay = document.createElement('div');
    overlay.className = 'jiranimo-config-overlay';

    const modal = document.createElement('div');
    modal.className = 'jiranimo-config-modal';

    const columnOptions = columns.map(c => `<option value="${c}">${c}</option>`).join('');

    modal.innerHTML = `
      <h2>Configure Jiranimo for this board</h2>

      <label for="jiranimo-in-progress">Which column means "In Progress"?</label>
      <select id="jiranimo-in-progress">
        <option value="">-- Skip --</option>
        ${columnOptions}
      </select>

      <label for="jiranimo-in-review">Which column means "In Review" / "Done"?</label>
      <select id="jiranimo-in-review">
        <option value="">-- Skip --</option>
        ${columnOptions}
      </select>

      <label for="jiranimo-label">Trigger label</label>
      <input id="jiranimo-label" type="text" value="ai-ready" />

      <button id="jiranimo-save-config">Save Configuration</button>
    `;

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    // Pre-select likely columns
    const inProgressSelect = modal.querySelector('#jiranimo-in-progress');
    const inReviewSelect = modal.querySelector('#jiranimo-in-review');
    for (const opt of inProgressSelect.options) {
      if (opt.value.toLowerCase().includes('progress')) { opt.selected = true; break; }
    }
    for (const opt of inReviewSelect.options) {
      if (opt.value.toLowerCase().includes('done') || opt.value.toLowerCase().includes('review')) { opt.selected = true; break; }
    }

    // Close on overlay click
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        overlay.remove();
      }
    });

    // Save handler
    modal.querySelector('#jiranimo-save-config').addEventListener('click', async () => {
      const inProgressCol = inProgressSelect.value;
      const inReviewCol = inReviewSelect.value;
      const label = modal.querySelector('#jiranimo-label').value.trim() || 'ai-ready';

      // Resolve column names to transition IDs
      const transitions = await this._resolveTransitions(inProgressCol, inReviewCol);

      const projectKey = this._extractProjectKey();

      const config = {
        boardId,
        projectKey,
        triggerLabel: label,
        transitions,
      };

      console.log('[Jiranimo] Saving board config:', JSON.stringify(config));
      await chrome.storage.local.set({ [`boardConfig_${boardId}`]: config });

      overlay.remove();
      onSave(config);
    });
  },

  /**
   * Fetch board columns from Jira Agile REST API.
   * Calls the API directly from the content script (session cookies are available).
   * @param {string} boardId
   * @returns {Promise<string[]>}
   */
  async _fetchBoardColumns(boardId) {
    try {
      const host = location.origin; // e.g. "https://niryosef89.atlassian.net"
      const url = `${host}/rest/agile/1.0/board/${boardId}/configuration`;
      console.log('[Jiranimo] Fetching board config from:', url);
      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) {
        console.warn('[Jiranimo] Board config API returned:', res.status);
        return [];
      }
      const data = await res.json();
      const columns = (data.columnConfig?.columns || []).map(c => c.name);
      console.log('[Jiranimo] Columns from API:', columns);
      return columns;
    } catch (err) {
      console.warn('[Jiranimo] Failed to fetch board columns:', err);
      return [];
    }
  },

  /**
   * Try to resolve column names to Jira transition IDs.
   * @param {string} inProgressCol
   * @param {string} inReviewCol
   * @returns {Promise<{inProgress?: {name: string, id: string}, inReview?: {name: string, id: string}}>}
   */
  async _resolveTransitions(inProgressCol, inReviewCol) {
    const result = {};
    if (!inProgressCol && !inReviewCol) return result;

    const sampleKey = this._findSampleIssueKey();
    if (!sampleKey) return result;

    try {
      // Fetch transitions directly from content script (has session cookies)
      const res = await fetch(`${location.origin}/rest/api/3/issue/${sampleKey}/transitions`, { credentials: 'include' });
      if (!res.ok) return result;
      const data = await res.json();
      const transitions = data.transitions || [];

      if (inProgressCol) {
        const match = transitions.find(t =>
          t.name.toLowerCase() === inProgressCol.toLowerCase()
        );
        if (match) result.inProgress = { name: match.name, id: match.id };
      }

      if (inReviewCol) {
        const match = transitions.find(t =>
          t.name.toLowerCase() === inReviewCol.toLowerCase()
        );
        if (match) result.inReview = { name: match.name, id: match.id };
      }
    } catch (err) {
      console.warn('[Jiranimo] Failed to resolve transitions:', err);
    }

    return result;
  },

  /**
   * Find any issue key visible on the board.
   * @returns {string|null}
   */
  _findSampleIssueKey() {
    const keyPattern = /\b[A-Z][A-Z0-9]+-\d+\b/;
    const links = document.querySelectorAll('a[href*="/browse/"]');
    for (const link of links) {
      const match = link.textContent?.match(keyPattern);
      if (match) return match[0];
    }
    const match = document.body.textContent?.match(keyPattern);
    return match ? match[0] : null;
  },

  /**
   * Extract project key from the URL.
   * @returns {string}
   */
  _extractProjectKey() {
    const match = location.pathname.match(/\/projects\/([^/]+)/);
    return match ? match[1] : '';
  },
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { BoardConfig };
} else if (typeof globalThis !== 'undefined') {
  globalThis.BoardConfig = BoardConfig;
}
