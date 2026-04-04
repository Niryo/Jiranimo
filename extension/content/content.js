/**
 * Jiranimo content script.
 * Runs on Jira sprint board pages.
 * Detects visible Jira cards in the DOM and injects "Implement" badges.
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
  const DASHBOARD_LINK_ATTR = 'data-jiranimo-dashboard-link';
  const SCAN_DEBOUNCE = 500;
  const WS_RECONNECT_DELAY = 3000;
  const BOARD_REFRESH_DELAY = 1200;
  const BOARD_PRESENCE_SYNC_DEBOUNCE = 1500;
  const BOARD_PRESENCE_SYNC_INTERVAL_MS = 30000;
  const BOARD_HEADER_SELECTOR = [
    '[data-testid="horizontal-nav-header.ui.board-header.header"]',
    '[data-testid="horizontal-nav-header.ui.project-header.header"]',
    '.board-header',
  ].join(', ');
  const BOARD_HEADER_ACTION_SELECTORS = [
    '[data-testid="navigation-project-action-menu.ui.themed-button"]',
    '[data-testid="feedback-button.horizontal-nav-feedback-button"]',
    '[data-testid="platform.ui.fullscreen-button.fullscreen-button"]',
    '[data-vc="automation-menu-button"]',
    '#po-spotlight-share-button',
    '[data-testid="navigation-board-action-menu.ui.dropdown"]',
    '[data-testid="team-button-trigger"]',
  ];
  const FULLSCREEN_BUTTON_SELECTOR = '[data-testid="platform.ui.fullscreen-button.fullscreen-button"]';
  const DASHBOARD_RENDER_VERSION = 'fullscreen-icon-v2';
  const CARD_SELECTOR = '[data-testid="platform-board-kit.ui.card.card"]';
  const CARD_CONTENT_SELECTOR = [
    CARD_SELECTOR,
    '[data-testid="platform-card.common.ui.key.key"]',
    '.card-key',
    '[data-component-selector="issue-field-summary-inline-edit.ui.read.static-summary"]',
    '.card-summary',
  ].join(', ');
  const ISSUE_KEY_PATTERN = /\b[A-Z][A-Z0-9]+-\d+\b/;
  const CARD_ID_PREFIX = 'card-';
  const SPARKLES_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path fill-rule="evenodd" d="M9 4.5a.75.75 0 01.721.544l.813 2.846a3.75 3.75 0 002.576 2.576l2.846.813a.75.75 0 010 1.442l-2.846.813a3.75 3.75 0 00-2.576 2.576l-.813 2.846a.75.75 0 01-1.442 0l-.813-2.846a3.75 3.75 0 00-2.576-2.576l-2.846-.813a.75.75 0 010-1.442l2.846-.813A3.75 3.75 0 007.466 7.89l.813-2.846A.75.75 0 019 4.5zM18 1.5a.75.75 0 01.728.568l.258 1.036c.236.94.97 1.674 1.91 1.91l1.036.258a.75.75 0 010 1.456l-1.036.258c-.94.236-1.674.97-1.91 1.91l-.258 1.036a.75.75 0 01-1.456 0l-.258-1.036a2.625 2.625 0 00-1.91-1.91l-1.036-.258a.75.75 0 010-1.456l1.036-.258a2.625 2.625 0 001.91-1.91l.258-1.036A.75.75 0 0118 1.5zM16.5 15a.75.75 0 01.712.513l.394 1.183c.15.447.5.799.948.948l1.183.395a.75.75 0 010 1.422l-1.183.395c-.447.15-.799.5-.948.948l-.395 1.183a.75.75 0 01-1.422 0l-.395-1.183a1.5 1.5 0 00-.948-.948l-1.183-.395a.75.75 0 010-1.422l1.183-.395c.447-.15.799-.5.948-.948l.395-1.183A.75.75 0 0116.5 15z" clip-rule="evenodd"/></svg>';
  const DASHBOARD_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path fill="currentColor" d="M8.55 2H10v6.1c0 1.97-.56 3.45-1.69 4.45-1.11.97-2.58 1.45-4.43 1.45-.86 0-1.61-.09-2.26-.28v-1.66c.68.26 1.43.39 2.25.39 1.29 0 2.28-.34 2.96-1.01.68-.69 1.02-1.75 1.02-3.18V4.12H4.35V2H8.55Z"/><path fill="currentColor" d="M12.15 1.35c.1 0 .18.07.21.16l.33 1.13c.07.25.27.45.52.52l1.13.33a.22.22 0 0 1 0 .42l-1.13.33a.76.76 0 0 0-.52.52l-.33 1.13a.22.22 0 0 1-.42 0l-.33-1.13a.76.76 0 0 0-.52-.52l-1.13-.33a.22.22 0 0 1 0-.42l1.13-.33c.25-.07.45-.27.52-.52l.33-1.13c.03-.09.11-.16.21-.16Z"/></svg>';

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
  /** @type {number|null} */
  let boardRefreshTimer = null;
  /** @type {number|null} */
  let presenceSyncTimer = null;
  /** @type {number|null} */
  let presenceSyncInterval = null;
  /** @type {number|null} */
  let dashboardLinkTimer = null;
  /** @type {string|null} */
  let currentBoardId = null;
  /** @type {MutationObserver|null} */
  let cardObserver = null;
  /** @type {boolean} */
  let routeMonitoringStarted = false;
  /** @type {number|null} */
  let routePollInterval = null;
  /** @type {boolean} */
  let presenceSyncInFlight = false;
  /** @type {boolean} */
  let presenceSyncQueued = false;
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
      if (!boardConfig.boardType) {
        boardConfig = await BoardConfig.ensureMetadata(currentBoardId, boardConfig);
      }
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
    scheduleDashboardLinkInjection(0);
    setTimeout(() => {
      scanCards();
      scheduleBoardPresenceSync(0);
      scheduleDashboardLinkInjection(0);
    }, 1000);
    observeCardChanges();
    connectWebSocket();
    startBoardPresenceRefresh();
  }

  function debouncedScan() {
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = setTimeout(() => scanCards(), SCAN_DEBOUNCE);
  }

  function scheduleDashboardLinkInjection(delay = 100) {
    if (dashboardLinkTimer) clearTimeout(dashboardLinkTimer);
    dashboardLinkTimer = setTimeout(() => {
      dashboardLinkTimer = null;
      ensureDashboardLink();
    }, delay);
  }

  function scheduleBoardPresenceSync(delay = BOARD_PRESENCE_SYNC_DEBOUNCE) {
    if (presenceSyncTimer) clearTimeout(presenceSyncTimer);
    presenceSyncTimer = setTimeout(() => {
      presenceSyncTimer = null;
      void syncBoardPresence();
    }, delay);
  }

  function startBoardPresenceRefresh() {
    if (presenceSyncInterval) return;
    presenceSyncInterval = setInterval(() => {
      void syncBoardPresence();
    }, BOARD_PRESENCE_SYNC_INTERVAL_MS);
  }

  function scanCards() {
    const cards = document.querySelectorAll(CARD_SELECTOR);
    log(`Scanning ${cards.length} visible cards`);

    let injected = 0;
    for (const card of cards) {
      const issueKey = extractIssueKeyFromCard(card);
      if (!issueKey) continue;
      if (card.querySelector(`[${BADGE_ATTR}]`)) continue;
      if (injectBadge(card, issueKey)) {
        injected++;
      }
    }
    log(`Injected ${injected} badges`);
  }

  function extractIssueKeyFromCard(card) {
    const cardId = card.getAttribute('id')?.trim();
    if (cardId?.startsWith(CARD_ID_PREFIX)) {
      const keyFromId = cardId.slice(CARD_ID_PREFIX.length);
      if (ISSUE_KEY_PATTERN.test(keyFromId)) return keyFromId;
    }

    const draggableId = card.getAttribute('data-rbd-draggable-id')?.trim();
    if (draggableId && ISSUE_KEY_PATTERN.test(draggableId)) {
      return draggableId;
    }

    const browseLink = card.querySelector('a[href*="/browse/"]');
    const href = browseLink?.getAttribute('href') || '';
    const hrefMatch = href.match(/\/browse\/([A-Z][A-Z0-9]+-\d+)/);
    if (hrefMatch) return hrefMatch[1];

    const keyText = card.querySelector('[data-testid="platform-card.common.ui.key.key"], .card-key')?.textContent?.trim();
    if (!keyText) return null;
    const textMatch = keyText.match(ISSUE_KEY_PATTERN);
    return textMatch ? textMatch[0] : null;
  }

  function findIssueSummaryElement(card) {
    if (!card) return null;
    return card.querySelector(
      '[data-component-selector="issue-field-summary-inline-edit.ui.read.static-summary"], .card-summary'
    );
  }

  function findBadgeHost(card) {
    return (
      card.querySelector('[data-testid="platform-card.common.ui.key.key"]') ||
      card.querySelector('.card-key') ||
      findIssueSummaryElement(card)
    );
  }

  function findCardByIssueKey(issueKey) {
    for (const card of document.querySelectorAll(CARD_SELECTOR)) {
      if (extractIssueKeyFromCard(card) === issueKey) {
        return card;
      }
    }
    return null;
  }

  function buildDashboardUrl() {
    try {
      return new URL('/', resolveServerBaseUrl()).toString();
    } catch {
      return resolveServerBaseUrl().replace(/\/?$/, '/');
    }
  }

  function findBoardHeader() {
    return document.querySelector(BOARD_HEADER_SELECTOR);
  }

  function isActionLikeElement(element) {
    return Boolean(
      element.matches?.('button, a[href], [role="button"]') ||
      element.querySelector?.('button, a[href], [role="button"]')
    );
  }

  function findBoardHeaderReferenceAction(header) {
    for (const selector of BOARD_HEADER_ACTION_SELECTORS) {
      const match = header.querySelector(selector);
      if (match) {
        return match;
      }
    }
    return null;
  }

  function findBoardHeaderActionHost(header) {
    const explicitActionHost = header.querySelector('.board-header-actions');
    if (explicitActionHost) {
      return explicitActionHost;
    }

    const knownControl = findBoardHeaderReferenceAction(header);

    if (knownControl) {
      let candidate = knownControl.parentElement;
      while (candidate && candidate !== header) {
        const actionChildren = [...candidate.children].filter(child => isActionLikeElement(child));
        if (actionChildren.length >= 2) {
          return candidate;
        }
        candidate = candidate.parentElement;
      }
    }

    const directChildren = [...header.children];
    const childWithActions = directChildren.reverse().find(child =>
      isActionLikeElement(child)
    );

    return childWithActions || header;
  }

  function findFullscreenAction() {
    return document.querySelector(FULLSCREEN_BUTTON_SELECTOR);
  }

  function findActionHostForReference(header, referenceAction) {
    let candidate = referenceAction?.parentElement || null;
    while (candidate && candidate !== header) {
      const actionChildren = [...candidate.children].filter(child => isActionLikeElement(child));
      if (actionChildren.length >= 2) {
        return candidate;
      }
      candidate = candidate.parentElement;
    }
    return referenceAction?.parentElement || header;
  }

  function findDirectChildWithin(parent, descendant) {
    let current = descendant;
    while (current && current.parentElement && current.parentElement !== parent) {
      current = current.parentElement;
    }
    return current && current.parentElement === parent ? current : null;
  }

  function clearJiraSpecificAttributes(element) {
    for (const attr of ['id', 'data-testid', 'data-vc', 'aria-expanded', 'aria-haspopup', 'aria-controls']) {
      element.removeAttribute(attr);
    }
  }

  function ensureDashboardTooltip(wrapper) {
    let tooltip = wrapper.querySelector('.jiranimo-dashboard-tooltip');
    if (!(tooltip instanceof HTMLElement)) {
      tooltip = document.createElement('span');
      tooltip.className = 'jiranimo-dashboard-tooltip';
      tooltip.setAttribute('aria-hidden', 'true');
      wrapper.appendChild(tooltip);
    }
    tooltip.textContent = 'Server dashboard';
  }

  function createDashboardIconSvg(referenceSvg) {
    const template = document.createElement('template');
    template.innerHTML = DASHBOARD_SVG.trim();
    const svg = template.content.firstElementChild;
    if (!(svg instanceof SVGElement)) {
      return document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    }

    svg.classList.add('jiranimo-dashboard-icon-svg');

    if (referenceSvg instanceof SVGElement) {
      const referenceClass = referenceSvg.getAttribute('class');
      if (referenceClass) {
        svg.setAttribute('class', `${referenceClass} jiranimo-dashboard-icon-svg`);
      }
      for (const attr of ['role', 'fill']) {
        const value = referenceSvg.getAttribute(attr);
        if (value) {
          svg.setAttribute(attr, value);
        }
      }
    }

    return svg;
  }

  function openDashboardTab(url) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'open-tab', url }, (response) => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        if (!response?.ok) {
          reject(new Error(response?.error || 'Failed to open dashboard tab'));
          return;
        }
        resolve(response);
      });
    });
  }

  function renderDashboardButtonContent(button, referenceAction) {
    const referenceContent = referenceAction?.firstElementChild instanceof HTMLElement
      ? referenceAction.firstElementChild
      : null;
    const referenceIcon =
      referenceAction?.querySelector('span[aria-hidden="true"]') instanceof HTMLElement
        ? referenceAction.querySelector('span[aria-hidden="true"]')
        : referenceAction?.querySelector('[role="img"]') instanceof HTMLElement
          ? referenceAction.querySelector('[role="img"]')
          : null;
    const referenceSvg = referenceAction?.querySelector('svg') instanceof SVGElement
      ? referenceAction.querySelector('svg')
      : null;

    button.replaceChildren();

    const content = referenceContent
      ? referenceContent.cloneNode(false)
      : document.createElement('span');
    const icon = referenceIcon
      ? referenceIcon.cloneNode(false)
      : document.createElement('span');

    if (!(content instanceof HTMLElement) || !(icon instanceof HTMLElement)) {
      return;
    }

    content.classList.add('jiranimo-dashboard-trigger-content');
    icon.classList.add('jiranimo-dashboard-trigger-icon');
    icon.removeAttribute('role');
    icon.setAttribute('aria-hidden', 'true');
    icon.style.color = 'currentcolor';

    icon.replaceChildren(createDashboardIconSvg(referenceSvg));
    content.replaceChildren();
    content.appendChild(icon);
    button.appendChild(content);
  }

  function createDashboardButton(referenceAction) {
    const template = referenceAction instanceof HTMLButtonElement
      ? referenceAction.cloneNode(false)
      : document.createElement('button');
    const button = template instanceof HTMLButtonElement ? template : document.createElement('button');

    clearJiraSpecificAttributes(button);
    button.type = 'button';
    button.classList.add('jiranimo-dashboard-trigger');
    button.setAttribute(DASHBOARD_LINK_ATTR, 'true');
    button.setAttribute('aria-label', 'Open Jiranimo server dashboard');
    button.title = 'Open Jiranimo server dashboard';
    button.dataset.dashboardUrl = buildDashboardUrl();
    button.dataset.jiranimoRenderVersion = DASHBOARD_RENDER_VERSION;
    renderDashboardButtonContent(button, referenceAction);

    button.addEventListener('mousedown', (event) => event.stopPropagation());
    button.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const dashboardUrl = button.dataset.dashboardUrl || buildDashboardUrl();
      try {
        await openDashboardTab(dashboardUrl);
      } catch (error) {
        warn('Failed to open dashboard tab:', error);
      } finally {
        button.blur();
      }
    });

    return button;
  }

  function createDashboardActionNode(host, referenceAction) {
    const button = createDashboardButton(referenceAction);
    const referenceItem = referenceAction ? findDirectChildWithin(host, referenceAction) : null;

    if (!referenceItem) {
      button.classList.add('jiranimo-dashboard-trigger-fallback');
      return { node: button, before: null };
    }

    const wrapper = referenceItem.cloneNode(false);
    if (!(wrapper instanceof HTMLElement)) {
      button.classList.add('jiranimo-dashboard-trigger-fallback');
      return { node: button, before: referenceItem };
    }

    clearJiraSpecificAttributes(wrapper);
    wrapper.classList.add('jiranimo-dashboard-action-wrapper');
    wrapper.replaceChildren(button);
    ensureDashboardTooltip(wrapper);
    return { node: wrapper, before: referenceItem };
  }

  function ensureDashboardLink() {
    const dashboardUrl = buildDashboardUrl();
    const header = findBoardHeader();
    if (!header) {
      return false;
    }

    const fullscreenAction = findFullscreenAction();
    if (!(fullscreenAction instanceof HTMLButtonElement) || !header.contains(fullscreenAction)) {
      return false;
    }

    const host = findActionHostForReference(header, fullscreenAction);
    const fullscreenItem = findDirectChildWithin(host, fullscreenAction);
    if (!fullscreenItem) {
      return false;
    }

    const existing = document.querySelector(`[${DASHBOARD_LINK_ATTR}]`);
    if (existing instanceof HTMLElement) {
      const existingItem = existing.closest('.jiranimo-dashboard-action-wrapper') || existing;
      const isPlacedCorrectly =
        existingItem.parentElement === host &&
        existingItem.nextElementSibling === fullscreenItem;
      const hasCurrentUrl = existing.dataset.dashboardUrl === dashboardUrl;
      const hasCurrentRenderVersion = existing.dataset.jiranimoRenderVersion === DASHBOARD_RENDER_VERSION;
      const hasTooltip =
        existingItem instanceof HTMLElement &&
        existingItem.classList.contains('jiranimo-dashboard-action-wrapper') &&
        existingItem.querySelector('.jiranimo-dashboard-tooltip');

      if (isPlacedCorrectly && hasCurrentUrl && hasCurrentRenderVersion && hasTooltip) {
        return true;
      }

      existing.dataset.dashboardUrl = dashboardUrl;
      existing.dataset.jiranimoRenderVersion = DASHBOARD_RENDER_VERSION;
      renderDashboardButtonContent(existing, fullscreenAction);

      if (existingItem instanceof HTMLElement && existingItem.classList.contains('jiranimo-dashboard-action-wrapper')) {
        ensureDashboardTooltip(existingItem);
      }
      if (isPlacedCorrectly) {
        return true;
      }
      existingItem.remove();
    }

    const { node } = createDashboardActionNode(host, fullscreenAction);
    host.insertBefore(node, fullscreenItem);
    return true;
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
    const card = findCardByIssueKey(issueKey);
    const summary = findIssueSummaryElement(card)?.textContent?.trim() || issueKey;
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
      projectKey: issueKey.split('-')[0],
    };
  }

  async function fetchPaginatedIssueKeys(path) {
    const issueKeys = [];
    const maxResults = 100;
    let startAt = 0;

    while (true) {
      const separator = path.includes('?') ? '&' : '?';
      const res = await fetch(`${location.origin}${path}${separator}startAt=${startAt}&maxResults=${maxResults}`, {
        credentials: 'include',
      });
      if (!res.ok) {
        throw new Error(`Issue membership fetch failed: ${res.status}`);
      }

      const data = await res.json();
      const issues = Array.isArray(data.issues) ? data.issues : [];
      issueKeys.push(...issues.map(issue => issue.key).filter(key => typeof key === 'string'));

      const total = Number(data.total ?? 0);
      const nextStartAt = startAt + issues.length;
      if (data.isLast === true || issues.length === 0 || nextStartAt >= total) {
        break;
      }

      startAt = nextStartAt;
    }

    return [...new Set(issueKeys)];
  }

  async function fetchCurrentBoardIssueKeys() {
    if (!currentBoardId || !boardConfig?.boardType) {
      return [];
    }

    if (boardConfig.boardType === 'scrum') {
      const sprintRes = await fetch(`${location.origin}/rest/agile/1.0/board/${currentBoardId}/sprint?state=active`, {
        credentials: 'include',
      });
      if (!sprintRes.ok) {
        throw new Error(`Active sprint lookup failed: ${sprintRes.status}`);
      }
      const sprintData = await sprintRes.json();
      const sprintId = sprintData.values?.[0]?.id;
      if (!sprintId) {
        return [];
      }
      return fetchPaginatedIssueKeys(`/rest/agile/1.0/sprint/${sprintId}/issue?fields=summary`);
    }

    return fetchPaginatedIssueKeys(`/rest/agile/1.0/board/${currentBoardId}/issue?fields=summary`);
  }

  async function syncBoardPresence() {
    if (presenceSyncInFlight) {
      presenceSyncQueued = true;
      return;
    }

    presenceSyncInFlight = true;
    try {
      do {
        presenceSyncQueued = false;

        if (!currentBoardId || !boardConfig?.boardType) {
          return;
        }

        const issueKeys = await fetchCurrentBoardIssueKeys();
        const presenceResult = await serverFetch(`/api/boards/${currentBoardId}/presence`, 'PUT', {
          jiraHost: location.host,
          boardType: boardConfig.boardType,
          projectKey: boardConfig.projectKey || undefined,
          issueKeys,
          isCompleteSnapshot: true,
        });
        if (!presenceResult.ok) {
          throw new Error(presenceResult.error || presenceResult.data?.error || `Presence sync failed (${presenceResult.status})`);
        }
        log('Published board presence', {
          boardId: currentBoardId,
          boardType: boardConfig.boardType,
          issueCount: issueKeys.length,
        });
      } while (presenceSyncQueued);
    } catch (err) {
      warn('Board presence sync failed:', err);
    } finally {
      presenceSyncInFlight = false;
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

      if (!currentBoardId || !boardConfig?.boardType) {
        setDebugInfo({ issueKey, stage: 'missing-board-metadata', lastError: 'Board metadata unavailable' });
        setBadgeState(icon, issueKey, 'failed', 'Board metadata unavailable — reload and retry');
        return;
      }

      issueData = {
        ...issueData,
        boardId: currentBoardId,
        boardType: boardConfig.boardType,
        projectKey: boardConfig.projectKey || issueData.projectKey,
      };

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
    if (cardObserver) return;

    const observer = new MutationObserver((mutations) => {
      let headerChanged = false;
      let cardsChanged = false;

      for (const mutation of mutations) {
        if (!headerChanged && mutation.target instanceof Element && mutation.target.closest(BOARD_HEADER_SELECTOR)) {
          headerChanged = true;
        }

        for (const node of [...mutation.addedNodes, ...mutation.removedNodes]) {
          if (!(node instanceof Element)) continue;
          if (!cardsChanged && (node.matches(CARD_CONTENT_SELECTOR) || node.querySelector(CARD_CONTENT_SELECTOR))) {
            cardsChanged = true;
          }
          if (
            !headerChanged &&
            (node.matches(BOARD_HEADER_SELECTOR) || node.querySelector(BOARD_HEADER_SELECTOR))
          ) {
            headerChanged = true;
          }
        }
      }

      if (cardsChanged) {
        debouncedScan();
        scheduleBoardPresenceSync();
      }
      if (headerChanged) {
        scheduleDashboardLinkInjection();
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
        scheduleDashboardLinkInjection(0);
        debouncedScan();
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
      findCardByIssueKey(issueKey) ||
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

      for (const task of tasks) {
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
        const badge = document.querySelector(`[${BADGE_ATTR}="${task.key}"]`);
        if (badge) {
          updateBadgeState(badge, task.key, task.status);
        }
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
      await syncBoardPresence();
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
