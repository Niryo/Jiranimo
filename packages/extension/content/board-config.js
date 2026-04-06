/**
 * Guided board configuration UI.
 * Shows a modal on first visit to an unconfigured board.
 * Reads board metadata directly from Jira REST API.
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
    console.log('[Jiranimo] Loading board details from API...');

    const details = await this._fetchBoardDetails(boardId);
    const columns = details.columns.map(column => column.name);
    console.log('[Jiranimo] Board details:', details);

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

      const transitions = await this._resolveTransitions(inProgressCol, inReviewCol);

      const config = {
        boardId,
        transitions,
        todoStatuses: this._inferTodoStatuses(details.columns, inProgressCol),
      };

      console.log('[Jiranimo] Saving board config:', JSON.stringify(config));
      await chrome.storage.local.set({ [`boardConfig_${boardId}`]: config });

      overlay.remove();
      onSave(config);
    });
  },

  /**
   * Ensure older saved configs include inferred todo statuses.
   * @param {string} boardId
   * @param {Record<string, unknown>} config
   * @returns {Promise<Record<string, unknown>>}
   */
  async ensureMetadata(boardId, config) {
    const details = await this._fetchBoardDetails(boardId);
    const enriched = {
      ...config,
      todoStatuses: Array.isArray(config.todoStatuses) && config.todoStatuses.length > 0
        ? config.todoStatuses
        : this._inferTodoStatuses(details.columns, config.transitions?.inProgress?.name),
    };

    if (JSON.stringify(enriched.todoStatuses || []) !== JSON.stringify(config.todoStatuses || [])) {
      await chrome.storage.local.set({ [`boardConfig_${boardId}`]: enriched });
    }

    return enriched;
  },

  /**
   * Fetch board metadata and columns from Jira Agile REST API.
   * Calls the APIs directly from the content script (session cookies are available).
   * @param {string} boardId
   * @returns {Promise<{columns: Array<{name: string, statuses: string[]}>}>}
   */
  async _fetchBoardDetails(boardId) {
    const configUrl = `${location.origin}/rest/agile/1.0/board/${boardId}/configuration`;

    try {
      console.log('[Jiranimo] Fetching board configuration from:', configUrl);

      const configRes = await fetch(configUrl, { credentials: 'include' });
      let columns = [];
      if (configRes.ok) {
        const configData = await configRes.json();
        columns = (configData.columnConfig?.columns || []).map(c => ({
          name: c.name,
          statuses: Array.isArray(c.statuses) ? c.statuses.map(status => status?.name).filter(name => typeof name === 'string') : [],
        }));
      } else {
        console.warn('[Jiranimo] Board config API returned:', configRes.status);
      }

      return { columns };
    } catch (err) {
      console.warn('[Jiranimo] Failed to fetch board details:', err);
      return { columns: [] };
    }
  },

  /**
   * Infer which Jira statuses should count as the board's To Do column.
   * @param {Array<{name: string, statuses: string[]}>} columns
   * @param {string | undefined} inProgressColumnName
   * @returns {string[]}
   */
  _inferTodoStatuses(columns, inProgressColumnName) {
    if (!Array.isArray(columns) || columns.length === 0) {
      return [];
    }

    const normalizedInProgress = typeof inProgressColumnName === 'string' ? inProgressColumnName.trim().toLowerCase() : '';
    const inProgressIndex = normalizedInProgress
      ? columns.findIndex(column => column.name?.trim().toLowerCase() === normalizedInProgress)
      : -1;
    const todoColumns = inProgressIndex > 0 ? columns.slice(0, inProgressIndex) : [columns[0]];

    return [...new Set(
      todoColumns
        .flatMap(column => Array.isArray(column.statuses) ? column.statuses : [])
        .filter(status => typeof status === 'string' && status.trim().length > 0)
    )];
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
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { BoardConfig };
} else if (typeof globalThis !== 'undefined') {
  globalThis.BoardConfig = BoardConfig;
}
