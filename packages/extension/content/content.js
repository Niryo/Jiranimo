/**
 * Jiranimo content script.
 * Runs on Jira software board-related pages.
 * Detects visible Jira cards in the DOM and injects "Implement" badges on board pages.
 * Polls the local server for task status updates.
 */

// @ts-check
/* global chrome, BoardConfig */

(function () {
  'use strict';

  function extractBoardIdFromPath(pathname) {
    if (typeof pathname !== 'string') return null;
    const match = pathname.match(/\/boards\/(\d+)(?:\/|$)/);
    return match ? match[1] : null;
  }

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
  const FAST_RESCAN_DELAY = 120;
  const WS_RECONNECT_DELAY = 3000;
  const BOARD_REFRESH_DELAY = 1200;
  const LIST_ITEM_SELECTOR = 'li';
  const CARD_SELECTOR = '[data-testid="platform-board-kit.ui.card.card"]';
  const ISSUE_KEY_SELECTOR = '[data-testid="platform-card.common.ui.key.key"], .card-key';
  const ISSUE_SUMMARY_SELECTOR = '[data-component-selector="issue-field-summary-inline-edit.ui.read.static-summary"], .card-summary';
  const BROWSE_LINK_SELECTOR = 'a[href*="/browse/"]';
  const TASK_ITEM_SIGNAL_SELECTOR = [
    CARD_SELECTOR,
    ISSUE_KEY_SELECTOR,
    ISSUE_SUMMARY_SELECTOR,
    BROWSE_LINK_SELECTOR,
  ].join(', ');
  const ISSUE_KEY_PATTERN = /\b[A-Z][A-Z0-9]+-\d+\b/;
  const CARD_ID_PREFIX = 'card-';
  const SPARKLES_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path fill-rule="evenodd" d="M9 4.5a.75.75 0 01.721.544l.813 2.846a3.75 3.75 0 002.576 2.576l2.846.813a.75.75 0 010 1.442l-2.846.813a3.75 3.75 0 00-2.576 2.576l-.813 2.846a.75.75 0 01-1.442 0l-.813-2.846a3.75 3.75 0 00-2.576-2.576l-2.846-.813a.75.75 0 010-1.442l2.846-.813A3.75 3.75 0 007.466 7.89l.813-2.846A.75.75 0 019 4.5zM18 1.5a.75.75 0 01.728.568l.258 1.036c.236.94.97 1.674 1.91 1.91l1.036.258a.75.75 0 010 1.456l-1.036.258c-.94.236-1.674.97-1.91 1.91l-.258 1.036a.75.75 0 01-1.456 0l-.258-1.036a2.625 2.625 0 00-1.91-1.91l-1.036-.258a.75.75 0 010-1.456l1.036-.258a2.625 2.625 0 001.91-1.91l.258-1.036A.75.75 0 0118 1.5zM16.5 15a.75.75 0 01.712.513l.394 1.183c.15.447.5.799.948.948l1.183.395a.75.75 0 010 1.422l-1.183.395c-.447.15-.799.5-.948.948l-.395 1.183a.75.75 0 01-1.422 0l-.395-1.183a1.5 1.5 0 00-.948-.948l-1.183-.395a.75.75 0 010-1.422l1.183-.395c.447-.15.799-.5.948-.948l.395-1.183A.75.75 0 0116.5 15z" clip-rule="evenodd"/></svg>';

  /** @type {Record<string, string>} taskKey -> status */
  let taskStatuses = {};
  /** @type {Set<string>} */
  const pinnedBadgeIssueKeys = new Set();
  /** @type {Record<string, string>} taskKey -> prUrl */
  let taskPrUrls = {};
  /** @type {Record<string, string>} taskKey -> recoveryState */
  let taskRecoveryStates = {};
  /** @type {Record<string, boolean>} taskKey -> continue-work state */
  let taskContinueStates = {};
  /** @type {Record<string, any>} taskKey -> task snapshot */
  let taskSnapshots = {};
  /** @type {Map<string, { status: string; fetchedAt: number }>} */
  const issueStatusCache = new Map();
  /** @type {number} */
  let continueStateRefreshToken = 0;
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
  let boardRefreshTimer = null;
  /** @type {string|null} */
  let currentBoardId = null;
  /** @type {MutationObserver|null} */
  let cardObserver = null;
  /** @type {boolean} */
  let routeMonitoringStarted = false;
  /** @type {number|null} */
  let routePollInterval = null;
  /** @type {string|null} */
  let activeTaskModalIssueKey = null;
  /** @type {'details' | 'log'} */
  let activeTaskModalView = 'details';
  /** @type {string|null} */
  let activeTaskModalFullLogText = null;
  /** @type {string|null} */
  let activeTaskModalCompactLogText = null;
  /** @type {'compact' | 'full'} */
  let activeTaskModalLogTab = 'compact';
  /** @type {boolean} */
  let taskModalKeyListenerRegistered = false;
  /** @type {{ effectId: string; issueKey: string; detectedRepoName: string; repoOptions: Array<{ name: string; hint: string }>; canChangeRepo: boolean; expiresAt?: string; paused: boolean; expanded: boolean; isSubmitting: boolean; errorMessage: string; selectedRepoName: string; countdownTimer: number|null } | null} */
  let activeRepoConfirmation = null;

  function clearRepoConfirmationBannerTimer() {
    if (!activeRepoConfirmation?.countdownTimer) return;
    clearInterval(activeRepoConfirmation.countdownTimer);
    activeRepoConfirmation.countdownTimer = null;
  }

  function dismissRepoConfirmationBanner(effectId) {
    if (effectId && activeRepoConfirmation?.effectId !== effectId) return;
    clearRepoConfirmationBannerTimer();
    activeRepoConfirmation = null;
    const banner = document.querySelector('.jiranimo-repo-banner-shell');
    if (banner) banner.remove();
  }

  function formatRepoCountdown(expiresAt) {
    if (!expiresAt) return 'Starting automatically soon.';
    const remainingMs = new Date(expiresAt).getTime() - Date.now();
    if (remainingMs <= 0) return 'Starting now...';
    const remainingSeconds = Math.max(1, Math.ceil(remainingMs / 1000));
    return `Starting automatically in ${remainingSeconds}s.`;
  }

  function formatRepoBannerStatus() {
    if (!activeRepoConfirmation) return '';
    if (activeRepoConfirmation.paused) {
      return activeRepoConfirmation.expanded
        ? 'Choose a repo to continue.'
        : 'Auto-start paused while you pick a repo.';
    }
    return formatRepoCountdown(activeRepoConfirmation.expiresAt);
  }

  function focusRepoPicker(shell) {
    const select = shell.querySelector('.jiranimo-repo-picker-select');
    if (select instanceof HTMLSelectElement) {
      setTimeout(() => select.focus(), 0);
    }
  }

  function ensureRepoConfirmationBanner() {
    let shell = document.querySelector('.jiranimo-repo-banner-shell');
    if (shell) return shell;

    shell = document.createElement('div');
    shell.className = 'jiranimo-repo-banner-shell';
    shell.innerHTML = `
      <section class="jiranimo-repo-banner" role="status" aria-live="polite">
        <div class="jiranimo-repo-banner-main">
          <div class="jiranimo-repo-banner-copy">
            <span class="jiranimo-repo-banner-kicker">Repo detected</span>
            <span class="jiranimo-repo-banner-title"></span>
            <span class="jiranimo-repo-countdown"></span>
          </div>
          <div class="jiranimo-repo-banner-actions">
            <button type="button" class="jiranimo-repo-btn jiranimo-repo-btn-primary" data-jiranimo-repo-action="expand">Change repo</button>
            <div class="jiranimo-repo-picker" hidden>
              <div class="jiranimo-repo-picker-controls">
                <select
                  id="jiranimo-repo-picker-select"
                  class="jiranimo-repo-picker-select"
                ></select>
                <button
                  type="button"
                  class="jiranimo-repo-icon-btn"
                  data-jiranimo-repo-action="change"
                  aria-label="Confirm repository"
                  title="Confirm repository"
                >✓</button>
                <button type="button" class="jiranimo-repo-link" data-jiranimo-repo-action="collapse">Cancel</button>
              </div>
            </div>
            <button type="button" class="jiranimo-repo-link" data-jiranimo-repo-action="cancel">Stop run</button>
          </div>
        </div>
        <p class="jiranimo-repo-banner-error" hidden></p>
      </section>
    `;

    shell.addEventListener('click', (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const action = target.getAttribute('data-jiranimo-repo-action');
      if (!action || !activeRepoConfirmation || activeRepoConfirmation.isSubmitting) return;

      if (action === 'expand') {
        void beginRepoChangeFlow(shell);
        return;
      }

      if (action === 'collapse') {
        activeRepoConfirmation.expanded = false;
        activeRepoConfirmation.errorMessage = '';
        renderRepoConfirmationBanner();
        return;
      }

      if (action === 'cancel') {
        void submitRepoConfirmationResponse('cancel');
        return;
      }

      if (action === 'change') {
        const select = shell.querySelector('.jiranimo-repo-picker-select');
        const repoName = select instanceof HTMLSelectElement ? select.value.trim() : '';
        void submitRepoChoice(repoName);
      }
    });

    shell.addEventListener('change', (event) => {
      const target = event.target;
      if (!(target instanceof HTMLSelectElement) || !activeRepoConfirmation) return;
      if (!target.classList.contains('jiranimo-repo-picker-select')) return;
      activeRepoConfirmation.selectedRepoName = target.value;
    });

    document.body.appendChild(shell);
    return shell;
  }

  function renderRepoConfirmationBanner() {
    if (!activeRepoConfirmation) {
      dismissRepoConfirmationBanner();
      return;
    }

    const shell = ensureRepoConfirmationBanner();
    const title = shell.querySelector('.jiranimo-repo-banner-title');
    const countdown = shell.querySelector('.jiranimo-repo-countdown');
    const error = shell.querySelector('.jiranimo-repo-banner-error');
    const picker = shell.querySelector('.jiranimo-repo-picker');
    const select = shell.querySelector('.jiranimo-repo-picker-select');
    const buttons = shell.querySelectorAll('button');
    const primaryButton = shell.querySelector('[data-jiranimo-repo-action="expand"]');
    const canChangeRepo = activeRepoConfirmation.canChangeRepo;

    if (title) {
      title.textContent = canChangeRepo
        ? activeRepoConfirmation.detectedRepoName
        : `Operating on the only repo found: ${activeRepoConfirmation.detectedRepoName}`;
    }
    if (countdown) {
      countdown.textContent = formatRepoBannerStatus();
    }
    if (primaryButton instanceof HTMLButtonElement) {
      primaryButton.hidden = activeRepoConfirmation.expanded || !canChangeRepo;
    }
    if (error) {
      const hasError = Boolean(activeRepoConfirmation.errorMessage);
      error.textContent = activeRepoConfirmation.errorMessage;
      error.hidden = !hasError;
    }
    if (picker) {
      picker.hidden = !activeRepoConfirmation.expanded || !canChangeRepo;
    }
    if (select instanceof HTMLSelectElement) {
      const previousValue = activeRepoConfirmation.selectedRepoName || select.value;
      select.innerHTML = '';
      for (const option of activeRepoConfirmation.repoOptions) {
        const el = document.createElement('option');
        el.value = option.name;
        el.textContent = option.hint || option.name;
        select.appendChild(el);
      }
      select.value = activeRepoConfirmation.repoOptions.some((option) => option.name === previousValue)
        ? previousValue
        : activeRepoConfirmation.detectedRepoName;
      activeRepoConfirmation.selectedRepoName = select.value;
    }

    shell.classList.toggle('is-expanded', activeRepoConfirmation.expanded);
    shell.classList.toggle('is-busy', activeRepoConfirmation.isSubmitting);

    for (const button of buttons) {
      button.toggleAttribute('disabled', activeRepoConfirmation.isSubmitting);
    }
  }

  function showRepoConfirmationBanner(effect) {
    dismissRepoConfirmationBanner();

    const payload = effect.payload || {};
    const repoOptions = Array.isArray(payload.repoOptions)
      ? payload.repoOptions
        .filter((option) => option && typeof option.name === 'string')
        .map((option) => ({
          name: option.name,
          hint: typeof option.hint === 'string' ? option.hint : option.name,
        }))
      : [];

    activeRepoConfirmation = {
      effectId: effect.id,
      issueKey: typeof payload.issueKey === 'string' ? payload.issueKey : effect.taskKey,
      detectedRepoName: typeof payload.detectedRepoName === 'string' ? payload.detectedRepoName : 'Detected repo',
      repoOptions,
      canChangeRepo: repoOptions.length > 1,
      expiresAt: typeof payload.expiresAt === 'string' ? payload.expiresAt : undefined,
      paused: payload.paused === true,
      expanded: false,
      isSubmitting: false,
      errorMessage: '',
      selectedRepoName: typeof payload.detectedRepoName === 'string'
        ? payload.detectedRepoName
        : (repoOptions[0]?.name || ''),
      countdownTimer: null,
    };

    renderRepoConfirmationBanner();

    if (!activeRepoConfirmation.paused) {
      activeRepoConfirmation.countdownTimer = setInterval(() => {
        if (!activeRepoConfirmation || activeRepoConfirmation.effectId !== effect.id) return;
        if (activeRepoConfirmation.expiresAt && new Date(activeRepoConfirmation.expiresAt).getTime() <= Date.now()) {
          dismissRepoConfirmationBanner(effect.id);
          return;
        }
        renderRepoConfirmationBanner();
      }, 250);
    }
  }

  async function postRepoConfirmationResponse(action, repoName) {
    if (!activeRepoConfirmation) {
      throw new Error('No active repo confirmation.');
    }

    /** @type {any} */
    const response = await serverFetch(`/api/tasks/${activeRepoConfirmation.issueKey}/repo-confirmation`, 'POST', {
      action,
      ...(repoName ? { repoName } : {}),
    });
    if (!response.ok) {
      throw new Error(response.error || response.data?.error || `Error ${response.status}`);
    }
    return response.data || {};
  }

  async function beginRepoChangeFlow(shell) {
    if (!activeRepoConfirmation) return;

    if (activeRepoConfirmation.paused) {
      activeRepoConfirmation.expanded = true;
      activeRepoConfirmation.errorMessage = '';
      renderRepoConfirmationBanner();
      focusRepoPicker(shell || ensureRepoConfirmationBanner());
      return;
    }

    activeRepoConfirmation.isSubmitting = true;
    activeRepoConfirmation.errorMessage = '';
    renderRepoConfirmationBanner();

    try {
      await postRepoConfirmationResponse('pause');
      if (!activeRepoConfirmation) return;
      clearRepoConfirmationBannerTimer();
      activeRepoConfirmation.paused = true;
      activeRepoConfirmation.expiresAt = undefined;
      activeRepoConfirmation.expanded = true;
      activeRepoConfirmation.isSubmitting = false;
      renderRepoConfirmationBanner();
      focusRepoPicker(shell || ensureRepoConfirmationBanner());
    } catch (err) {
      if (!activeRepoConfirmation) return;
      activeRepoConfirmation.isSubmitting = false;
      activeRepoConfirmation.errorMessage = err instanceof Error ? err.message : 'Could not update the repository choice.';
      renderRepoConfirmationBanner();
    }
  }

  async function submitRepoConfirmationResponse(action, repoName) {
    if (!activeRepoConfirmation) return;

    activeRepoConfirmation.isSubmitting = true;
    activeRepoConfirmation.errorMessage = '';
    renderRepoConfirmationBanner();

    try {
      await postRepoConfirmationResponse(action, repoName);
      dismissRepoConfirmationBanner(activeRepoConfirmation.effectId);
      await syncTaskStatuses();
    } catch (err) {
      if (!activeRepoConfirmation) return;
      activeRepoConfirmation.isSubmitting = false;
      activeRepoConfirmation.errorMessage = err instanceof Error ? err.message : 'Could not update the repository choice.';
      renderRepoConfirmationBanner();
    }
  }

  async function submitRepoChoice(repoName) {
    if (!activeRepoConfirmation) return;
    const normalizedRepoName = repoName.trim();
    if (!normalizedRepoName) {
      activeRepoConfirmation.errorMessage = 'Select a repository to continue.';
      renderRepoConfirmationBanner();
      return;
    }

    if (normalizedRepoName === activeRepoConfirmation.detectedRepoName) {
      await submitRepoConfirmationResponse('confirm');
      return;
    }

    await submitRepoConfirmationResponse('change', normalizedRepoName);
  }

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
    return extractBoardIdFromPath(location.pathname);
  }

  function startScanning() {
    log('Starting card scanner');
    observeCardChanges();
    scanTaskListItems(document);
    setTimeout(() => {
      scanTaskListItems(document);
    }, FAST_RESCAN_DELAY);
    connectWebSocket();
  }

  function scanTaskListItems(root = document) {
    const taskItems = root.querySelectorAll(LIST_ITEM_SELECTOR);
    log(`Scanning ${taskItems.length} list items`);

    let injected = 0;
    for (const taskItem of taskItems) {
      if (processTaskListItem(taskItem)) {
        injected++;
      }
    }
    log(`Injected ${injected} badges`);
    void refreshContinueBadgeStates();
  }

  function processTaskListItem(taskItem) {
    if (!(taskItem instanceof Element) || taskItem.localName !== 'li') return false;
    const issueKey = extractIssueKeyFromTaskItem(taskItem);
    if (!issueKey) return false;
    if (!isTaskItemInLeftmostColumn(taskItem) && !shouldPreserveBadgeForIssue(issueKey)) {
      removeBadgeFromTaskItem(taskItem, issueKey);
      return false;
    }
    if (taskItem.querySelector(`[${BADGE_ATTR}]`)) return false;
    return injectBadge(taskItem, issueKey);
  }

  function extractIssueKeyFromElement(element) {
    if (!(element instanceof Element)) return null;

    const cardId = element.getAttribute('id')?.trim();
    if (cardId?.startsWith(CARD_ID_PREFIX)) {
      const keyFromId = cardId.slice(CARD_ID_PREFIX.length);
      if (ISSUE_KEY_PATTERN.test(keyFromId)) return keyFromId;
    }

    const draggableId = element.getAttribute('data-rbd-draggable-id')?.trim();
    if (draggableId && ISSUE_KEY_PATTERN.test(draggableId)) {
      return draggableId;
    }
    return null;
  }

  function findOwnedElement(taskItem, selector) {
    if (!(taskItem instanceof Element)) return null;
    if (taskItem.matches(selector)) return taskItem;

    const firstMatch = taskItem.querySelector(selector);
    if (!firstMatch) return null;
    if (firstMatch.closest(LIST_ITEM_SELECTOR) === taskItem) return firstMatch;

    for (const match of taskItem.querySelectorAll(selector)) {
      if (match.closest(LIST_ITEM_SELECTOR) === taskItem) return match;
    }
    return null;
  }

  function isTaskListItemCandidate(taskItem) {
    if (!(taskItem instanceof Element) || taskItem.localName !== 'li') return false;
    if (taskItem.querySelector(`[${BADGE_ATTR}]`)) return false;
    if (extractIssueKeyFromElement(taskItem)) return true;
    return Boolean(findOwnedElement(taskItem, TASK_ITEM_SIGNAL_SELECTOR));
  }

  function extractIssueKeyFromTaskItem(taskItem) {
    const ownKey = extractIssueKeyFromElement(taskItem);
    if (ownKey) return ownKey;

    const card = findOwnedElement(taskItem, CARD_SELECTOR);
    const keyFromCard = extractIssueKeyFromElement(card);
    if (keyFromCard) return keyFromCard;

    const browseLink = findOwnedElement(taskItem, BROWSE_LINK_SELECTOR);
    const href = browseLink?.getAttribute('href') || '';
    const hrefMatch = href.match(/\/browse\/([A-Z][A-Z0-9]+-\d+)/);
    if (hrefMatch) return hrefMatch[1];

    const keyText = findOwnedElement(taskItem, ISSUE_KEY_SELECTOR)?.textContent?.trim();
    if (!keyText) return null;
    const textMatch = keyText.match(ISSUE_KEY_PATTERN);
    return textMatch ? textMatch[0] : null;
  }

  function findIssueSummaryElement(taskItem) {
    if (!taskItem) return null;
    return findOwnedElement(taskItem, ISSUE_SUMMARY_SELECTOR);
  }

  function hasColumnStructureSignal(element) {
    if (!(element instanceof Element)) return false;
    return Boolean(
      extractIssueKeyFromTaskItem(element)
      || element.querySelector(CARD_SELECTOR)
      || element.querySelector(BROWSE_LINK_SELECTOR)
      || element.querySelector('ul')
      || element.querySelector('ol')
      || element.querySelector('[role="list"]')
    );
  }

  function findTaskColumnElement(taskItem) {
    let current = taskItem.parentElement;
    while (current && current.parentElement) {
      const siblings = [...current.parentElement.children]
        .filter((child) => child.localName === current.localName && hasColumnStructureSignal(child));
      if (siblings.length >= 2 && siblings.includes(current)) {
        return current;
      }
      current = current.parentElement;
    }
    return null;
  }

  function isTaskItemInLeftmostColumn(taskItem) {
    const column = findTaskColumnElement(taskItem);
    if (!column?.parentElement) {
      return true;
    }

    const columns = [...column.parentElement.children]
      .filter((child) => child.localName === column.localName && hasColumnStructureSignal(child));
    return columns[0] === column;
  }

  function shouldPreserveBadgeForIssue(issueKey) {
    return pinnedBadgeIssueKeys.has(issueKey) || Boolean(taskStatuses[issueKey]);
  }

  function isIssueInTodoColumn(issueKey) {
    const taskItem = findTaskItemByIssueKey(issueKey);
    if (!taskItem) {
      return false;
    }
    return isTaskItemInLeftmostColumn(taskItem);
  }

  function findBadgeHost(taskItem) {
    return (
      findOwnedElement(taskItem, ISSUE_KEY_SELECTOR) ||
      findIssueSummaryElement(taskItem)
    );
  }

  function removeBadgeFromTaskItem(taskItem, issueKey) {
    const badge = taskItem.querySelector(`[${BADGE_ATTR}="${issueKey}"]`);
    if (!badge) return;

    const slot = badge.closest('.jiranimo-badge-slot');
    if (slot) {
      slot.remove();
      return;
    }

    badge.remove();
  }

  function findTaskItemByIssueKey(issueKey) {
    for (const taskItem of document.querySelectorAll(LIST_ITEM_SELECTOR)) {
      if (extractIssueKeyFromTaskItem(taskItem) === issueKey) {
        return taskItem;
      }
    }
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
      };
    } catch (err) {
      warn('fetchIssueDetails error:', err);
      return null;
    }
  }

  function buildFallbackIssueDetails(issueKey) {
    const taskItem = findTaskItemByIssueKey(issueKey);
    const summary = findIssueSummaryElement(taskItem)?.textContent?.trim() || issueKey;
    return {
      key: issueKey,
      summary,
      description: summary,
      priority: 'Medium',
      issueType: 'Task',
      labels: [],
      comments: [],
      subtasks: [],
      linkedIssues: [],
      attachments: [],
      assignee: '',
      reporter: '',
      components: [],
      parentKey: '',
      jiraUrl: `${location.origin}/browse/${issueKey}`,
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

  function injectBadge(card, issueKey) {
    const host = findBadgeHost(card);
    if (!host) {
      log(`injectBadge: no host found for ${issueKey}`);
      return false;
    }

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

    const slot = document.createElement('span');
    slot.className = 'jiranimo-badge-slot';
    slot.appendChild(icon);

    host.insertAdjacentElement('afterend', slot);
    log(`Icon injected for ${issueKey}`);
    return true;
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

  async function directServerFetchText(path, method, body) {
    const baseUrl = resolveServerBaseUrl();
    const res = await fetch(baseUrl + path, {
      method: method || 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text().catch(() => '');
    return { ok: res.ok, status: res.status, text };
  }

  function backgroundServerFetch(path, method, body, responseType = 'json') {
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
        { type: 'server-fetch', path, method: method || 'GET', body, responseType },
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

  async function serverFetchText(path, method, body) {
    const errors = [];

    try {
      const response = await backgroundServerFetch(path, method, body, 'text');
      if (response.ok) return response;
      errors.push(response.error || `Background fetch failed (${response.status})`);
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }

    try {
      const direct = await directServerFetchText(path, method, body);
      if (direct.ok) return direct;
      errors.push(`Direct fetch failed (${direct.status})`);
      return { ...direct, error: errors.join(' | ') };
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
      throw new Error(errors.join(' | '));
    }
  }

  function clearElement(element) {
    if (!(element instanceof HTMLElement)) return;
    while (element.firstElementChild) {
      element.removeChild(element.firstElementChild);
    }
    element.textContent = '';
  }

  function ensureBodyStyle() {
    if (!document.body.style) {
      document.body.style = {};
    }
    return document.body.style;
  }

  function getTaskTimestampMs(task, fields) {
    for (const field of fields || ['updatedAt', 'completedAt', 'createdAt']) {
      const value = task?.[field];
      const timestamp = typeof value === 'string' ? Date.parse(value) : Number.NaN;
      if (Number.isFinite(timestamp)) return timestamp;
    }
    return 0;
  }

  function formatRelativeTime(timestamp) {
    if (!Number.isFinite(timestamp) || timestamp <= 0) return 'recently';

    const elapsedMs = Math.max(0, Date.now() - timestamp);
    const minutes = Math.floor(elapsedMs / (60 * 1000));
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;

    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;

    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d ago`;

    const months = Math.floor(days / 30);
    return `${months}mo ago`;
  }

  function formatTaskAge(task) {
    if (!task) return 'Updated recently';
    if (task.status === 'completed') {
      return `Completed ${formatRelativeTime(getTaskTimestampMs(task, ['completedAt', 'updatedAt', 'createdAt']))}`;
    }
    return `Updated ${formatRelativeTime(getTaskTimestampMs(task, ['updatedAt', 'createdAt']))}`;
  }

  function openTab(url, fallbackMessage) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'open-tab', url }, (response) => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        if (!response?.ok) {
          reject(new Error(response?.error || fallbackMessage || 'Failed to open tab'));
          return;
        }
        resolve(response);
      });
    });
  }

  function createTaskModalButton(label, className, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.textContent = label;
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      onClick(button);
    });
    return button;
  }

  function resetTaskModalLogState() {
    activeTaskModalFullLogText = null;
    activeTaskModalCompactLogText = null;
    activeTaskModalLogTab = 'compact';
  }

  function getTaskModalElements() {
    const overlay = document.querySelector('.jiranimo-task-modal-overlay');
    if (!(overlay instanceof HTMLElement)) return null;
    const dialog = overlay.querySelector('.jiranimo-task-modal');
    const title = overlay.querySelector('.jiranimo-task-modal-title');
    const subtitle = overlay.querySelector('.jiranimo-task-modal-subtitle');
    const tabs = overlay.querySelector('.jiranimo-task-modal-log-tabs');
    const tabCompact = overlay.querySelector('.jiranimo-task-modal-log-tab-compact');
    const tabFull = overlay.querySelector('.jiranimo-task-modal-log-tab-full');
    const copy = overlay.querySelector('.jiranimo-task-modal-copy');
    const back = overlay.querySelector('.jiranimo-task-modal-back');
    const feedback = overlay.querySelector('.jiranimo-task-modal-feedback');
    const body = overlay.querySelector('.jiranimo-task-modal-body');
    if (
      !(dialog instanceof HTMLElement) ||
      !(title instanceof HTMLElement) ||
      !(subtitle instanceof HTMLElement) ||
      !(tabs instanceof HTMLElement) ||
      !(tabCompact instanceof HTMLButtonElement) ||
      !(tabFull instanceof HTMLButtonElement) ||
      !(copy instanceof HTMLButtonElement) ||
      !(back instanceof HTMLButtonElement) ||
      !(feedback instanceof HTMLElement) ||
      !(body instanceof HTMLElement)
    ) {
      return null;
    }
    return { overlay, dialog, title, subtitle, tabs, tabCompact, tabFull, copy, back, feedback, body };
  }

  function closeTaskModal() {
    const elements = getTaskModalElements();
    if (elements) {
      elements.overlay.setAttribute('hidden', '');
      elements.dialog.className = 'jiranimo-task-modal';
      elements.tabs.setAttribute('hidden', '');
      elements.copy.setAttribute('hidden', '');
      elements.back.setAttribute('hidden', '');
      elements.tabCompact.className = 'jiranimo-task-modal-log-tab jiranimo-task-modal-log-tab-compact';
      elements.tabFull.className = 'jiranimo-task-modal-log-tab jiranimo-task-modal-log-tab-full';
      clearElement(elements.feedback);
      elements.feedback.setAttribute('hidden', '');
    }
    activeTaskModalIssueKey = null;
    activeTaskModalView = 'details';
    resetTaskModalLogState();
    ensureBodyStyle().overflow = '';
  }

  function setTaskModalFeedback(message, tone) {
    const elements = getTaskModalElements();
    if (!elements) return;
    clearElement(elements.feedback);
    if (!message) {
      elements.feedback.setAttribute('hidden', '');
      elements.feedback.className = 'jiranimo-task-modal-feedback';
      return;
    }
    elements.feedback.className = `jiranimo-task-modal-feedback ${tone === 'error' ? 'is-error' : 'is-success'}`;
    elements.feedback.textContent = message;
    elements.feedback.removeAttribute('hidden');
  }

  function ensureTaskModal() {
    const existing = getTaskModalElements();
    if (existing) return existing;

    const overlay = document.createElement('div');
    overlay.className = 'jiranimo-task-modal-overlay';
    overlay.setAttribute('hidden', '');

    const dialog = document.createElement('section');
    dialog.className = 'jiranimo-task-modal';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');

    const header = document.createElement('div');
    header.className = 'jiranimo-task-modal-header';

    const titleWrap = document.createElement('div');
    titleWrap.className = 'jiranimo-task-modal-heading';

    const title = document.createElement('div');
    title.className = 'jiranimo-task-modal-title';

    const subtitle = document.createElement('div');
    subtitle.className = 'jiranimo-task-modal-subtitle';

    titleWrap.appendChild(title);
    titleWrap.appendChild(subtitle);

    const actions = document.createElement('div');
    actions.className = 'jiranimo-task-modal-header-actions';

    const tabs = document.createElement('div');
    tabs.className = 'jiranimo-task-modal-log-tabs';
    tabs.setAttribute('hidden', '');

    const compactTab = document.createElement('button');
    compactTab.type = 'button';
    compactTab.className = 'jiranimo-task-modal-log-tab jiranimo-task-modal-log-tab-compact';
    compactTab.textContent = 'Compact';
    compactTab.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      switchTaskModalLogTab('compact');
    });

    const fullTab = document.createElement('button');
    fullTab.type = 'button';
    fullTab.className = 'jiranimo-task-modal-log-tab jiranimo-task-modal-log-tab-full';
    fullTab.textContent = 'Full';
    fullTab.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      switchTaskModalLogTab('full');
    });

    tabs.appendChild(compactTab);
    tabs.appendChild(fullTab);

    const copyButton = document.createElement('button');
    copyButton.type = 'button';
    copyButton.className = 'jiranimo-task-modal-copy';
    copyButton.textContent = 'Copy';
    copyButton.setAttribute('hidden', '');
    copyButton.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      void copyTaskModalLogToClipboard();
    });

    const backButton = document.createElement('button');
    backButton.type = 'button';
    backButton.className = 'jiranimo-task-modal-back';
    backButton.textContent = 'Back';
    backButton.setAttribute('hidden', '');
    backButton.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!activeTaskModalIssueKey) return;
      openTaskDetailsModal(activeTaskModalIssueKey);
    });

    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'jiranimo-task-modal-close';
    closeButton.setAttribute('aria-label', 'Close task details');
    closeButton.textContent = '×';
    closeButton.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      closeTaskModal();
    });

    actions.appendChild(tabs);
    actions.appendChild(copyButton);
    actions.appendChild(backButton);
    actions.appendChild(closeButton);

    const feedback = document.createElement('div');
    feedback.className = 'jiranimo-task-modal-feedback';
    feedback.setAttribute('hidden', '');

    const body = document.createElement('div');
    body.className = 'jiranimo-task-modal-body';

    header.appendChild(titleWrap);
    header.appendChild(actions);
    dialog.appendChild(header);
    dialog.appendChild(feedback);
    dialog.appendChild(body);
    overlay.appendChild(dialog);

    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) {
        closeTaskModal();
      }
    });

    document.body.appendChild(overlay);

    if (!taskModalKeyListenerRegistered) {
      taskModalKeyListenerRegistered = true;
      globalThis.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          const modal = getTaskModalElements();
          if (modal && !modal.overlay.getAttribute('hidden')) {
            closeTaskModal();
          }
        }
      });
    }

    return getTaskModalElements();
  }

  async function openTaskPr(task) {
    if (!task?.prUrl) return;
    try {
      await openTab(task.prUrl, 'Failed to open PR');
    } catch (error) {
      warn('Failed to open PR:', error);
      setTaskModalFeedback('Could not open the PR tab.', 'error');
    }
  }

  async function runTaskModalAction(button, busyLabel, action) {
    if (!(button instanceof HTMLButtonElement)) return false;
    const originalText = button.textContent || '';
    button.disabled = true;
    button.textContent = busyLabel;
    setTaskModalFeedback('', 'success');

    try {
      await action();
      return true;
    } catch (error) {
      warn('Task modal action failed:', error);
      button.disabled = false;
      button.textContent = originalText;
      setTaskModalFeedback(error instanceof Error ? error.message : 'Action failed.', 'error');
      return false;
    }
  }

  async function retryFailedTask(issueKey, button) {
    const success = await runTaskModalAction(button, 'Retrying...', async () => {
      const result = await serverFetch(`/api/tasks/${issueKey}/retry`, 'POST');
      if (!result.ok) {
        throw new Error(result.data?.error || `Error ${result.status}`);
      }
      setTaskModalFeedback('Retry queued.', 'success');
      await syncTaskStatuses();
    });
    if (success && activeTaskModalIssueKey === issueKey) {
      openTaskDetailsModal(issueKey);
    }
  }

  async function cancelTaskResume(issueKey, button) {
    const success = await runTaskModalAction(button, 'Cancelling...', async () => {
      const result = await serverFetch(`/api/tasks/${issueKey}/cancel-resume`, 'POST');
      if (!result.ok) {
        throw new Error(result.data?.error || `Error ${result.status}`);
      }
      setTaskModalFeedback('Resume cancelled.', 'success');
      await syncTaskStatuses();
    });
    if (success && activeTaskModalIssueKey === issueKey) {
      openTaskDetailsModal(issueKey);
    }
  }

  async function resumeInterruptedTask(issueKey, button) {
    const success = await runTaskModalAction(button, 'Resuming...', async () => {
      const result = await serverFetch(`/api/tasks/${issueKey}/resume`, 'POST');
      if (!result.ok) {
        throw new Error(result.data?.error || `Error ${result.status}`);
      }
      setTaskModalFeedback('Task resumed.', 'success');
      await syncTaskStatuses();
    });
    if (success && activeTaskModalIssueKey === issueKey) {
      openTaskDetailsModal(issueKey);
    }
  }

  async function fixTaskComments(issueKey, button) {
    const success = await runTaskModalAction(button, 'Fixing...', async () => {
      const result = await serverFetch(`/api/tasks/${issueKey}/fix-comments`, 'POST');
      if (!result.ok) {
        throw new Error(result.data?.error || `Error ${result.status}`);
      }
      setTaskModalFeedback('Queued a review-comments fix run.', 'success');
      await syncTaskStatuses();
    });
    if (success && activeTaskModalIssueKey === issueKey) {
      openTaskDetailsModal(issueKey);
    }
  }

  function setTaskModalLogTab(tab) {
    const elements = getTaskModalElements();
    if (!elements) return;
    activeTaskModalLogTab = tab;
    elements.tabCompact.classList.toggle('active', tab === 'compact');
    elements.tabFull.classList.toggle('active', tab === 'full');
  }

  function appendTaskModalEmptyState(body, message) {
    clearElement(body);
    const empty = document.createElement('div');
    empty.className = 'jiranimo-task-modal-empty';
    empty.textContent = message;
    body.appendChild(empty);
  }

  function createLogEntry(type, role, text, extraClass) {
    const entry = document.createElement('div');
    entry.className = `jiranimo-log-entry jiranimo-log-${type}${extraClass ? ` ${extraClass}` : ''}`;

    const roleElement = document.createElement('div');
    roleElement.className = 'jiranimo-log-role';
    roleElement.textContent = role;

    const textElement = document.createElement('div');
    textElement.className = 'jiranimo-log-text';
    textElement.textContent = text;

    entry.appendChild(roleElement);
    entry.appendChild(textElement);
    return entry;
  }

  function renderCompactLogInto(body, rawText) {
    clearElement(body);
    const shell = document.createElement('div');
    shell.className = 'jiranimo-compact-log-shell';
    body.appendChild(shell);

    const lines = String(rawText || '')
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean);

    if (!lines.length) {
      const empty = document.createElement('div');
      empty.className = 'jiranimo-task-modal-empty';
      empty.textContent = 'Compact log is empty.';
      shell.appendChild(empty);
      return;
    }

    const bulletItems = [];
    const paragraphItems = [];
    let outcome = '';

    for (const line of lines) {
      const normalized = line.replace(/^[-*]\s*/, '').trim();
      if (!normalized) continue;

      if (/^\*{0,2}Outcome[:*]/i.test(normalized)) {
        outcome = normalized.replace(/^\*{0,2}Outcome\*{0,2}:\s*/i, '').trim();
        continue;
      }

      if (/^[-*]\s/.test(line)) {
        bulletItems.push(normalized);
      } else {
        paragraphItems.push(normalized);
      }
    }

    if (paragraphItems.length) {
      const intro = document.createElement('div');
      intro.className = 'jiranimo-compact-log-intro';
      for (const item of paragraphItems) {
        const paragraph = document.createElement('p');
        paragraph.textContent = item;
        intro.appendChild(paragraph);
      }
      shell.appendChild(intro);
    }

    if (bulletItems.length) {
      const list = document.createElement('ul');
      list.className = 'jiranimo-compact-log-list';
      for (const item of bulletItems) {
        const listItem = document.createElement('li');
        listItem.className = 'jiranimo-compact-log-item';

        const marker = document.createElement('span');
        marker.className = 'jiranimo-compact-log-marker';

        const text = document.createElement('div');
        text.className = 'jiranimo-compact-log-item-text';
        text.textContent = item;

        listItem.appendChild(marker);
        listItem.appendChild(text);
        list.appendChild(listItem);
      }
      shell.appendChild(list);
    }

    if (outcome) {
      const outcomeBox = document.createElement('div');
      outcomeBox.className = 'jiranimo-compact-log-outcome';

      const label = document.createElement('div');
      label.className = 'jiranimo-compact-log-outcome-label';
      label.textContent = 'Outcome';

      const text = document.createElement('div');
      text.className = 'jiranimo-compact-log-outcome-text';
      text.textContent = outcome;

      outcomeBox.appendChild(label);
      outcomeBox.appendChild(text);
      shell.appendChild(outcomeBox);
    }
  }

  function renderFullLogInto(body, rawText) {
    clearElement(body);
    const lines = String(rawText || '').split('\n').filter(line => line.trim());
    if (!lines.length) {
      appendTaskModalEmptyState(body, 'Log is empty.');
      return;
    }

    const fragment = [];
    for (const line of lines) {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }

      switch (event.type) {
        case 'system': {
          const sessionId = event.session_id || event.sessionId || '';
          fragment.push(createLogEntry('system', 'System', `Session started${sessionId ? ` · ${sessionId}` : ''}`));
          break;
        }
        case 'assistant': {
          const msg = event.message || event;
          const contentBlocks = Array.isArray(msg.content) ? msg.content : [];
          for (const block of contentBlocks) {
            if (block.type === 'text' && block.text) {
              fragment.push(createLogEntry('assistant', 'Claude', block.text));
            } else if (block.type === 'tool_use') {
              const inputStr = block.input != null ? JSON.stringify(block.input, null, 2) : '';
              fragment.push(createLogEntry('tool-use', `Tool: ${block.name}`, inputStr));
            }
          }
          break;
        }
        case 'user': {
          const msg = event.message || event;
          const contentBlocks = Array.isArray(msg.content) ? msg.content : [];
          for (const block of contentBlocks) {
            if (block.type === 'tool_result') {
              const content = Array.isArray(block.content)
                ? block.content.map(item => item.text || '').join('\n')
                : (typeof block.content === 'string' ? block.content : '');
              fragment.push(createLogEntry('tool-result', 'Tool Result', content));
            } else if (block.type === 'text' && block.text) {
              fragment.push(createLogEntry('user', 'User', block.text));
            }
          }
          break;
        }
        case 'result': {
          const subtype = event.subtype || 'unknown';
          const cost = typeof event.cost_usd === 'number' ? ` · $${event.cost_usd.toFixed(4)}` : '';
          const resultText = event.result ? `\n\n${event.result}` : '';
          const extraClass = subtype === 'success'
            ? 'jiranimo-log-result-success'
            : subtype === 'error_during_execution'
              ? 'jiranimo-log-result-failure'
              : '';
          fragment.push(createLogEntry('result', `Result: ${subtype}${cost}`, resultText.trim(), extraClass));
          break;
        }
        default:
          break;
      }
    }

    if (!fragment.length) {
      appendTaskModalEmptyState(body, 'No conversation entries found in log.');
      return;
    }

    for (const entry of fragment) {
      body.appendChild(entry);
    }
    body.scrollTop = body.scrollHeight;
  }

  function showTaskModalLogTab(tab) {
    const elements = getTaskModalElements();
    if (!elements) return;
    setTaskModalLogTab(tab);

    if (tab === 'compact') {
      if (activeTaskModalCompactLogText) {
        renderCompactLogInto(elements.body, activeTaskModalCompactLogText);
      } else {
        appendTaskModalEmptyState(elements.body, 'Compact log not available.');
      }
      return;
    }

    if (activeTaskModalFullLogText) {
      renderFullLogInto(elements.body, activeTaskModalFullLogText);
    } else {
      appendTaskModalEmptyState(elements.body, 'No full log is available for this task yet.');
    }
  }

  function switchTaskModalLogTab(tab) {
    if (tab === 'compact' && !activeTaskModalCompactLogText) return;
    if (tab === 'full' && !activeTaskModalFullLogText) return;
    showTaskModalLogTab(tab);
  }

  async function copyTaskModalLogToClipboard() {
    const elements = getTaskModalElements();
    if (!elements) return;

    let text = '';
    if (activeTaskModalLogTab === 'compact' && activeTaskModalCompactLogText) {
      text = activeTaskModalCompactLogText;
    } else if (activeTaskModalLogTab === 'full') {
      text = elements.body.textContent || '';
    }
    if (!text) return;

    const button = elements.copy;
    const originalText = button.textContent || 'Copy';

    try {
      if (globalThis.navigator?.clipboard?.writeText) {
        await globalThis.navigator.clipboard.writeText(text);
      } else {
        throw new Error('Clipboard API unavailable');
      }
    } catch {
      button.textContent = 'Copy unavailable';
      globalThis.setTimeout(() => {
        button.textContent = originalText;
      }, 1500);
      return;
    }

    button.textContent = 'Copied!';
    globalThis.setTimeout(() => {
      button.textContent = originalText;
    }, 1500);
  }

  function configureTaskModalHeaderForDetails(task) {
    const elements = getTaskModalElements();
    if (!elements) return;
    elements.dialog.className = 'jiranimo-task-modal';
    elements.title.textContent = task.key || activeTaskModalIssueKey || 'Task';
    elements.subtitle.textContent =
      task.status === 'failed' ? 'Failed task'
        : task.status === 'interrupted' ? 'Interrupted task'
          : 'Completed task';
    elements.tabs.setAttribute('hidden', '');
    elements.copy.setAttribute('hidden', '');
    elements.back.setAttribute('hidden', '');
  }

  function configureTaskModalHeaderForLogs(task, hasCompactLog, hasFullLog) {
    const elements = getTaskModalElements();
    if (!elements) return;
    elements.dialog.className = 'jiranimo-task-modal jiranimo-task-modal-log-view';
    elements.title.textContent = `${task.key} log`;
    elements.subtitle.textContent = task.summary || 'Conversation log';
    elements.back.removeAttribute('hidden');
    if (hasCompactLog && hasFullLog) {
      elements.tabs.removeAttribute('hidden');
    } else {
      elements.tabs.setAttribute('hidden', '');
    }
    if (hasCompactLog || hasFullLog) {
      elements.copy.removeAttribute('hidden');
    } else {
      elements.copy.setAttribute('hidden', '');
    }
  }

  async function openTaskLogView(issueKey) {
    const task = taskSnapshots[issueKey];
    const elements = ensureTaskModal();
    if (!task || !elements) return;

    activeTaskModalIssueKey = issueKey;
    activeTaskModalView = 'log';
    resetTaskModalLogState();
    configureTaskModalHeaderForLogs(task, false, false);
    setTaskModalFeedback('', 'success');
    appendTaskModalEmptyState(elements.body, 'Loading conversation...');
    elements.overlay.removeAttribute('hidden');
    ensureBodyStyle().overflow = 'hidden';

    const [fullRes, compactRes] = await Promise.allSettled([
      serverFetchText(`/api/tasks/${issueKey}/logs`),
      serverFetch(`/api/tasks/${issueKey}/compact-log`),
    ]);

    if (activeTaskModalIssueKey !== issueKey || activeTaskModalView !== 'log') return;

    if (fullRes.status === 'fulfilled' && fullRes.value.ok) {
      activeTaskModalFullLogText = typeof fullRes.value.text === 'string' ? fullRes.value.text : null;
    }
    if (compactRes.status === 'fulfilled' && compactRes.value.ok) {
      activeTaskModalCompactLogText = compactRes.value.data?.compactLog ?? null;
    }

    const hasCompactLog = Boolean(activeTaskModalCompactLogText);
    const hasFullLog = Boolean(activeTaskModalFullLogText);
    configureTaskModalHeaderForLogs(task, hasCompactLog, hasFullLog);

    if (hasCompactLog) {
      showTaskModalLogTab('compact');
      return;
    }
    if (hasFullLog) {
      showTaskModalLogTab('full');
      return;
    }
    appendTaskModalEmptyState(elements.body, 'No logs are available for this task yet.');
  }

  function openTaskDetailsModal(issueKey) {
    const task = taskSnapshots[issueKey];
    const elements = ensureTaskModal();
    if (!task) {
      if (taskPrUrls[issueKey]) {
        void openTab(taskPrUrls[issueKey], 'Failed to open PR');
      }
      return;
    }
    if (!elements) return;

    activeTaskModalIssueKey = issueKey;
    activeTaskModalView = 'details';
    resetTaskModalLogState();
    configureTaskModalHeaderForDetails(task);
    setTaskModalFeedback('', 'success');
    clearElement(elements.body);

    const card = document.createElement('section');
    card.className = `jiranimo-task-card jiranimo-task-card-${task.status || 'completed'}`;

    const summary = document.createElement('div');
    summary.className = 'jiranimo-task-card-summary';
    summary.textContent = task.summary || 'Task details';

    const meta = document.createElement('div');
    meta.className = 'jiranimo-task-card-meta';

    const priority = document.createElement('span');
    priority.textContent = task.priority || 'Priority unknown';
    meta.appendChild(priority);

    const issueType = document.createElement('span');
    issueType.textContent = task.issueType || 'Task';
    meta.appendChild(issueType);

    if (task.prUrl) {
      const prButton = createTaskModalButton('View PR', 'jiranimo-task-card-meta-link', () => {
        void openTaskPr(task);
      });
      meta.appendChild(prButton);
    }

    if (typeof task.claudeCostUsd === 'number') {
      const cost = document.createElement('span');
      cost.textContent = `$${task.claudeCostUsd.toFixed(2)}`;
      meta.appendChild(cost);
    }

    if (task.resumeMode) {
      const resumeMode = document.createElement('span');
      resumeMode.textContent = `Resume: ${task.resumeMode}`;
      meta.appendChild(resumeMode);
    }

    if (task.resumeAfter) {
      const resumeAfter = document.createElement('span');
      resumeAfter.textContent = `Auto resume: ${new Date(task.resumeAfter).toLocaleTimeString()}`;
      meta.appendChild(resumeAfter);
    }

    const age = document.createElement('span');
    age.textContent = formatTaskAge(task);
    meta.appendChild(age);

    if (task.status === 'failed' && task.errorMessage) {
      const error = document.createElement('div');
      error.className = 'jiranimo-task-card-message jiranimo-task-card-message-error';
      error.textContent = task.errorMessage;
      card.appendChild(error);
    }

    if (task.status === 'interrupted' && task.resumeReason) {
      const resumeReason = document.createElement('div');
      resumeReason.className = 'jiranimo-task-card-message jiranimo-task-card-message-warning';
      resumeReason.textContent = `Interrupted: ${task.resumeReason}`;
      card.appendChild(resumeReason);
    }

    const actions = document.createElement('div');
    actions.className = 'jiranimo-task-card-actions';

    const hasLogs = ['in-progress', 'interrupted', 'completed', 'failed'].includes(task.status);
    if (hasLogs) {
      actions.appendChild(createTaskModalButton('View Log', 'jiranimo-task-btn jiranimo-task-btn-log', () => {
        void openTaskLogView(issueKey);
      }));
    }

    const canFixComments = Boolean(task.prUrl) && (task.status === 'completed' || task.status === 'failed');
    if (canFixComments) {
      actions.appendChild(createTaskModalButton('Fix comments', 'jiranimo-task-btn', (button) => {
        void fixTaskComments(issueKey, button);
      }));
    }

    if (task.status === 'failed') {
      actions.appendChild(createTaskModalButton('Retry', 'jiranimo-task-btn', (button) => {
        void retryFailedTask(issueKey, button);
      }));
    }

    if (task.status === 'interrupted' && task.recoveryState === 'resume-pending') {
      actions.appendChild(createTaskModalButton('Cancel Resume', 'jiranimo-task-btn', (button) => {
        void cancelTaskResume(issueKey, button);
      }));
    }

    if (task.status === 'interrupted' && task.recoveryState === 'resume-cancelled') {
      actions.appendChild(createTaskModalButton('Resume Now', 'jiranimo-task-btn', (button) => {
        void resumeInterruptedTask(issueKey, button);
      }));
    }

    card.appendChild(summary);
    card.appendChild(meta);
    if (actions.firstElementChild) {
      card.appendChild(actions);
    }

    elements.body.appendChild(card);
    elements.overlay.removeAttribute('hidden');
    ensureBodyStyle().overflow = 'hidden';
  }

  async function handleBadgeClick(icon, issueKey) {
    setDebugInfo({ issueKey, stage: 'click-start', lastError: null });
    pinnedBadgeIssueKeys.add(issueKey);
    const status = taskStatuses[issueKey];
    const shouldContinue = status === 'completed' && taskContinueStates[issueKey];

    if (status === 'failed') {
      openTaskDetailsModal(issueKey);
      return;
    }

    if (status === 'interrupted') {
      openTaskDetailsModal(issueKey);
      return;
    }

    if (status === 'queued' || status === 'in-progress') return;

    if (shouldContinue) {
      setBadgeState(icon, issueKey, 'in-progress', 'Continuing work...');

      try {
        let issueData = await fetchIssueDetails(issueKey);
        if (!issueData) {
          issueData = buildFallbackIssueDetails(issueKey);
        }

        const result = await serverFetch(`/api/tasks/${issueKey}/continue-work`, 'POST', issueData);
        if (result.ok) {
          taskContinueStates[issueKey] = false;
          taskStatuses[issueKey] = 'queued';
          updateBadgeState(icon, issueKey, 'queued');
        } else {
          setBadgeState(icon, issueKey, 'continue', (result.data?.error || `Error ${result.status}`) + ' — click to continue');
        }
      } catch (err) {
        warn('Continue work failed (is the server running?):', err);
        setBadgeState(icon, issueKey, 'continue', 'Server offline — click to continue');
      }
      return;
    }

    if (status === 'completed' && taskPrUrls[issueKey]) {
      openTaskDetailsModal(issueKey);
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

      if (!boardConfig) {
        setDebugInfo({ issueKey, stage: 'missing-board-config', lastError: 'Board configuration unavailable' });
        setBadgeState(icon, issueKey, 'failed', 'Board configuration unavailable — reload and retry');
        return;
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
    const shouldContinue = status === 'completed' && taskContinueStates[issueKey];
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
        icon.className = shouldContinue ? 'jiranimo-icon continue' : 'jiranimo-icon completed';
        icon.title = shouldContinue ? 'Continue work with AI' : 'PR ready — click for details';
        if (label) label.textContent = shouldContinue ? 'Continue' : 'Done';
        break;
      case 'continue':
        icon.className = 'jiranimo-icon continue';
        icon.title = 'Continue work with AI';
        if (label) label.textContent = 'Continue';
        break;
      case 'interrupted':
        icon.className = 'jiranimo-icon failed';
        icon.title = 'Interrupted — click for details';
        if (label) label.textContent = 'Interrupted';
        break;
      case 'failed':
        icon.className = 'jiranimo-icon failed';
        icon.title = 'Failed — click for details';
        if (label) label.textContent = 'Failed';
        break;
      default:
        icon.className = 'jiranimo-icon idle';
        icon.title = 'Implement with AI';
        if (label) label.textContent = 'Implement';
    }
  }

  function observeCardChanges() {
    if (cardObserver) return;

    const observer = new MutationObserver((mutations) => {
      const taskItemsToProcess = new Set();

      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node instanceof Element) {
            const ownTaskItem = node.closest(LIST_ITEM_SELECTOR);
            if (ownTaskItem) taskItemsToProcess.add(ownTaskItem);
            if (node.localName === 'li') taskItemsToProcess.add(node);
            for (const taskItem of node.querySelectorAll(LIST_ITEM_SELECTOR)) {
              taskItemsToProcess.add(taskItem);
            }
          } else if (node.parentElement) {
            const parentTaskItem = node.parentElement.closest(LIST_ITEM_SELECTOR);
            if (parentTaskItem) taskItemsToProcess.add(parentTaskItem);
          }
        }
      }

      if (taskItemsToProcess.size > 0) {
        let injected = 0;
        for (const taskItem of taskItemsToProcess) {
          if (processTaskListItem(taskItem)) {
            injected++;
          }
        }
        if (injected > 0) {
          log(`Injected ${injected} badges from DOM mutations`);
        }
        void refreshContinueBadgeStates();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    cardObserver = observer;
    log('MutationObserver attached');
  }

  function scheduleInitForCurrentRoute(delay = 0) {
    globalThis.setTimeout(() => {
      const nextBoardId = getBoardId();
      if (!nextBoardId) {
        return;
      }

      if (nextBoardId === currentBoardId && boardConfig) {
        scanTaskListItems(document);
        return;
      }

      currentBoardId = null;
      boardConfig = null;
      void init().catch(err => warn('Init failed after route change:', err));
    }, delay);
  }

  function startRouteMonitoring() {
    if (routeMonitoringStarted) return;
    routeMonitoringStarted = true;

    let lastHref = location.href;
    const onRouteChange = () => {
      if (location.href === lastHref) return;
      lastHref = location.href;
      log('Route changed:', location.href);
      scheduleInitForCurrentRoute(50);
    };

    globalThis.addEventListener('popstate', onRouteChange);
    globalThis.addEventListener('hashchange', onRouteChange);
    routePollInterval = globalThis.setInterval(onRouteChange, 500);
  }

  function shouldRefreshBoardForIssue(issueKey) {
    return Boolean(
      findTaskItemByIssueKey(issueKey) ||
      document.querySelector(`[${BADGE_ATTR}="${issueKey}"]`)
    );
  }

  function scheduleBoardRefresh(issueKey, reason) {
    if (!shouldRefreshBoardForIssue(issueKey)) {
      log(`Skipping board refresh for ${issueKey}; issue is not on the current board`, reason);
      return;
    }

    if (boardRefreshTimer) {
      log(`Board refresh already scheduled for ${issueKey}`, reason);
      return;
    }

    log(`Scheduling board refresh for ${issueKey}:`, reason);
    boardRefreshTimer = setTimeout(() => {
      boardRefreshTimer = null;
      try {
        log(`Refreshing board after Jira status sync for ${issueKey}`);
        location.reload();
      } catch (err) {
        warn('Board refresh failed:', err);
      }
    }, BOARD_REFRESH_DELAY);
  }

  /** @type {WebSocket|null} */
  let ws = null;

  async function getIssueStatus(issueKey) {
    const cached = issueStatusCache.get(issueKey);
    if (cached && Date.now() - cached.fetchedAt < 5_000) {
      return cached.status;
    }
    try {
      const res = await fetch(`${location.origin}/rest/api/3/issue/${issueKey}?fields=status`, { credentials: 'include' });
      if (!res.ok) return '';
      const issue = await res.json();
      const status = issue.fields?.status?.name || '';
      issueStatusCache.set(issueKey, { status, fetchedAt: Date.now() });
      return status;
    } catch {
      return '';
    }
  }

  async function refreshContinueBadgeStates() {
    const refreshToken = ++continueStateRefreshToken;
    const completedIssueKeys = [...document.querySelectorAll(`[${BADGE_ATTR}]`)]
      .map((element) => element.getAttribute(BADGE_ATTR) || '')
      .filter((issueKey) => issueKey && taskStatuses[issueKey] === 'completed');

    const nextContinueStates = { ...taskContinueStates };
    for (const issueKey of Object.keys(nextContinueStates)) {
      if (taskStatuses[issueKey] !== 'completed') {
        delete nextContinueStates[issueKey];
      }
    }

    for (const issueKey of completedIssueKeys) {
      nextContinueStates[issueKey] = isIssueInTodoColumn(issueKey);
    }

    if (refreshToken !== continueStateRefreshToken) {
      return;
    }

    taskContinueStates = nextContinueStates;
    for (const issueKey of completedIssueKeys) {
      const badge = document.querySelector(`[${BADGE_ATTR}="${issueKey}"]`);
      if (badge) {
        updateBadgeState(badge, issueKey, 'completed');
      }
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
    if (effect.type === 'repo-confirmation') {
      showRepoConfirmationBanner(effect);
      return false;
    }

    if (effect.type === 'pipeline-status-sync') {
      const pipelineStatus = effect.payload?.pipelineStatus;
      const issueKey = effect.payload?.issueKey;
      if (!issueKey || typeof issueKey !== 'string') return false;

      if (pipelineStatus === 'in-progress' && boardConfig?.transitions?.inProgress) {
        const targetStatus = boardConfig.transitions.inProgress.name;
        const current = (await getIssueStatus(issueKey)).toLowerCase();
        if (current === targetStatus.toLowerCase()) {
          scheduleBoardRefresh(issueKey, `status already ${targetStatus}`);
          return true;
        }

        const transitioned = await transitionIssue(issueKey, targetStatus);
        if (transitioned) {
          scheduleBoardRefresh(issueKey, `transitioned to ${targetStatus}`);
        }
        return transitioned;
      }

      if (pipelineStatus === 'completed' && boardConfig?.transitions?.inReview) {
        const targetStatus = boardConfig.transitions.inReview.name;
        const current = (await getIssueStatus(issueKey)).toLowerCase();
        if (current === targetStatus.toLowerCase()) {
          scheduleBoardRefresh(issueKey, `status already ${targetStatus}`);
          return true;
        }

        const transitioned = await transitionIssue(issueKey, targetStatus);
        if (transitioned) {
          scheduleBoardRefresh(issueKey, `transitioned to ${targetStatus}`);
        }
        return transitioned;
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

  async function syncTaskStatuses() {
    try {
      /** @type {any} */
      const syncResult = await serverFetch(`/api/sync?jiraHost=${encodeURIComponent(location.host)}`);
      if (!syncResult.ok) return;
      const snapshot = syncResult.data;
      const tasks = Array.isArray(snapshot.tasks) ? snapshot.tasks : [];

      const nextStatuses = {};
      const nextPrUrls = {};
      const nextRecoveryStates = {};
      const nextTaskSnapshots = {};

      for (const task of tasks) {
        nextStatuses[task.key] = task.status;
        nextRecoveryStates[task.key] = task.recoveryState || 'none';
        if (task.prUrl) nextPrUrls[task.key] = task.prUrl;
        nextTaskSnapshots[task.key] = task;
      }

      for (const existingKey of Object.keys(taskStatuses)) {
        if (!nextStatuses[existingKey]) {
          const badge = document.querySelector(`[${BADGE_ATTR}="${existingKey}"]`);
          if (badge) updateBadgeState(badge, existingKey, 'idle');
          delete taskContinueStates[existingKey];
        }
      }

      taskStatuses = nextStatuses;
      taskPrUrls = nextPrUrls;
      taskRecoveryStates = nextRecoveryStates;
      taskSnapshots = nextTaskSnapshots;
      serverEpoch = Number(snapshot.serverEpoch || 0);
      serverRevision = Number(snapshot.revision || 0);

      for (const task of tasks) {
        pinnedBadgeIssueKeys.add(task.key);
        const taskItem = findTaskItemByIssueKey(task.key);
        if (taskItem) {
          processTaskListItem(taskItem);
        }
        const badge = document.querySelector(`[${BADGE_ATTR}="${task.key}"]`);
        if (badge) {
          updateBadgeState(badge, task.key, task.status);
        }
      }

      void refreshContinueBadgeStates();

      if (activeTaskModalIssueKey && activeTaskModalView === 'details' && taskSnapshots[activeTaskModalIssueKey]) {
        openTaskDetailsModal(activeTaskModalIssueKey);
      }

      await processPendingEffects(snapshot.pendingEffects || []);
      const pendingRepoEffectIds = new Set(
        (snapshot.pendingEffects || [])
          .filter(effect => effect.type === 'repo-confirmation')
          .map(effect => effect.id)
      );
      if (activeRepoConfirmation && !pendingRepoEffectIds.has(activeRepoConfirmation.effectId)) {
        dismissRepoConfirmationBanner(activeRepoConfirmation.effectId);
      }
      log('Synced', tasks.length, 'tasks from server snapshot', { serverEpoch, serverRevision });
    } catch {
      // Server not running
    }
  }

  function connectWebSocket() {
    if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
      return;
    }

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

  startRouteMonitoring();
  init().catch(err => warn('Init failed:', err));
})();
