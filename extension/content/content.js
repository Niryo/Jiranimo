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
  const setDebugInfo = (patch) => {
    try {
      globalThis.__jiranimoDebug = { ...(globalThis.__jiranimoDebug || {}), ...patch };
      document.documentElement.setAttribute('data-jiranimo-debug', JSON.stringify(globalThis.__jiranimoDebug));
    } catch {
      // ignore
    }
  };

  const BADGE_ATTR = 'data-jiranimo';
  const SCAN_DEBOUNCE = 500;
  const WS_RECONNECT_DELAY = 3000;
  const SPARKLES_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path fill-rule="evenodd" d="M9 4.5a.75.75 0 01.721.544l.813 2.846a3.75 3.75 0 002.576 2.576l2.846.813a.75.75 0 010 1.442l-2.846.813a3.75 3.75 0 00-2.576 2.576l-.813 2.846a.75.75 0 01-1.442 0l-.813-2.846a3.75 3.75 0 00-2.576-2.576l-2.846-.813a.75.75 0 010-1.442l2.846-.813A3.75 3.75 0 007.466 7.89l.813-2.846A.75.75 0 019 4.5zM18 1.5a.75.75 0 01.728.568l.258 1.036c.236.94.97 1.674 1.91 1.91l1.036.258a.75.75 0 010 1.456l-1.036.258c-.94.236-1.674.97-1.91 1.91l-.258 1.036a.75.75 0 01-1.456 0l-.258-1.036a2.625 2.625 0 00-1.91-1.91l-1.036-.258a.75.75 0 010-1.456l1.036-.258a2.625 2.625 0 001.91-1.91l.258-1.036A.75.75 0 0118 1.5zM16.5 15a.75.75 0 01.712.513l.394 1.183c.15.447.5.799.948.948l1.183.395a.75.75 0 010 1.422l-1.183.395c-.447.15-.799.5-.948.948l-.395 1.183a.75.75 0 01-1.422 0l-.395-1.183a1.5 1.5 0 00-.948-.948l-1.183-.395a.75.75 0 010-1.422l1.183-.395c.447-.15.799-.5.948-.948l.395-1.183A.75.75 0 0116.5 15z" clip-rule="evenodd"/></svg>';

  /** @type {Record<string, string>} taskKey -> status */
  let taskStatuses = {};
  /** @type {Record<string, string>} taskKey -> prUrl */
  let taskPrUrls = {};
  /** @type {Record<string, string>} taskKey -> recoveryState */
  let taskRecoveryStates = {};
  /** @type {number} */
  let serverEpoch = 0;
  /** @type {number} */
  let serverRevision = 0;
  /** @type {string} */
  const clientId = globalThis.crypto?.randomUUID?.() || `client-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  /** @type {string} */
  let serverUrl = 'http://localhost:3456';
  /** @type {boolean} */
  let hasConfiguredServerUrl = false;
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
    if (settings.serverUrl) {
      serverUrl = settings.serverUrl;
      hasConfiguredServerUrl = true;
    } else {
      serverUrl = 'http://localhost:3456';
    }
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

  function buildFallbackIssueDetails(issueKey) {
    const issue = (cachedSprintIssues || []).find(i => i.key === issueKey);
    if (!issue) return null;
    return {
      key: issueKey,
      summary: issue.summary || issueKey,
      description: issue.summary || issueKey,
      priority: 'Medium',
      issueType: 'Task',
      labels: issue.labels || [],
      comments: [],
      subtasks: [],
      linkedIssues: [],
      attachments: [],
      assignee: '',
      reporter: '',
      components: [],
      parentKey: '',
      jiraUrl: `${location.origin}/browse/${issueKey}`,
      projectKey: issueKey.split('-')[0],
    };
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
      if (!transRes.ok) { warn('Failed to get transitions:', transRes.status); return false; }
      const data = await transRes.json();
      const match = (data.transitions || []).find(t => t.name.toLowerCase() === transitionName.toLowerCase());
      if (!match) { warn(`Transition "${transitionName}" not found. Available:`, (data.transitions || []).map(t => t.name)); return false; }
      const execRes = await fetch(`${location.origin}/rest/api/3/issue/${issueKey}/transitions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ transition: { id: match.id } }),
      });
      if (execRes.ok) {
        log(`Transitioned ${issueKey} to "${match.name}"`);
        return true;
      } else {
        warn(`Transition failed: ${execRes.status}`);
        return false;
      }
    } catch (err) { warn('transitionIssue error:', err); }
    return false;
  }

  /**
   * Post a comment on a Jira issue directly from the content script.
   */
  async function postJiraComment(issueKey, text) {
    try {
      const res = await fetch(`${location.origin}/rest/api/3/issue/${issueKey}/comment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] },
        }),
      });
      if (res.ok) {
        log(`Comment posted on ${issueKey}`);
        return true;
      }
      warn(`Comment post failed on ${issueKey}:`, res.status);
    } catch (err) { warn('postJiraComment error:', err); }
    return false;
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
  function resolveServerBaseUrl() {
    if (hasConfiguredServerUrl) return serverUrl;
    if (location.hostname === '127.0.0.1' || location.hostname === 'localhost') {
      return location.origin;
    }
    return serverUrl;
  }

  async function directServerFetch(path, method, body) {
    const baseUrl = resolveServerBaseUrl();
    const res = await fetch(baseUrl + path, {
      method: method || 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  }

  function backgroundServerFetch(path, method, body) {
    return new Promise((resolve, reject) => {
      // @ts-ignore — chrome global is declared at top of file
      if (!chrome?.runtime?.sendMessage) {
        reject(new Error('Background messaging unavailable'));
        return;
      }
      let settled = false;
      const finish = (value, isError) => {
        if (settled) return;
        settled = true;
        if (isError) reject(value);
        else resolve(value);
      };
      chrome.runtime.sendMessage(
        { type: 'server-fetch', path, method: method || 'GET', body },
        // @ts-ignore
        async (response) => {
          // @ts-ignore
          if (chrome.runtime.lastError) {
            finish(new Error(chrome.runtime.lastError.message), true);
            return;
          }
          if (!response || typeof response.ok !== 'boolean') {
            finish(new Error('No valid response from background'), true);
            return;
          }
          finish(response, false);
        }
      );
    });
  }

  async function serverFetch(path, method, body) {
    const errors = [];

    try {
      const response = await backgroundServerFetch(path, method, body);
      if (response.ok) return response;

      // Background path returned a structured failure; fall through and try direct fetch too.
      errors.push(response.error || response.data?.error || `Background fetch failed (${response.status})`);
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }

    try {
      const direct = await directServerFetch(path, method, body);
      if (direct.ok) return direct;
      errors.push(direct.error || direct.data?.error || `Direct fetch failed (${direct.status})`);
      return { ...direct, error: errors.join(' | ') };
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
      throw new Error(errors.join(' | '));
    }
  }

  async function handleBadgeClick(icon, issueKey) {
    setDebugInfo({ issueKey, stage: 'click-start', lastError: null });
    const status = taskStatuses[issueKey];
    const recoveryState = taskRecoveryStates[issueKey];

    if (status === 'failed') {
      setBadgeState(icon, issueKey, 'in-progress', 'Retrying...');
      try {
        await serverFetch(`/api/tasks/${issueKey}/retry`, 'POST');
      } catch (err) {
        setBadgeState(icon, issueKey, 'failed', 'Error — click to retry');
      }
      return;
    }

    if (status === 'interrupted' && recoveryState === 'resume-cancelled') {
      setBadgeState(icon, issueKey, 'in-progress', 'Resuming...');
      try {
        await serverFetch(`/api/tasks/${issueKey}/resume`, 'POST');
      } catch {
        setBadgeState(icon, issueKey, 'interrupted', 'Interrupted');
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
      setDebugInfo({ issueKey, stage: 'fetch-issue-details' });
      let issueData = await fetchIssueDetails(issueKey);
      if (!issueData) {
        setDebugInfo({ issueKey, stage: 'fallback-issue-details' });
        issueData = buildFallbackIssueDetails(issueKey);
        if (!issueData) {
          setDebugInfo({ issueKey, stage: 'fetch-issue-failed', lastError: 'No issue data available' });
          setBadgeState(icon, issueKey, 'failed', 'Failed to fetch issue — click to retry');
          return;
        }
        log('Falling back to minimal issue payload for', issueKey);
      }

      /** @type {any} */
      setDebugInfo({ issueKey, stage: 'submit-task' });
      const result = await serverFetch('/api/tasks', 'POST', issueData);

      if (result.ok) {
        setDebugInfo({ issueKey, stage: 'task-submitted', responseStatus: result.status });
        updateBadgeState(icon, issueKey, 'queued');
        taskStatuses[issueKey] = 'queued';
      } else {
        setDebugInfo({ issueKey, stage: 'submit-failed', lastError: result.error || result.data?.error || `Error ${result.status}` });
        setBadgeState(icon, issueKey, 'failed', (result.data?.error || `Error ${result.status}`) + ' — click to retry');
      }
    } catch (err) {
      warn('Implement failed (is the server running?):', err);
      setDebugInfo({ issueKey, stage: 'submit-exception', lastError: err instanceof Error ? err.message : String(err) });
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
      case 'interrupted':
        icon.className = 'jiranimo-icon failed';
        icon.title = 'Interrupted';
        if (label) label.textContent = 'Interrupted';
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

  async function getIssueStatus(issueKey) {
    try {
      const res = await fetch(`${location.origin}/rest/api/3/issue/${issueKey}?fields=status`, { credentials: 'include' });
      if (!res.ok) return '';
      const issue = await res.json();
      return issue.fields?.status?.name || '';
    } catch {
      return '';
    }
  }

  async function commentAlreadyExists(issueKey, body) {
    try {
      const res = await fetch(`${location.origin}/rest/api/3/issue/${issueKey}/comment?maxResults=50`, { credentials: 'include' });
      if (!res.ok) return false;
      const data = await res.json();
      return (data.comments || []).some(comment => extractTextFromAdf(comment.body).trim() === body.trim());
    } catch {
      return false;
    }
  }

  async function claimEffect(effectId) {
    /** @type {any} */
    const res = await serverFetch(`/api/effects/${effectId}/claim`, 'POST', { clientId });
    return res.ok;
  }

  async function ackEffect(effectId) {
    /** @type {any} */
    const res = await serverFetch(`/api/effects/${effectId}/ack`, 'POST');
    return res.ok;
  }

  async function processEffect(effect) {
    if (effect.type === 'pipeline-status-sync') {
      const pipelineStatus = effect.payload?.pipelineStatus;
      const issueKey = effect.payload?.issueKey;
      if (!issueKey || typeof issueKey !== 'string') return false;

      if (pipelineStatus === 'in-progress' && boardConfig?.transitions?.inProgress) {
        const current = (await getIssueStatus(issueKey)).toLowerCase();
        if (current === boardConfig.transitions.inProgress.name.toLowerCase()) return true;
        return transitionIssue(issueKey, boardConfig.transitions.inProgress.name);
      }

      if (pipelineStatus === 'completed' && boardConfig?.transitions?.inReview) {
        const current = (await getIssueStatus(issueKey)).toLowerCase();
        if (current === boardConfig.transitions.inReview.name.toLowerCase()) return true;
        return transitionIssue(issueKey, boardConfig.transitions.inReview.name);
      }

      return true;
    }

    if (effect.type === 'completion-comment' || effect.type === 'plan-comment') {
      const issueKey = effect.payload?.issueKey;
      const body = effect.payload?.body;
      if (!issueKey || !body || typeof issueKey !== 'string' || typeof body !== 'string') return false;
      const exists = await commentAlreadyExists(issueKey, body);
      if (!exists) {
        return postJiraComment(issueKey, body);
      }
      return true;
    }

    return false;
  }

  async function processPendingEffects(effects) {
    for (const effect of effects || []) {
      if (effect.status === 'claimed' && effect.claimedBy && effect.claimedBy !== clientId) continue;
      const claimed = await claimEffect(effect.id);
      if (!claimed) continue;
      const applied = await processEffect(effect);
      if (applied) {
        await ackEffect(effect.id);
      }
    }
  }

  async function resetTasksMovedToTodo(tasks) {
    const terminalTasks = tasks.filter(t => t.status === 'completed' || t.status === 'failed' || t.status === 'interrupted');
    if (terminalTasks.length === 0) return new Set();

    const resetKeys = new Set();
    try {
      const keys = terminalTasks.map(t => t.key);
      const jql = `key in (${keys.join(',')})`;
      const jiraRes = await fetch(`${location.origin}/rest/api/3/search/jql`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ jql, fields: ['status'], maxResults: 50 }),
      });
      if (!jiraRes.ok) return resetKeys;
      const jiraData = await jiraRes.json();
      for (const issue of jiraData.issues || []) {
        const jiraStatus = issue.fields?.status?.name?.toLowerCase() || '';
        if (jiraStatus.includes('to do') || jiraStatus.includes('todo')) {
          resetKeys.add(issue.key);
          serverFetch(`/api/tasks/${issue.key}`, 'DELETE').catch(() => {});
        }
      }
    } catch {
      // ignore best-effort reset checks
    }
    return resetKeys;
  }

  async function syncTaskStatuses() {
    try {
      /** @type {any} */
      const syncResult = await serverFetch(`/api/sync?jiraHost=${encodeURIComponent(location.host)}`);
      if (!syncResult.ok) return;
      const snapshot = syncResult.data;
      const tasks = Array.isArray(snapshot.tasks) ? snapshot.tasks : [];
      const resetKeys = await resetTasksMovedToTodo(tasks);

      const nextStatuses = {};
      const nextPrUrls = {};
      const nextRecoveryStates = {};

      for (const task of tasks) {
        if (resetKeys.has(task.key)) continue;
        nextStatuses[task.key] = task.status;
        nextRecoveryStates[task.key] = task.recoveryState || 'none';
        if (task.prUrl) nextPrUrls[task.key] = task.prUrl;
      }

      for (const existingKey of Object.keys(taskStatuses)) {
        if (!nextStatuses[existingKey]) {
          const badge = document.querySelector(`[${BADGE_ATTR}="${existingKey}"]`);
          if (badge) updateBadgeState(badge, existingKey, 'idle');
        }
      }

      taskStatuses = nextStatuses;
      taskPrUrls = nextPrUrls;
      taskRecoveryStates = nextRecoveryStates;
      serverEpoch = Number(snapshot.serverEpoch || 0);
      serverRevision = Number(snapshot.revision || 0);

      for (const task of tasks) {
        if (resetKeys.has(task.key)) continue;
        const badge = document.querySelector(`[${BADGE_ATTR}="${task.key}"]`);
        if (badge) {
          updateBadgeState(badge, task.key, task.status);
        }
      }

      await processPendingEffects(snapshot.pendingEffects || []);
      log('Synced', tasks.length, 'tasks from server snapshot', { serverEpoch, serverRevision });
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
      await syncTaskStatuses();
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'sync-needed') {
          const nextEpoch = Number(msg.serverEpoch || 0);
          const nextRevision = Number(msg.revision || 0);
          if (nextEpoch > serverEpoch || nextRevision > serverRevision) {
            void syncTaskStatuses();
          }
        }
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

  init().catch(err => warn('Init failed:', err));
})();
