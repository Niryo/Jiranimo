import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const CONTENT_SCRIPT_PATH = './content.js';

function flushMicrotasks() {
  return Promise.resolve().then(() => Promise.resolve()).then(() => Promise.resolve());
}

async function loadContentScript() {
  vi.resetModules();
  delete require.cache[require.resolve(CONTENT_SCRIPT_PATH)];
  require(CONTENT_SCRIPT_PATH);
  await flushMicrotasks();
}

function createBoardConfig() {
  return {
    boardType: 'scrum',
    todoStatuses: ['To Do'],
    projectKey: 'PROJ',
  };
}

function parseSelector(selector) {
  const normalized = selector.trim();
  if (!normalized) return null;

  const result = {
    tag: null,
    id: null,
    classes: [],
    attrs: [],
  };

  const tagMatch = normalized.match(/^[a-z]+/i);
  let rest = normalized;
  if (tagMatch) {
    result.tag = tagMatch[0].toLowerCase();
    rest = rest.slice(tagMatch[0].length);
  }

  while (rest.length > 0) {
    if (rest.startsWith('#')) {
      const match = rest.match(/^#([a-zA-Z0-9_-]+)/);
      if (!match) break;
      result.id = match[1];
      rest = rest.slice(match[0].length);
      continue;
    }

    if (rest.startsWith('.')) {
      const match = rest.match(/^\.([a-zA-Z0-9_-]+)/);
      if (!match) break;
      result.classes.push(match[1]);
      rest = rest.slice(match[0].length);
      continue;
    }

    if (rest.startsWith('[')) {
      const endIndex = rest.indexOf(']');
      const content = rest.slice(1, endIndex);
      const containsMatch = content.match(/^([^\]=~*]+)\*="([^"]*)"$/);
      const exactMatch = content.match(/^([^\]=~*]+)="([^"]*)"$/);
      const existsMatch = content.match(/^([^\]=~*]+)$/);

      if (containsMatch) {
        result.attrs.push({ name: containsMatch[1], operator: '*=', value: containsMatch[2] });
      } else if (exactMatch) {
        result.attrs.push({ name: exactMatch[1], operator: '=', value: exactMatch[2] });
      } else if (existsMatch) {
        result.attrs.push({ name: existsMatch[1], operator: 'exists', value: '' });
      }
      rest = rest.slice(endIndex + 1);
      continue;
    }

    break;
  }

  return result;
}

function matchesSelector(element, selector) {
  const parsed = parseSelector(selector);
  if (!parsed) return false;

  if (parsed.tag && element.localName !== parsed.tag) return false;
  if (parsed.id && element.id !== parsed.id) return false;

  for (const className of parsed.classes) {
    if (!element.classList.contains(className)) return false;
  }

  for (const attr of parsed.attrs) {
    const value = element.getAttribute(attr.name);
    if (attr.operator === 'exists' && value == null) return false;
    if (attr.operator === '=' && value !== attr.value) return false;
    if (attr.operator === '*=' && (typeof value !== 'string' || !value.includes(attr.value))) return false;
  }

  return true;
}

function matchesSelectorList(element, selectorList) {
  return selectorList
    .split(',')
    .map(selector => selector.trim())
    .filter(Boolean)
    .some(selector => matchesSelector(element, selector));
}

class FakeTextNode {
  constructor(text, ownerDocument) {
    this.nodeType = 3;
    this.textContent = text;
    this.ownerDocument = ownerDocument;
    this.parentElement = null;
  }
}

class FakeElement {
  constructor(localName, ownerDocument) {
    this.nodeType = 1;
    this.localName = String(localName || '').toLowerCase();
    this.ownerDocument = ownerDocument;
    this.parentElement = null;
    this.childNodes = [];
    this.attributes = new Map();
    this._listeners = new Map();
    this._className = '';
    this._innerHTML = '';
  }

  get children() {
    return this.childNodes.filter(node => node instanceof FakeElement);
  }

  get firstElementChild() {
    return this.children[0] || null;
  }

  get id() {
    return this.getAttribute('id') || '';
  }

  set id(value) {
    this.setAttribute('id', value);
  }

  get className() {
    return this._className;
  }

  set className(value) {
    this._className = value || '';
    if (this._className) {
      this.attributes.set('class', this._className);
    } else {
      this.attributes.delete('class');
    }
  }

  get classList() {
    return {
      contains: (className) => this.className.split(/\s+/).filter(Boolean).includes(className),
      toggle: (className, force) => {
        const classes = new Set(this.className.split(/\s+/).filter(Boolean));
        const nextValue = force === undefined ? !classes.has(className) : Boolean(force);
        if (nextValue) classes.add(className);
        else classes.delete(className);
        this.className = [...classes].join(' ');
        return nextValue;
      },
    };
  }

  get innerHTML() {
    return this._innerHTML;
  }

  set innerHTML(value) {
    this._innerHTML = value || '';
    this.childNodes = [];
  }

  get textContent() {
    if (this.childNodes.length === 0) return '';
    return this.childNodes.map(node => node.textContent || '').join('');
  }

  set textContent(value) {
    this.childNodes = [];
    if (value) {
      const textNode = new FakeTextNode(String(value), this.ownerDocument);
      textNode.parentElement = this;
      this.childNodes.push(textNode);
    }
  }

  appendChild(node) {
    if (node.parentElement) {
      node.parentElement.removeChild(node);
    }
    node.parentElement = this;
    this.childNodes.push(node);
    this.ownerDocument.notifyMutation(this, [node], []);
    return node;
  }

  removeChild(node) {
    const index = this.childNodes.indexOf(node);
    if (index >= 0) {
      this.childNodes.splice(index, 1);
      node.parentElement = null;
      this.ownerDocument.notifyMutation(this, [], [node]);
    }
    return node;
  }

  remove() {
    if (this.parentElement) {
      this.parentElement.removeChild(this);
    }
  }

  insertAdjacentElement(position, element) {
    if (position !== 'afterend' || !this.parentElement) return null;
    const siblings = this.parentElement.childNodes;
    const index = siblings.indexOf(this);
    element.parentElement = this.parentElement;
    siblings.splice(index + 1, 0, element);
    this.ownerDocument.notifyMutation(this.parentElement, [element], []);
    return element;
  }

  setAttribute(name, value) {
    const normalizedValue = String(value);
    if (name === 'class') {
      this.className = normalizedValue;
      return;
    }
    this.attributes.set(name, normalizedValue);
  }

  getAttribute(name) {
    if (name === 'class') return this.className || null;
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  getAttributeNames() {
    const names = [...this.attributes.keys()];
    if (this.className && !names.includes('class')) {
      names.push('class');
    }
    return names;
  }

  removeAttribute(name) {
    if (name === 'class') {
      this.className = '';
      return;
    }
    this.attributes.delete(name);
  }

  toggleAttribute(name, force) {
    const nextValue = force === undefined ? !this.attributes.has(name) : Boolean(force);
    if (nextValue) {
      this.setAttribute(name, '');
    } else {
      this.attributes.delete(name);
    }
  }

  matches(selector) {
    return matchesSelectorList(this, selector);
  }

  closest(selector) {
    let current = this;
    while (current) {
      if (current.matches(selector)) return current;
      current = current.parentElement;
    }
    return null;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    const results = [];
    const visit = (node) => {
      if (!(node instanceof FakeElement)) return;
      if (matchesSelectorList(node, selector)) {
        results.push(node);
      }
      for (const child of node.childNodes) {
        visit(child);
      }
    };

    for (const child of this.childNodes) {
      visit(child);
    }
    return results;
  }

  addEventListener(type, listener) {
    if (!this._listeners.has(type)) {
      this._listeners.set(type, []);
    }
    this._listeners.get(type).push(listener);
  }

  dispatchEvent(event) {
    const listeners = this._listeners.get(event?.type) || [];
    for (const listener of listeners) {
      listener.call(this, event);
    }
    return true;
  }

  click() {
    this.dispatchEvent({
      type: 'click',
      target: this,
      currentTarget: this,
      preventDefault() {},
      stopPropagation() {},
    });
  }
}

class FakeDocument {
  constructor() {
    this._observers = [];
    this.documentElement = new FakeElement('html', this);
    this.head = new FakeElement('head', this);
    this.body = new FakeElement('body', this);
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
  }

  createElement(localName) {
    return new FakeElement(localName, this);
  }

  querySelector(selector) {
    if (this.documentElement.matches(selector)) return this.documentElement;
    return this.documentElement.querySelector(selector);
  }

  querySelectorAll(selector) {
    const results = [];
    if (this.documentElement.matches(selector)) {
      results.push(this.documentElement);
    }
    return results.concat(this.documentElement.querySelectorAll(selector));
  }

  getElementById(id) {
    return this.querySelector(`#${id}`);
  }

  notifyMutation(target, addedNodes, removedNodes) {
    const isWithinTarget = (node, targetNode) => {
      let current = node;
      while (current) {
        if (current === targetNode) return true;
        current = current.parentElement;
      }
      return false;
    };

    for (const observer of this._observers) {
      if (!observer.target) continue;
      const isTargetMatch = target === observer.target;
      const isSubtreeMatch = observer.options?.subtree && isWithinTarget(target, observer.target);
      if (!isTargetMatch && !isSubtreeMatch) continue;
      observer.callback([{ target, addedNodes, removedNodes }]);
    }
  }
}

class FakeMutationObserver {
  constructor(callback, document) {
    this.callback = callback;
    this.document = document;
    this.target = null;
    this.options = null;
  }

  observe(target, options) {
    this.target = target;
    this.options = options;
    this.document._observers.push(this);
  }

  disconnect() {}
}

function createTaskListItem(document, issueKey, summary = 'Implement me') {
  const li = document.createElement('li');
  const card = document.createElement('div');
  card.setAttribute('data-testid', 'platform-board-kit.ui.card.card');
  card.id = `card-${issueKey}`;

  const key = document.createElement('span');
  key.setAttribute('data-testid', 'platform-card.common.ui.key.key');
  key.textContent = issueKey;

  const summaryElement = document.createElement('span');
  summaryElement.setAttribute('data-component-selector', 'issue-field-summary-inline-edit.ui.read.static-summary');
  summaryElement.textContent = summary;

  card.appendChild(key);
  card.appendChild(summaryElement);
  li.appendChild(card);
  return li;
}

function createBoardWithColumns(document, columnCount = 2) {
  const board = document.createElement('section');
  const columns = [];

  for (let index = 0; index < columnCount; index += 1) {
    const column = document.createElement('div');
    column.setAttribute('data-testid', `test-column-${index}`);
    const list = document.createElement('ul');
    column.appendChild(list);
    board.appendChild(column);
    columns.push({ column, list });
  }

  document.body.appendChild(board);
  return { board, columns };
}

function setupGlobals(pathname, options = {}) {
  const {
    boardConfig = null,
    sendMessageImpl = null,
    fetchImpl = null,
  } = options;
  const document = new FakeDocument();
  const webSockets = [];
  const get = vi.fn(async (keys) => {
    if (Array.isArray(keys) && keys[0] === 'serverUrl') return {};
    if (Array.isArray(keys) && typeof keys[0] === 'string' && keys[0].startsWith('boardConfig_')) {
      return boardConfig ? { [keys[0]]: boardConfig } : {};
    }
    return {};
  });
  const show = vi.fn();
  const ensureMetadata = vi.fn(async (_boardId, config) => config);

  class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;

    constructor(url) {
      this.url = url;
      this.readyState = FakeWebSocket.CONNECTING;
      this.onopen = null;
      this.onmessage = null;
      this.onclose = null;
      this.onerror = null;
      webSockets.push(this);
    }
  }

  vi.stubGlobal('document', document);
  vi.stubGlobal('Element', FakeElement);
  vi.stubGlobal('HTMLElement', FakeElement);
  vi.stubGlobal('HTMLButtonElement', FakeElement);
  vi.stubGlobal('HTMLSelectElement', FakeElement);
  vi.stubGlobal('MutationObserver', class {
    constructor(callback) {
      this.impl = new FakeMutationObserver(callback, document);
    }

    observe(target, options) {
      this.impl.observe(target, options);
    }

    disconnect() {
      this.impl.disconnect();
    }
  });
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get,
      },
    },
    runtime: {
      lastError: null,
      sendMessage: sendMessageImpl || vi.fn(),
    },
  });
  vi.stubGlobal('BoardConfig', {
    show,
    ensureMetadata,
  });
  vi.stubGlobal('location', {
    href: `https://example.atlassian.net${pathname}`,
    pathname,
    host: 'example.atlassian.net',
    origin: 'https://example.atlassian.net',
    reload: vi.fn(),
  });
  vi.stubGlobal('addEventListener', vi.fn());
  vi.stubGlobal('setInterval', vi.fn(() => 1));
  vi.stubGlobal('clearInterval', vi.fn());
  vi.stubGlobal('setTimeout', vi.fn(() => 1));
  vi.stubGlobal('clearTimeout', vi.fn());
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal('fetch', fetchImpl || vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })));

  return { document, get, show, webSockets };
}

describe('content script startup', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    ['/jira/software/projects/PROJ/boards/123', '123'],
    ['/jira/software/c/projects/PROJ/boards/456/backlog', '456'],
  ])('loads board config for %s', async (pathname, boardId) => {
    const { get, show } = setupGlobals(pathname);

    await loadContentScript();

    expect(get).toHaveBeenNthCalledWith(1, ['serverUrl']);
    expect(get).toHaveBeenNthCalledWith(2, [`boardConfig_${boardId}`]);
    expect(show).toHaveBeenCalledOnce();
    expect(show).toHaveBeenCalledWith(boardId, expect.any(Function));
  });

  it('skips board setup outside board routes', async () => {
    const { get, show } = setupGlobals('/jira/software/projects/PROJ');

    await loadContentScript();

    expect(get).toHaveBeenCalledOnce();
    expect(get).toHaveBeenCalledWith(['serverUrl']);
    expect(show).not.toHaveBeenCalled();
  });

  it('injects badges during the initial li scan', async () => {
    const { document } = setupGlobals('/jira/software/projects/PROJ/boards/123', { boardConfig: createBoardConfig() });
    const board = document.createElement('ul');
    board.id = 'board';
    board.appendChild(createTaskListItem(document, 'PROJ-101', 'Initial task'));
    document.body.appendChild(board);

    await loadContentScript();

    const badge = document.querySelector('[data-jiranimo="PROJ-101"]');
    expect(badge).not.toBeNull();
  });

  it('injects badges for li items added after startup', async () => {
    const { document } = setupGlobals('/jira/software/projects/PROJ/boards/123', { boardConfig: createBoardConfig() });
    const board = document.createElement('ul');
    board.id = 'board';
    document.body.appendChild(board);

    await loadContentScript();

    board.appendChild(createTaskListItem(document, 'PROJ-102', 'Dynamic task'));
    await flushMicrotasks();

    const badge = document.querySelector('[data-jiranimo="PROJ-102"]');
    expect(badge).not.toBeNull();
  });

  it('injects badges only for tasks in the leftmost column', async () => {
    const { document } = setupGlobals('/jira/software/projects/PROJ/boards/123', { boardConfig: createBoardConfig() });
    const { columns } = createBoardWithColumns(document, 2);
    columns[0].list.appendChild(createTaskListItem(document, 'PROJ-201', 'Left column task'));
    columns[1].list.appendChild(createTaskListItem(document, 'PROJ-202', 'Right column task'));

    await loadContentScript();

    expect(document.querySelector('[data-jiranimo="PROJ-201"]')).not.toBeNull();
    expect(document.querySelector('[data-jiranimo="PROJ-202"]')).toBeNull();
  });

  it('removes badges when a task moves out of the leftmost column', async () => {
    const { document } = setupGlobals('/jira/software/projects/PROJ/boards/123', { boardConfig: createBoardConfig() });
    const { columns } = createBoardWithColumns(document, 2);
    const taskItem = createTaskListItem(document, 'PROJ-203', 'Movable task');
    columns[0].list.appendChild(taskItem);

    await loadContentScript();

    expect(document.querySelector('[data-jiranimo="PROJ-203"]')).not.toBeNull();

    columns[1].list.appendChild(taskItem);
    await flushMicrotasks();

    expect(document.querySelector('[data-jiranimo="PROJ-203"]')).toBeNull();
  });

  it('preserves a badge after click even when the task moves right', async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).includes('/rest/api/3/issue/PROJ-204?fields=')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            fields: {
              summary: 'Pinned task',
              description: null,
              priority: { name: 'Medium' },
              issuetype: { name: 'Task' },
              labels: [],
              comment: { comments: [] },
              status: { name: 'To Do' },
              subtasks: [],
              issuelinks: [],
              assignee: null,
              reporter: null,
              components: [],
              attachment: [],
              parent: null,
            },
            renderedFields: {},
          }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });
    const sendMessageImpl = vi.fn((message, callback) => {
      callback?.({ ok: true, status: 200, data: message.path === '/api/tasks' ? { ok: true } : { tasks: [] } });
    });
    const { document } = setupGlobals('/jira/software/projects/PROJ/boards/123', {
      boardConfig: createBoardConfig(),
      fetchImpl,
      sendMessageImpl,
    });
    const { columns } = createBoardWithColumns(document, 2);
    const taskItem = createTaskListItem(document, 'PROJ-204', 'Pinned task');
    columns[0].list.appendChild(taskItem);

    await loadContentScript();

    const badge = document.querySelector('[data-jiranimo="PROJ-204"]');
    expect(badge).not.toBeNull();

    badge.click();
    await flushMicrotasks();

    columns[1].list.appendChild(taskItem);
    await flushMicrotasks();

    const movedBadge = document.querySelector('[data-jiranimo="PROJ-204"]');
    expect(movedBadge).not.toBeNull();
    expect(movedBadge?.getAttribute('class')).toContain('queued');
  });

  it('restores badges for started tasks outside the leftmost column after sync', async () => {
    const sendMessageImpl = vi.fn((message, callback) => {
      if (message.path?.startsWith('/api/sync')) {
        callback?.({
          ok: true,
          status: 200,
          data: {
            tasks: [{ key: 'PROJ-205', status: 'queued' }],
            pendingEffects: [],
            serverEpoch: 1,
            revision: 1,
          },
        });
        return;
      }
      callback?.({ ok: true, status: 200, data: { tasks: [] } });
    });
    const { document, webSockets } = setupGlobals('/jira/software/projects/PROJ/boards/123', {
      boardConfig: createBoardConfig(),
      sendMessageImpl,
    });
    const { columns } = createBoardWithColumns(document, 2);
    columns[1].list.appendChild(createTaskListItem(document, 'PROJ-205', 'Synced task'));

    await loadContentScript();

    expect(document.querySelector('[data-jiranimo="PROJ-205"]')).toBeNull();

    await webSockets[0].onopen?.();
    await flushMicrotasks();

    const syncedBadge = document.querySelector('[data-jiranimo="PROJ-205"]');
    expect(syncedBadge).not.toBeNull();
    expect(syncedBadge?.getAttribute('class')).toContain('queued');
  });

  it('opens a task modal for completed tasks instead of opening the PR immediately', async () => {
    const sendMessageImpl = vi.fn((message, callback) => {
      if (message.type === 'server-fetch' && message.path?.startsWith('/api/sync')) {
        callback?.({
          ok: true,
          status: 200,
          data: {
            tasks: [{
              key: 'PROJ-206',
              status: 'completed',
              summary: 'Ship the change',
              priority: 'Medium',
              issueType: 'Task',
              prUrl: 'https://github.com/acme/repo/pull/206',
              claudeCostUsd: 0.18,
              completedAt: '2026-04-04T10:00:00.000Z',
            }],
            pendingEffects: [],
            serverEpoch: 1,
            revision: 1,
          },
        });
        return;
      }

      if (message.type === 'server-fetch' && message.path === '/api/tasks/PROJ-206/compact-log') {
        callback?.({
          ok: true,
          status: 200,
          data: {
            compactLog: 'Built the feature.\n- Opened a PR\nOutcome: Ready for review',
          },
        });
        return;
      }

      if (message.type === 'server-fetch' && message.path === '/api/tasks/PROJ-206/logs') {
        callback?.({
          ok: true,
          status: 200,
          text: [
            JSON.stringify({ type: 'system', session_id: 'sess-1' }),
            JSON.stringify({
              type: 'assistant',
              message: { content: [{ type: 'text', text: 'Implemented the feature.' }] },
            }),
          ].join('\n'),
        });
        return;
      }

      if (message.type === 'open-tab') {
        callback?.({ ok: true, tabId: 1 });
        return;
      }

      callback?.({ ok: true, status: 200, data: {} });
    });

    const { document, webSockets } = setupGlobals('/jira/software/projects/PROJ/boards/123', {
      boardConfig: createBoardConfig(),
      sendMessageImpl,
    });
    const { columns } = createBoardWithColumns(document, 2);
    columns[0].list.appendChild(createTaskListItem(document, 'PROJ-206', 'Ship the change'));

    await loadContentScript();
    await webSockets[0].onopen?.();
    await flushMicrotasks();

    const badge = document.querySelector('[data-jiranimo="PROJ-206"]');
    expect(badge).not.toBeNull();

    badge.click();
    await flushMicrotasks();

    const openTabCallsAfterBadgeClick = sendMessageImpl.mock.calls.filter(([message]) => message.type === 'open-tab');
    expect(openTabCallsAfterBadgeClick).toHaveLength(0);

    const overlay = document.querySelector('.jiranimo-task-modal-overlay');
    expect(overlay).not.toBeNull();
    expect(overlay?.getAttribute('hidden')).toBeNull();
    expect(document.querySelector('.jiranimo-task-card-key')).toBeNull();
    expect(document.querySelector('.jiranimo-task-card-summary')?.textContent).toBe('Ship the change');

    const viewPrButton = document.querySelector('.jiranimo-task-card-meta-link');
    expect(viewPrButton?.textContent).toBe('View PR');

    const viewLogButton = document.querySelector('.jiranimo-task-btn-log');
    expect(viewLogButton?.textContent).toBe('View Log');

    viewLogButton?.click();
    await flushMicrotasks();

    const compactTab = document.querySelector('.jiranimo-task-modal-log-tab-compact');
    const fullTab = document.querySelector('.jiranimo-task-modal-log-tab-full');
    expect(compactTab?.getAttribute('hidden')).toBeNull();
    expect(fullTab?.getAttribute('hidden')).toBeNull();
    expect(compactTab?.className).toContain('active');
    expect(document.querySelector('.jiranimo-compact-log-shell')).not.toBeNull();

    fullTab?.click();
    await flushMicrotasks();

    expect(fullTab?.className).toContain('active');
    expect(document.querySelector('.jiranimo-log-entry')).not.toBeNull();

    const backButton = document.querySelector('.jiranimo-task-modal-back');
    backButton?.click();
    await flushMicrotasks();

    expect(document.querySelector('.jiranimo-task-card-summary')?.textContent).toBe('Ship the change');

    viewPrButton?.click();
    await flushMicrotasks();

    const openTabCallsAfterViewPr = sendMessageImpl.mock.calls.filter(([message]) => message.type === 'open-tab');
    expect(openTabCallsAfterViewPr).toHaveLength(1);
    expect(openTabCallsAfterViewPr[0][0]).toMatchObject({
      type: 'open-tab',
      url: 'https://github.com/acme/repo/pull/206',
    });
  });

  it('opens a failed task modal with the error instead of retrying immediately', async () => {
    const sendMessageImpl = vi.fn((message, callback) => {
      if (message.type === 'server-fetch' && message.path?.startsWith('/api/sync')) {
        callback?.({
          ok: true,
          status: 200,
          data: {
            tasks: [{
              key: 'PROJ-207',
              status: 'failed',
              summary: 'Broken task',
              priority: 'High',
              issueType: 'Bug',
              errorMessage: 'Claude failed to apply the patch.',
              completedAt: '2026-04-04T10:00:00.000Z',
            }],
            pendingEffects: [],
            serverEpoch: 1,
            revision: 1,
          },
        });
        return;
      }

      if (message.type === 'server-fetch' && message.path === '/api/tasks/PROJ-207/logs') {
        callback?.({
          ok: true,
          status: 200,
          text: JSON.stringify({
            type: 'result',
            subtype: 'error_during_execution',
            result: 'Patch application failed.',
          }),
        });
        return;
      }

      callback?.({ ok: true, status: 200, data: {} });
    });

    const { document, webSockets } = setupGlobals('/jira/software/projects/PROJ/boards/123', {
      boardConfig: createBoardConfig(),
      sendMessageImpl,
    });
    const { columns } = createBoardWithColumns(document, 2);
    columns[0].list.appendChild(createTaskListItem(document, 'PROJ-207', 'Broken task'));

    await loadContentScript();
    await webSockets[0].onopen?.();
    await flushMicrotasks();

    const badge = document.querySelector('[data-jiranimo="PROJ-207"]');
    expect(badge).not.toBeNull();

    badge?.click();
    await flushMicrotasks();

    const retryCallsAfterBadgeClick = sendMessageImpl.mock.calls.filter(([message]) => message.path === '/api/tasks/PROJ-207/retry');
    expect(retryCallsAfterBadgeClick).toHaveLength(0);

    expect(document.querySelector('.jiranimo-task-card-message-error')?.textContent).toContain('Claude failed to apply the patch.');

    const retryButton = Array.from(document.querySelectorAll('.jiranimo-task-btn')).find(button => button.textContent === 'Retry');
    expect(retryButton).toBeDefined();

    const viewLogButton = document.querySelector('.jiranimo-task-btn-log');
    expect(viewLogButton?.textContent).toBe('View Log');

    viewLogButton?.click();
    await flushMicrotasks();

    expect(document.querySelector('.jiranimo-log-entry')).not.toBeNull();
  });

  it('does not inject on parent li wrappers around nested task items', async () => {
    const { document } = setupGlobals('/jira/software/projects/PROJ/boards/123', { boardConfig: createBoardConfig() });
    const board = document.createElement('ul');
    const outer = document.createElement('li');
    outer.id = 'outer';
    const nested = document.createElement('ul');
    nested.id = 'nested';
    outer.appendChild(nested);
    board.appendChild(outer);
    nested.appendChild(createTaskListItem(document, 'PROJ-103', 'Nested task'));
    document.body.appendChild(board);

    await loadContentScript();

    expect(document.querySelectorAll('[data-jiranimo="PROJ-103"]')).toHaveLength(1);
    expect(outer.querySelectorAll('[data-jiranimo]').length).toBe(1);
  });
});
