/**
 * Jiranimo content script.
 * Runs on Jira sprint board pages.
 * Detects cards with the trigger label (via Jira API) and injects "Implement" badges.
 * Polls the local server for task status updates.
 */

// @ts-check
/* global chrome, BoardConfig */

(function () {
  'use strict';

  const LOG_PREFIX = '[Jiranimo]';
  const log = (...args) => console.log(LOG_PREFIX, ...args);
  const warn = (...args) => console.warn(LOG_PREFIX, ...args);

  const BADGE_ATTR = 'data-jiranimo';
  const SCAN_DEBOUNCE = 500;
  const WS_RECONNECT_DELAY = 3000;

  /** @type {Record<string, string>} taskKey -> status */
  let taskStatuses = {};
  /** @type {Record<string, string>} taskKey -> prUrl */
  let taskPrUrls = {};
  /** @type {string} */
  let serverUrl = 'http://localhost:3456';
  /** @type {string} */
  let triggerLabel = 'ai-ready';
  /** @type {object|null} */
  let boardConfig = null;
  /** @type {number|null} */
  let scanTimer = null;
  /** @type {Record<string, string[]>} issueKey -> labels (cached from API) */
  let labelCache = {};

  async function init() {
    log('Content script loaded on', location.href);

    const settings = await chrome.storage.local.get(['serverUrl', 'defaultTriggerLabel']);
    serverUrl = settings.serverUrl || 'http://localhost:3456';
    triggerLabel = settings.defaultTriggerLabel || 'ai-ready';
    log('Config — serverUrl:', serverUrl, 'triggerLabel:', triggerLabel);

    const boardId = getBoardId();
    if (!boardId) {
      warn('Could not extract board ID from URL');
      return;
    }
    log('Board ID:', boardId);

    const stored = await chrome.storage.local.get([`boardConfig_${boardId}`]);
    boardConfig = stored[`boardConfig_${boardId}`] || null;

    if (!boardConfig) {
      log('No board config found — showing setup modal');
      BoardConfig.show(boardId, (config) => {
        boardConfig = config;
        if (config.triggerLabel) triggerLabel = config.triggerLabel;
        startScanning();
      });
    } else {
      log('Board config loaded:', JSON.stringify(boardConfig));
      if (boardConfig.triggerLabel) triggerLabel = boardConfig.triggerLabel;
      startScanning();
    }
  }

  function getBoardId() {
    const match = location.pathname.match(/\/boards\/(\d+)/);
    return match ? match[1] : null;
  }

  function startScanning() {
    log('Starting card scanner, looking for label:', triggerLabel);
    setTimeout(() => scanCards(), 1000);
    observeCardChanges();
    connectWebSocket();
  }

  function debouncedScan() {
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = setTimeout(() => scanCards(), SCAN_DEBOUNCE);
  }

  async function scanCards() {
    // Find all cards on the board
    const cards = findCards();
    log(`Found ${cards.size} card candidates`);

    // Extract issue keys from all cards
    const cardsByKey = new Map();
    for (const card of cards) {
      if (card.querySelector(`[${BADGE_ATTR}]`)) continue; // already has badge
      const key = extractIssueKey(card);
      if (key) cardsByKey.set(key, card);
    }

    if (cardsByKey.size === 0) return;

    // Fetch labels for uncached keys via Jira API
    const uncachedKeys = [...cardsByKey.keys()].filter(k => !(k in labelCache));
    if (uncachedKeys.length > 0) {
      await fetchLabelsForIssues(uncachedKeys);
    }

    // Inject badges on cards that have the trigger label (one per issue key)
    let matched = 0;
    for (const [key, card] of cardsByKey) {
      // Skip if a badge for this key already exists anywhere on the page
      if (document.querySelector(`[${BADGE_ATTR}="${key}"]`)) continue;
      const labels = labelCache[key] || [];
      if (labels.some(l => l.toLowerCase() === triggerLabel.toLowerCase())) {
        injectBadge(card, key);
        matched++;
      }
    }
    log(`Processed ${cardsByKey.size} cards, ${matched} matched label "${triggerLabel}"`);
  }

  function findCards() {
    const strategies = [
      '[data-testid*="software-board.board"] [data-testid*="card"]',
      '[data-rbd-draggable-id]',
      '[role="listitem"]',
      '[data-testid*="platform-board-kit.ui.card"]',
      '[data-testid*="software-board.card"]',
    ];

    const cards = new Set();
    for (const selector of strategies) {
      for (const el of document.querySelectorAll(selector)) {
        cards.add(el);
      }
    }

    if (cards.size === 0) {
      // Fallback: find issue key links and walk up to card container
      for (const link of document.querySelectorAll('a[href*="/browse/"]')) {
        let container = link.parentElement;
        for (let i = 0; i < 8 && container; i++) {
          if (container.getAttribute('draggable') === 'true' ||
              container.getAttribute('data-rbd-draggable-id') ||
              container.getAttribute('role') === 'listitem') {
            cards.add(container);
            break;
          }
          container = container.parentElement;
        }
      }
    }
    return cards;
  }

  /**
   * Fetch labels for multiple issues via Jira REST API using JQL search.
   */
  async function fetchLabelsForIssues(keys) {
    try {
      const jql = `key in (${keys.join(',')})`;
      const url = `${location.origin}/rest/api/3/search/jql`;
      log('Fetching labels for:', keys.join(', '));
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ jql, fields: ['labels'], maxResults: 50 }),
      });
      if (!res.ok) {
        // Fallback to old search API
        const fallbackUrl = `${location.origin}/rest/api/3/search?jql=${encodeURIComponent(jql)}&fields=labels&maxResults=50`;
        const fallbackRes = await fetch(fallbackUrl, { credentials: 'include' });
        if (fallbackRes.ok) {
          const data = await fallbackRes.json();
          for (const issue of data.issues || []) {
            labelCache[issue.key] = issue.fields?.labels || [];
          }
        }
        return;
      }
      const data = await res.json();
      for (const issue of data.issues || []) {
        labelCache[issue.key] = issue.fields?.labels || [];
        log(`  ${issue.key} labels:`, labelCache[issue.key]);
      }
    } catch (err) {
      warn('Failed to fetch labels:', err);
    }
  }

  /**
   * Fetch full issue details from Jira REST API (content script has session cookies).
   * Returns data ready to POST to the server.
   */
  async function fetchIssueDetails(issueKey) {
    try {
      const fields = 'summary,description,priority,issuetype,labels,comment,status,subtasks,parent,issuelinks,assignee,reporter,components,attachment';
      const url = `${location.origin}/rest/api/3/issue/${issueKey}?fields=${fields}&expand=renderedFields`;
      log('Fetching issue details:', issueKey);
      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) {
        warn('Issue fetch failed:', res.status);
        return null;
      }
      const issue = await res.json();
      const f = issue.fields;

      // Convert ADF description to plain text
      let description = '';
      if (f.description) {
        description = extractTextFromAdf(f.description);
      }
      if (!description && issue.renderedFields?.description) {
        description = issue.renderedFields.description.replace(/<[^>]+>/g, '');
      }

      return {
        key: issueKey,
        summary: f.summary || issueKey,
        description: description || f.summary || '',
        priority: f.priority?.name || 'Medium',
        issueType: f.issuetype?.name || 'Task',
        labels: f.labels || [],
        comments: (f.comment?.comments || []).slice(-10).map(c => ({
          author: c.author?.displayName || 'Unknown',
          body: extractTextFromAdf(c.body),
          created: c.created,
        })),
        subtasks: (f.subtasks || []).map(s => ({
          key: s.key,
          summary: s.fields?.summary || '',
          status: s.fields?.status?.name || '',
        })),
        linkedIssues: (f.issuelinks || []).map(l => {
          const linked = l.outwardIssue || l.inwardIssue;
          return { type: l.type?.outward || 'related', key: linked?.key || '', summary: linked?.fields?.summary || '', status: linked?.fields?.status?.name || '' };
        }).filter(l => l.key),
        attachments: (f.attachment || []).map(a => ({ filename: a.filename, mimeType: a.mimeType, url: a.content })),
        assignee: f.assignee?.displayName || '',
        reporter: f.reporter?.displayName || '',
        components: (f.components || []).map(c => c.name),
        parentKey: f.parent?.key || '',
        jiraUrl: `${location.origin}/browse/${issueKey}`,
        projectKey: issueKey.split('-')[0],
      };
    } catch (err) {
      warn('fetchIssueDetails error:', err);
      return null;
    }
  }

  /**
   * Transition a Jira issue by name. Fetches available transitions,
   * finds the matching one, and executes it. Done directly from the
   * content script so session cookies are available (works in incognito).
   */
  async function transitionIssue(issueKey, transitionName) {
    try {
      log(`Transitioning ${issueKey} to "${transitionName}"`);
      const transRes = await fetch(`${location.origin}/rest/api/3/issue/${issueKey}/transitions`, { credentials: 'include' });
      if (!transRes.ok) { warn('Failed to get transitions:', transRes.status); return; }
      const data = await transRes.json();
      const match = (data.transitions || []).find(t => t.name.toLowerCase() === transitionName.toLowerCase());
      if (!match) { warn(`Transition "${transitionName}" not found. Available:`, (data.transitions || []).map(t => t.name)); return; }
      const execRes = await fetch(`${location.origin}/rest/api/3/issue/${issueKey}/transitions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ transition: { id: match.id } }),
      });
      if (execRes.ok) { log(`Transitioned ${issueKey} to "${match.name}"`); }
      else { warn(`Transition failed: ${execRes.status}`); }
    } catch (err) { warn('transitionIssue error:', err); }
  }

  /**
   * Post a comment on a Jira issue directly from the content script.
   */
  async function postJiraComment(issueKey, text) {
    try {
      await fetch(`${location.origin}/rest/api/3/issue/${issueKey}/comment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] },
        }),
      });
      log(`Comment posted on ${issueKey}`);
    } catch (err) { warn('postJiraComment error:', err); }
  }

  /** Simple recursive ADF text extractor */
  function extractTextFromAdf(node) {
    if (!node) return '';
    if (node.type === 'text') return node.text || '';
    if (node.type === 'hardBreak') return '\n';
    if (Array.isArray(node.content)) return node.content.map(extractTextFromAdf).join('');
    if (node.type === 'doc' && Array.isArray(node.content)) return node.content.map(extractTextFromAdf).join('\n\n');
    return '';
  }

  function extractIssueKey(card) {
    const keyPattern = /\b[A-Z][A-Z0-9]+-\d+\b/;

    for (const attr of ['data-rbd-draggable-id', 'data-testid', 'id']) {
      const val = card.getAttribute(attr) || '';
      const match = val.match(keyPattern);
      if (match) return match[0];
    }

    for (const link of card.querySelectorAll('a[href*="/browse/"]')) {
      const href = link.getAttribute('href') || '';
      const match = href.match(keyPattern);
      if (match) return match[0];
    }

    for (const link of card.querySelectorAll('a')) {
      const match = link.textContent?.match(keyPattern);
      if (match) return match[0];
    }

    const textMatch = card.textContent?.match(keyPattern);
    return textMatch ? textMatch[0] : null;
  }

  function injectBadge(card, issueKey) {
    const badge = document.createElement('div');
    badge.setAttribute(BADGE_ATTR, issueKey);
    badge.className = 'jiranimo-badge idle';
    badge.textContent = '\u26A1 Implement';

    const currentStatus = taskStatuses[issueKey];
    if (currentStatus) {
      updateBadgeState(badge, issueKey, currentStatus);
    }

    badge.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      handleBadgeClick(badge, issueKey);
    });

    card.style.position = card.style.position || 'relative';
    card.appendChild(badge);
    log(`Badge injected for ${issueKey}`);
  }

  async function handleBadgeClick(badge, issueKey) {
    const status = taskStatuses[issueKey];

    if (status === 'failed') {
      badge.className = 'jiranimo-badge sending';
      badge.textContent = 'Retrying...';
      try {
        await fetch(`${serverUrl}/api/tasks/${issueKey}/retry`, { method: 'POST' });
      } catch (err) {
        badge.className = 'jiranimo-badge failed';
        badge.textContent = '\u2717 Error';
      }
      return;
    }

    if (status === 'queued' || status === 'in-progress') return;

    if (status === 'completed' && taskPrUrls[issueKey]) {
      window.open(taskPrUrls[issueKey], '_blank');
      return;
    }

    badge.className = 'jiranimo-badge sending';
    badge.textContent = 'Sending...';

    try {
      // Fetch issue details from the content script (has session cookies)
      const issueData = await fetchIssueDetails(issueKey);
      if (!issueData) {
        badge.className = 'jiranimo-badge failed';
        badge.textContent = '\u2717 Fetch failed';
        setTimeout(() => { badge.className = 'jiranimo-badge idle'; badge.textContent = '\u26A1 Implement'; }, 3000);
        return;
      }

      // Submit directly to the server from the content script
      const res = await fetch(`${serverUrl}/api/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(issueData),
      });

      if (res.ok) {
        badge.className = 'jiranimo-badge queued';
        badge.textContent = 'Queued';
        taskStatuses[issueKey] = 'queued';

        // Transition to In Progress directly (content script has cookies)
        if (boardConfig?.transitions?.inProgress) {
          transitionIssue(issueKey, boardConfig.transitions.inProgress.name);
        }
      } else {
        const err = await res.json().catch(() => ({}));
        badge.className = 'jiranimo-badge failed';
        badge.textContent = '\u2717 ' + (err.error || `Error ${res.status}`);
        setTimeout(() => { badge.className = 'jiranimo-badge idle'; badge.textContent = '\u26A1 Implement'; }, 3000);
      }
    } catch (err) {
      log('Implement failed:', err);
      badge.className = 'jiranimo-badge idle';
      badge.textContent = '\u26A1 Implement';
    }
  }

  function updateBadgeState(badge, issueKey, status) {
    switch (status) {
      case 'queued':
        badge.className = 'jiranimo-badge queued';
        badge.textContent = 'Queued';
        break;
      case 'in-progress':
        badge.className = 'jiranimo-badge in-progress';
        badge.textContent = '\u23F3 Running...';
        break;
      case 'completed':
        badge.className = 'jiranimo-badge completed';
        badge.textContent = '\u2713 PR Ready';
        break;
      case 'failed':
        badge.className = 'jiranimo-badge failed';
        badge.textContent = '\u2717 Failed';
        break;
      default:
        badge.className = 'jiranimo-badge idle';
        badge.textContent = '\u26A1 Implement';
    }
  }

  function observeCardChanges() {
    const observer = new MutationObserver(() => {
      debouncedScan();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    log('MutationObserver attached');
  }

  /** @type {WebSocket|null} */
  let ws = null;

  function connectWebSocket() {
    const wsUrl = serverUrl.replace(/^http/, 'ws') + '/ws';
    log('Connecting WebSocket:', wsUrl);

    try {
      ws = new WebSocket(wsUrl);
    } catch {
      log('WebSocket connection failed, retrying in', WS_RECONNECT_DELAY, 'ms');
      setTimeout(connectWebSocket, WS_RECONNECT_DELAY);
      return;
    }

    ws.onopen = () => {
      log('WebSocket connected');
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleServerMessage(msg);
      } catch {
        // ignore malformed messages
      }
    };

    ws.onclose = () => {
      log('WebSocket disconnected, reconnecting...');
      ws = null;
      setTimeout(connectWebSocket, WS_RECONNECT_DELAY);
    };

    ws.onerror = () => {
      // onclose will fire after this, triggering reconnect
    };
  }

  function handleServerMessage(msg) {
    if (msg.type === 'task-status-changed' || msg.type === 'task-created' || msg.type === 'task-completed') {
      const task = msg.task;
      if (!task?.key) return;

      const oldStatus = taskStatuses[task.key];
      taskStatuses[task.key] = task.status;
      if (task.prUrl) taskPrUrls[task.key] = task.prUrl;

      // Update badge
      const badge = document.querySelector(`[${BADGE_ATTR}="${task.key}"]`);
      if (badge) {
        updateBadgeState(badge, task.key, task.status);
      }

      // Update Jira when task completes: transition + comment with PR link
      if (task.status === 'completed' && oldStatus !== 'completed') {
        if (boardConfig?.transitions?.inReview) {
          transitionIssue(task.key, boardConfig.transitions.inReview.name);
        }
        if (task.prUrl) {
          postJiraComment(task.key, `Draft PR created: ${task.prUrl}\nGenerated by Jiranimo + Claude Code`);
        }
      }

      log(`Task ${task.key}: ${oldStatus || 'new'} → ${task.status}`);
    }

    // Server tells us to update Jira status — we use the board config to pick the right transition
    if (msg.type === 'update-jira-status' && msg.issueKey && msg.pipelineStatus) {
      if (msg.pipelineStatus === 'in-progress' && boardConfig?.transitions?.inProgress) {
        transitionIssue(msg.issueKey, boardConfig.transitions.inProgress.name);
      } else if (msg.pipelineStatus === 'completed' && boardConfig?.transitions?.inReview) {
        transitionIssue(msg.issueKey, boardConfig.transitions.inReview.name);
      }
    }
  }

  init().catch(err => warn('Init failed:', err));
})();
