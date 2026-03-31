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
  const SPARKLES_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path fill-rule="evenodd" d="M9 4.5a.75.75 0 01.721.544l.813 2.846a3.75 3.75 0 002.576 2.576l2.846.813a.75.75 0 010 1.442l-2.846.813a3.75 3.75 0 00-2.576 2.576l-.813 2.846a.75.75 0 01-1.442 0l-.813-2.846a3.75 3.75 0 00-2.576-2.576l-2.846-.813a.75.75 0 010-1.442l2.846-.813A3.75 3.75 0 007.466 7.89l.813-2.846A.75.75 0 019 4.5zM18 1.5a.75.75 0 01.728.568l.258 1.036c.236.94.97 1.674 1.91 1.91l1.036.258a.75.75 0 010 1.456l-1.036.258c-.94.236-1.674.97-1.91 1.91l-.258 1.036a.75.75 0 01-1.456 0l-.258-1.036a2.625 2.625 0 00-1.91-1.91l-1.036-.258a.75.75 0 010-1.456l1.036-.258a2.625 2.625 0 001.91-1.91l.258-1.036A.75.75 0 0118 1.5zM16.5 15a.75.75 0 01.712.513l.394 1.183c.15.447.5.799.948.948l1.183.395a.75.75 0 010 1.422l-1.183.395c-.447.15-.799.5-.948.948l-.395 1.183a.75.75 0 01-1.422 0l-.395-1.183a1.5 1.5 0 00-.948-.948l-1.183-.395a.75.75 0 010-1.422l1.183-.395c.447-.15.799-.5.948-.948l.395-1.183A.75.75 0 0116.5 15z" clip-rule="evenodd"/></svg>';

  /** @type {Record<string, string>} taskKey -> status */
  let taskStatuses = {};
  /** @type {Record<string, string>} taskKey -> prUrl */
  let taskPrUrls = {};

  // Restore task statuses from sessionStorage so animations survive page reloads
  try {
    const saved = JSON.parse(sessionStorage.getItem('jiranimo-statuses') || '{}');
    const savedUrls = JSON.parse(sessionStorage.getItem('jiranimo-prurls') || '{}');
    Object.assign(taskStatuses, saved);
    Object.assign(taskPrUrls, savedUrls);
    log('Restored', Object.keys(saved).length, 'task statuses from sessionStorage');
  } catch { /* ignore */ }

  function persistStatuses() {
    try {
      sessionStorage.setItem('jiranimo-statuses', JSON.stringify(taskStatuses));
      sessionStorage.setItem('jiranimo-prurls', JSON.stringify(taskPrUrls));
    } catch { /* ignore */ }
  }

  /** @type {string} */
  let serverUrl = 'http://localhost:3456';
  /** @type {object|null} */
  let boardConfig = null;
  /** @type {number|null} */
  let scanTimer = null;
  /** @type {string|null} */
  let currentBoardId = null;
  /** @type {Array<{key: string, summary: string, labels: string[]}>|null} */
  let cachedSprintIssues = null;

  async function init() {
    log('Content script loaded on', location.href);

    const settings = await chrome.storage.local.get(['serverUrl']);
    serverUrl = settings.serverUrl || 'http://localhost:3456';
    log('Config — serverUrl:', serverUrl);

    currentBoardId = getBoardId();
    if (!currentBoardId) {
      warn('Could not extract board ID from URL');
      return;
    }
    log('Board ID:', currentBoardId);

    const stored = await chrome.storage.local.get([`boardConfig_${currentBoardId}`]);
    boardConfig = stored[`boardConfig_${currentBoardId}`] || null;

    if (!boardConfig) {
      log('No board config found — showing setup modal');
      BoardConfig.show(currentBoardId, (config) => {
        boardConfig = config;
        startScanning();
      });
    } else {
      log('Board config loaded:', JSON.stringify(boardConfig));
      startScanning();
    }
  }

  function getBoardId() {
    const match = location.pathname.match(/\/boards\/(\d+)/);
    return match ? match[1] : null;
  }

  function startScanning() {
    log('Starting card scanner');
    setTimeout(() => scanCards(), 1000);
    observeCardChanges();
    connectWebSocket();
  }

  function debouncedScan() {
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = setTimeout(() => scanCards(), SCAN_DEBOUNCE);
  }

  async function scanCards() {
    if (!cachedSprintIssues) {
      cachedSprintIssues = await fetchSprintIssues();
    }
    if (!cachedSprintIssues) {
      log('No sprint issues found');
      return;
    }
    log(`Scanning ${cachedSprintIssues.length} sprint issues`);

    const triggerLabel = boardConfig?.triggerLabel;
    let injected = 0;
    for (const issue of cachedSprintIssues) {
      const key = issue.key;
      if (triggerLabel && !issue.labels.includes(triggerLabel)) continue;
      if (document.querySelector(`[${BADGE_ATTR}="${key}"]`)) continue;
      const titleEl = findIssueTitleElement(key);
      if (!titleEl) continue;
      injectBadge(titleEl, key);
      injected++;
    }
    log(`Injected ${injected} badges`);
  }

  async function fetchSprintIssues() {
    try {
      const sprintRes = await fetch(
        `${location.origin}/rest/agile/1.0/board/${currentBoardId}/sprint?state=active`,
        { credentials: 'include' }
      );
      if (!sprintRes.ok) { warn('Failed to fetch active sprint:', sprintRes.status); return null; }
      const sprintData = await sprintRes.json();
      const sprint = sprintData.values?.[0];
      if (!sprint) { warn('No active sprint found'); return null; }
      log('Active sprint:', sprint.name);

      const issueRes = await fetch(
        `${location.origin}/rest/agile/1.0/sprint/${sprint.id}/issue?fields=summary,labels&maxResults=200`,
        { credentials: 'include' }
      );
      if (!issueRes.ok) { warn('Failed to fetch sprint issues:', issueRes.status); return null; }
      const issueData = await issueRes.json();
      return (issueData.issues || []).map(i => ({ key: i.key, summary: i.fields.summary, labels: i.fields.labels || [] }));
    } catch (err) {
      warn('fetchSprintIssues error:', err);
      return null;
    }
  }

  function findIssueTitleElement(issueKey) {
    for (const el of document.querySelectorAll('div, a, span')) {
      if (el.childElementCount === 0 && el.textContent.trim() === issueKey) {
        log(`findIssueTitleElement: found key element for ${issueKey}`);
        return el;
      }
    }
    log(`findIssueTitleElement: no element found for ${issueKey}`);
    return null;
  }

  /**
   * Fetch labels for multiple issues via Jira REST API using JQL search.
   */

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
      if (execRes.ok) {
        log(`Transitioned ${issueKey} to "${match.name}" — refreshing board`);
        // Brief delay for Jira to process, then reload so the card appears in the new column
        setTimeout(() => location.reload(), 500);
      } else {
        warn(`Transition failed: ${execRes.status}`);
      }
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

  /**
   * Post a concise completion comment on the Jira issue.
   * Includes PR link if available, and Claude's result summary if useful.
   */
  async function postCompletionComment(task) {
    const parts = [];

    if (task.prUrl) {
      parts.push(`Draft PR: ${task.prUrl}`);
    }

    // Include Claude's summary if it's substantive (not just "done")
    if (task.claudeResultText) {
      const text = task.claudeResultText.trim();
      // Only include if it's more than a trivial response
      if (text.length > 10 && text.length < 2000) {
        parts.push(text);
      }
    }

    if (task.claudeCostUsd) {
      parts.push(`Cost: $${task.claudeCostUsd.toFixed(2)}`);
    }

    if (task.screenshotFailed) {
      const reason = task.screenshotFailReason ? ` Reason: ${task.screenshotFailReason}` : '';
      parts.push(
        `⚠️ I wasn't able to take a screenshot of the feature.${reason}\n\n` +
        `To add one: reply to this comment with instructions on how to screenshot this feature ` +
        `(e.g. which URL to visit, how to start the dev server, what to click), ` +
        `then click the AI button on this card again.`
      );
    }

    if (parts.length === 0) {
      parts.push('Done');
    }

    parts.push('\n— Jiranimo + Claude Code');

    await postJiraComment(task.key, parts.join('\n\n'));
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

  function injectBadge(titleEl, issueKey) {
    const icon = document.createElement('span');
    icon.setAttribute(BADGE_ATTR, issueKey);
    icon.className = 'jiranimo-icon idle';
    icon.title = 'Implement with AI';
    icon.innerHTML = SPARKLES_SVG;

    const currentStatus = taskStatuses[issueKey];
    if (currentStatus) {
      updateBadgeState(icon, issueKey, currentStatus);
    }

    icon.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      handleBadgeClick(icon, issueKey);
    });

    const wrapper = document.createElement('span');
    wrapper.style.cssText = 'display: inline-flex; align-items: center; flex-direction: row; direction: ltr;';
    titleEl.parentNode.insertBefore(wrapper, titleEl);
    wrapper.appendChild(titleEl);
    wrapper.appendChild(icon);
    log(`Icon injected for ${issueKey}`);
  }

  function setBadgeState(icon, issueKey, status, titleOverride) {
    updateBadgeState(icon, issueKey, status);
    if (titleOverride) icon.title = titleOverride;
  }

  /** Proxy server API calls through the background service worker to avoid
   *  Chrome's Private Network Access block (atlassian.net → localhost).
   * @param {string} path
   * @param {string} [method]
   * @param {unknown} [body]
   */
  function serverFetch(path, method, body) {
    return new Promise((resolve, reject) => {
      // @ts-ignore — chrome global is declared at top of file
      chrome.runtime.sendMessage(
        { type: 'server-fetch', path, method: method || 'GET', body },
        // @ts-ignore
        (response) => {
          // @ts-ignore
          if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
          if (!response) { reject(new Error('No response from background')); return; }
          resolve(response);
        }
      );
    });
  }

  async function handleBadgeClick(icon, issueKey) {
    const status = taskStatuses[issueKey];

    if (status === 'failed') {
      setBadgeState(icon, issueKey, 'in-progress', 'Retrying...');
      try {
        await serverFetch(`/api/tasks/${issueKey}/retry`, 'POST');
      } catch (err) {
        setBadgeState(icon, issueKey, 'failed', 'Error — click to retry');
      }
      return;
    }

    if (status === 'queued' || status === 'in-progress') return;

    if (status === 'completed' && taskPrUrls[issueKey]) {
      window.open(taskPrUrls[issueKey], '_blank');
      return;
    }

    setBadgeState(icon, issueKey, 'in-progress', 'Sending to server...');

    try {
      const issueData = await fetchIssueDetails(issueKey);
      if (!issueData) {
        setBadgeState(icon, issueKey, 'failed', 'Failed to fetch issue — click to retry');
        return;
      }

      /** @type {any} */
      const result = await serverFetch('/api/tasks', 'POST', issueData);

      if (result.ok) {
        updateBadgeState(icon, issueKey, 'queued');
        taskStatuses[issueKey] = 'queued';
        persistStatuses();

        if (boardConfig?.transitions?.inProgress) {
          transitionIssue(issueKey, boardConfig.transitions.inProgress.name);
        }
      } else {
        setBadgeState(icon, issueKey, 'failed', (result.data?.error || `Error ${result.status}`) + ' — click to retry');
      }
    } catch (err) {
      warn('Implement failed (is the server running?):', err);
      setBadgeState(icon, issueKey, 'failed', 'Server offline — click to retry');
    }
  }

  function updateBadgeState(icon, issueKey, status) {
    const label = icon.querySelector('.jiranimo-label');
    switch (status) {
      case 'queued':
        icon.className = 'jiranimo-icon queued';
        icon.title = 'Queued';
        if (label) label.textContent = 'Queued';
        break;
      case 'in-progress':
        icon.className = 'jiranimo-icon in-progress';
        icon.title = 'Running...';
        if (label) label.textContent = 'Running...';
        break;
      case 'completed':
        icon.className = 'jiranimo-icon completed';
        icon.title = 'PR ready — click to open';
        if (label) label.textContent = 'Done';
        break;
      case 'failed':
        icon.className = 'jiranimo-icon failed';
        icon.title = 'Failed — click to retry';
        if (label) label.textContent = 'Failed';
        break;
      default:
        icon.className = 'jiranimo-icon idle';
        icon.title = 'Implement with AI';
        if (label) label.textContent = 'Implement';
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

  async function syncTaskStatuses() {
    try {
      /** @type {any} */
      const syncResult = await serverFetch('/api/tasks');
      if (!syncResult.ok) return;
      const tasks = syncResult.data;

      // Collect completed/failed task keys to check against Jira
      const toCheck = tasks.filter(t => t.status === 'completed' || t.status === 'failed');

      // Check if any completed/failed tasks were moved back to To Do in Jira
      const resetKeys = new Set();
      if (toCheck.length > 0) {
        const keys = toCheck.map(t => t.key);
        try {
          const jql = `key in (${keys.join(',')})`;
          const jiraRes = await fetch(`${location.origin}/rest/api/3/search/jql`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ jql, fields: ['status'], maxResults: 50 }),
          });
          if (jiraRes.ok) {
            const jiraData = await jiraRes.json();
            for (const issue of jiraData.issues || []) {
              const jiraStatus = issue.fields?.status?.name?.toLowerCase() || '';
              if (jiraStatus.includes('to do') || jiraStatus.includes('todo')) {
                log(`${issue.key} moved back to To Do in Jira — resetting`);
                resetKeys.add(issue.key);
                delete taskStatuses[issue.key];
                delete taskPrUrls[issue.key];
                serverFetch(`/api/tasks/${issue.key}`, 'DELETE').catch(() => {});
              }
            }
          }
        } catch {
          // Jira API call failed — skip the check
        }
      }

      for (const task of tasks) {
        if (resetKeys.has(task.key)) continue;
        taskStatuses[task.key] = task.status;
        if (task.prUrl) taskPrUrls[task.key] = task.prUrl;
        const badge = document.querySelector(`[${BADGE_ATTR}="${task.key}"]`);
        if (badge) {
          updateBadgeState(badge, task.key, task.status);
        }
      }
      persistStatuses();
      log('Synced', tasks.length, 'task statuses from server');
    } catch {
      // Server not running
    }
  }

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

    ws.onopen = async () => {
      log('WebSocket connected');
      // Restore task statuses from server (in case page was refreshed)
      await syncTaskStatuses();
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
      persistStatuses();

      // Update badge
      const badge = document.querySelector(`[${BADGE_ATTR}="${task.key}"]`);
      if (badge) {
        updateBadgeState(badge, task.key, task.status);
      }

      // Update Jira when task completes: transition + comment
      if (task.status === 'completed' && oldStatus !== 'completed') {
        if (boardConfig?.transitions?.inReview) {
          transitionIssue(task.key, boardConfig.transitions.inReview.name);
        }
        // Plan tasks: comment is posted via task-plan-ready (after server reads the plan file)
        if (task.taskMode !== 'plan') {
          postCompletionComment(task);
        }
      }

      log(`Task ${task.key}: ${oldStatus || 'new'} → ${task.status}`);
    }

    // Server tells us to update Jira status — only for in-progress (completed is handled by task-status-changed)
    if (msg.type === 'update-jira-status' && msg.issueKey && msg.pipelineStatus) {
      if (msg.pipelineStatus === 'in-progress' && boardConfig?.transitions?.inProgress) {
        transitionIssue(msg.issueKey, boardConfig.transitions.inProgress.name);
      }
    }

    if (msg.type === 'task-plan-ready' && msg.taskKey && msg.planContent) {
      postJiraComment(msg.taskKey, msg.planContent);
    }
  }

  /** Show the About overlay. Pressing Cmd+E (or Ctrl+E) or Escape closes it. */
  function showAboutOverlay() {
    if (document.querySelector('.jiranimo-about-overlay')) return;

    const isMac = navigator.platform.toUpperCase().includes('MAC');
    const shortcutLabel = isMac ? '⌘E' : 'Ctrl+E';

    const overlay = document.createElement('div');
    overlay.className = 'jiranimo-about-overlay';

    const modal = document.createElement('div');
    modal.className = 'jiranimo-about-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', 'About Jiranimo');

    modal.innerHTML = `
      <div class="jiranimo-about-header">
        <svg class="jiranimo-about-logo" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
          <path fill-rule="evenodd" d="M9 4.5a.75.75 0 01.721.544l.813 2.846a3.75 3.75 0 002.576 2.576l2.846.813a.75.75 0 010 1.442l-2.846.813a3.75 3.75 0 00-2.576 2.576l-.813 2.846a.75.75 0 01-1.442 0l-.813-2.846a3.75 3.75 0 00-2.576-2.576l-2.846-.813a.75.75 0 010-1.442l2.846-.813A3.75 3.75 0 007.466 7.89l.813-2.846A.75.75 0 019 4.5zM18 1.5a.75.75 0 01.728.568l.258 1.036c.236.94.97 1.674 1.91 1.91l1.036.258a.75.75 0 010 1.456l-1.036.258c-.94.236-1.674.97-1.91 1.91l-.258 1.036a.75.75 0 01-1.456 0l-.258-1.036a2.625 2.625 0 00-1.91-1.91l-1.036-.258a.75.75 0 010-1.456l1.036-.258a2.625 2.625 0 001.91-1.91l.258-1.036A.75.75 0 0118 1.5zM16.5 15a.75.75 0 01.712.513l.394 1.183c.15.447.5.799.948.948l1.183.395a.75.75 0 010 1.422l-1.183.395c-.447.15-.799.5-.948.948l-.395 1.183a.75.75 0 01-1.422 0l-.395-1.183a1.5 1.5 0 00-.948-.948l-1.183-.395a.75.75 0 010-1.422l1.183-.395c.447-.15.799-.5.948-.948l.395-1.183A.75.75 0 0116.5 15z" clip-rule="evenodd"/>
        </svg>
        <h2 class="jiranimo-about-title">Jiranimo <span class="jiranimo-about-version">v1.0.0</span></h2>
      </div>
      <p class="jiranimo-about-desc">
        Jiranimo connects your Jira sprint board to Claude Code, automatically
        implementing tasks and opening draft pull requests — so you can focus
        on what matters.
      </p>
      <div class="jiranimo-about-section">
        <p class="jiranimo-about-section-title">Keyboard shortcuts</p>
        <div class="jiranimo-about-shortcut-row">
          <span>Show this overlay</span>
          <span class="jiranimo-about-kbd"><kbd>${shortcutLabel}</kbd></span>
        </div>
        <div class="jiranimo-about-shortcut-row">
          <span>Close overlay</span>
          <span class="jiranimo-about-kbd"><kbd>Esc</kbd></span>
        </div>
      </div>
      <button class="jiranimo-about-close">Close</button>
    `;

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    function close() { overlay.remove(); }

    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    modal.querySelector('.jiranimo-about-close').addEventListener('click', close);

    const escHandler = (e) => {
      if (e.key === 'Escape') { close(); document.removeEventListener('keydown', escHandler); }
    };
    document.addEventListener('keydown', escHandler);

    log('About overlay opened');
  }

  // Cmd+E (Mac) / Ctrl+E (Windows/Linux) opens the about overlay
  document.addEventListener('keydown', (e) => {
    if (e.key === 'e' && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      showAboutOverlay();
    }
  });

  init().catch(err => warn('Init failed:', err));
})();
