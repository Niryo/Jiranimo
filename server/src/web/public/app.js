const API_BASE = '';
let ws = null;
let tasks = [];
let serverEpoch = 0;
let revision = 0;

async function fetchSync() {
  try {
    const res = await fetch(`${API_BASE}/api/sync`);
    if (!res.ok) throw new Error(`Sync failed: ${res.status}`);
    const data = await res.json();
    serverEpoch = data.serverEpoch || 0;
    revision = data.revision || 0;
    tasks = Array.isArray(data.tasks) ? data.tasks : [];
    render();
    void refreshOpenConvLog();
  } catch (err) {
    console.error('Failed to sync dashboard state:', err);
  }
}

function connectWs() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}/ws`);

  ws.onopen = async () => {
    document.getElementById('ws-status').textContent = 'Connected';
    document.getElementById('ws-status').className = 'connected';
    await fetchSync();
  };

  ws.onclose = () => {
    document.getElementById('ws-status').textContent = 'Disconnected';
    document.getElementById('ws-status').className = 'disconnected';
    setTimeout(connectWs, 3000);
  };

  ws.onmessage = async (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'sync-needed') {
      const nextEpoch = Number(msg.serverEpoch || 0);
      const nextRevision = Number(msg.revision || 0);
      if (nextEpoch > serverEpoch || nextRevision > revision) {
        await fetchSync();
      }
    }
  };
}

function render() {
  const queued = tasks.filter(t => t.status === 'queued');
  const inProgress = tasks.filter(t => t.status === 'in-progress');
  const interrupted = tasks.filter(t => t.status === 'interrupted');
  const completed = tasks.filter(t => t.status === 'completed');
  const failed = tasks.filter(t => t.status === 'failed');

  document.getElementById('queued-tasks').innerHTML = queued.map(taskCard).join('');
  document.getElementById('in-progress-tasks').innerHTML = inProgress.map(taskCard).join('');
  document.getElementById('interrupted-tasks').innerHTML = interrupted.map(taskCard).join('');
  document.getElementById('completed-tasks').innerHTML = completed.map(taskCard).join('');
  document.getElementById('failed-tasks').innerHTML = failed.map(taskCard).join('');

  document.getElementById('task-counts').textContent =
    `${queued.length} queued | ${inProgress.length} running | ${interrupted.length} interrupted | ${completed.length} done | ${failed.length} failed | epoch ${serverEpoch} rev ${revision}`;
}

function taskCard(task) {
  let meta = `<span>${task.priority}</span><span>${task.issueType}</span>`;

  if (task.prUrl) {
    meta += `<a href="${task.prUrl}" target="_blank">View PR</a>`;
  }
  if (task.claudeCostUsd) {
    meta += `<span>$${task.claudeCostUsd.toFixed(2)}</span>`;
  }
  if (task.resumeMode) {
    meta += `<span>Resume: ${escapeHtml(task.resumeMode)}</span>`;
  }
  if (task.resumeAfter) {
    meta += `<span>Auto resume: ${new Date(task.resumeAfter).toLocaleTimeString()}</span>`;
  }

  let extra = '';
  if (task.status === 'failed' && task.errorMessage) {
    extra = `<div class="error-msg">${escapeHtml(task.errorMessage)}</div>`;
    extra += `<button class="btn" onclick="retryTask('${task.key}')">Retry</button>`;
  }

  if (task.status === 'interrupted') {
    const reason = task.resumeReason ? `<div class="error-msg">Interrupted: ${escapeHtml(task.resumeReason)}</div>` : '';
    extra += reason;
    if (task.recoveryState === 'resume-pending') {
      extra += `<button class="btn" onclick="cancelResume('${task.key}')">Cancel Resume</button>`;
    }
    if (task.recoveryState === 'resume-cancelled') {
      extra += `<button class="btn" onclick="resumeTask('${task.key}')">Resume Now</button>`;
    }
  }

  // Show conversation log button for tasks that have been started
  const hasLogs = ['in-progress', 'interrupted', 'completed', 'failed'].includes(task.status);
  if (hasLogs) {
    extra += `<button class="btn btn-log" onclick="openConvLog('${task.key}', '${escapeHtml(task.key)} — ${escapeHtml(task.summary).replace(/'/g, '&#39;').replace(/"/g, '&quot;')}')">View Log</button>`;
  }

  const canFixComments = task.prUrl && (task.status === 'completed' || task.status === 'failed');
  if (canFixComments) {
    extra += `<button class="btn" onclick="fixComments('${task.key}')">Fix comments</button>`;
  }

  return `
    <div class="task-card status-${task.status}">
      <div class="task-key">${escapeHtml(task.key)}</div>
      <div class="task-summary">${escapeHtml(task.summary)}</div>
      <div class="task-meta">${meta}</div>
      ${extra}
    </div>
  `;
}

// ── Conversation Log Modal ────────────────────────────────

let currentLogKey = null;
let currentLogTitle = null;
let currentFullLogText = null;
let currentCompactLogText = null;
let currentLogTab = 'compact';
let isRefreshingOpenLog = false;

async function openConvLog(key, title) {
  const modal = document.getElementById('conv-modal');
  const body = document.getElementById('conv-modal-body');
  document.getElementById('conv-modal-title').textContent = title;
  body.innerHTML = '<div class="conv-loading">Loading conversation…</div>';
  modal.style.display = 'flex';
  document.body.style.overflow = 'hidden';

  currentLogKey = key;
  currentLogTitle = title;
  currentFullLogText = null;
  currentCompactLogText = null;
  currentLogTab = 'compact';
  await loadConvLog(key, { showLoading: false, preserveTab: false });
}

async function loadConvLog(key, options = {}) {
  const { showLoading = false, preserveTab = true } = options;
  const body = document.getElementById('conv-modal-body');

  if (showLoading) {
    body.innerHTML = '<div class="conv-loading">Loading conversation…</div>';
  }

  // Fetch both logs in parallel
  const [fullRes, compactRes] = await Promise.allSettled([
    fetch(`${API_BASE}/api/tasks/${key}/logs`),
    fetch(`${API_BASE}/api/tasks/${key}/compact-log`),
  ]);

  if (currentLogKey !== key) return;

  if (fullRes.status === 'fulfilled' && fullRes.value.ok) {
    currentFullLogText = await fullRes.value.text();
  }

  if (compactRes.status === 'fulfilled' && compactRes.value.ok) {
    const data = await compactRes.value.json();
    currentCompactLogText = data.compactLog ?? null;
  }

  const tabsEl = document.getElementById('log-tabs');
  if (currentCompactLogText) {
    tabsEl.style.display = 'flex';
    const nextTab = preserveTab && currentLogTab === 'full' ? 'full' : 'compact';
    setActiveTab(nextTab);
    showLogTab(nextTab);
  } else {
    // No compact log: hide tabs, show full log
    tabsEl.style.display = 'none';
    currentLogTab = 'full';
    showLogTab('full');
  }
}

async function refreshOpenConvLog() {
  const modal = document.getElementById('conv-modal');
  if (!currentLogKey || !modal || modal.style.display === 'none' || isRefreshingOpenLog) {
    return;
  }

  const task = tasks.find(t => t.key === currentLogKey);
  if (!task) return;

  const shouldRefresh = !currentCompactLogText || task.status === 'in-progress';
  if (!shouldRefresh) return;

  isRefreshingOpenLog = true;
  try {
    await loadConvLog(currentLogKey, { preserveTab: true });
  } finally {
    isRefreshingOpenLog = false;
  }
}

function setActiveTab(tab) {
  document.getElementById('tab-compact').classList.toggle('active', tab === 'compact');
  document.getElementById('tab-full').classList.toggle('active', tab === 'full');
}

function showLogTab(tab) {
  const body = document.getElementById('conv-modal-body');
  currentLogTab = tab;
  setActiveTab(tab);

  if (tab === 'compact') {
    if (currentCompactLogText) {
      body.innerHTML = renderCompactLog(currentCompactLogText);
    } else {
      body.innerHTML = '<div class="conv-loading">Compact log not available.</div>';
    }
  } else {
    if (currentFullLogText) {
      body.innerHTML = renderConvLog(currentFullLogText);
      body.scrollTop = body.scrollHeight;
    } else {
      body.innerHTML = '<div class="conv-loading">No logs available for this task yet.</div>';
    }
  }
}

function switchLogTab(tab) {
  showLogTab(tab);
}

async function copyLogToClipboard() {
  const btn = document.getElementById('btn-copy-log');
  let text = '';

  if (currentLogTab === 'compact' && currentCompactLogText) {
    text = currentCompactLogText;
  } else if (currentLogTab === 'full' && currentFullLogText) {
    // Extract plain text from the rendered full log
    const body = document.getElementById('conv-modal-body');
    text = body.innerText || body.textContent || '';
  }

  if (!text) return;

  try {
    await navigator.clipboard.writeText(text);
    const orig = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = orig; }, 1500);
  } catch {
    // fallback
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    const orig = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = orig; }, 1500);
  }
}

function closeConvModal(event) {
  // Close when clicking the overlay background or the close button
  if (event && event.target !== document.getElementById('conv-modal') && !event.target.classList.contains('modal-close')) return;
  document.getElementById('conv-modal').style.display = 'none';
  document.body.style.overflow = '';
  currentLogKey = null;
  currentLogTitle = null;
}

// Close on Escape key
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const modal = document.getElementById('conv-modal');
    if (modal && modal.style.display !== 'none') closeConvModal({ target: modal });
  }
});

function renderConvLog(rawText) {
  const lines = rawText.split('\n').filter(l => l.trim());
  if (!lines.length) return '<div class="conv-loading">Log is empty.</div>';

  const entries = [];

  for (const line of lines) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }

    switch (event.type) {
      case 'system': {
        const sessionId = event.session_id || event.sessionId || '';
        entries.push(convEntry('system', 'System', `Session started${sessionId ? ` · ${sessionId}` : ''}`));
        break;
      }
      case 'assistant': {
        const msg = event.message || event;
        const contentBlocks = msg.content || [];
        for (const block of contentBlocks) {
          if (block.type === 'text' && block.text) {
            entries.push(convEntry('assistant', 'Claude', block.text));
          } else if (block.type === 'tool_use') {
            const inputStr = block.input != null ? JSON.stringify(block.input, null, 2) : '';
            entries.push(convEntry('tool-use', `Tool: ${block.name}`, inputStr));
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
              ? block.content.map(c => c.text || '').join('\n')
              : (typeof block.content === 'string' ? block.content : '');
            entries.push(convEntry('tool-result', 'Tool Result', content));
          } else if (block.type === 'text' && block.text) {
            entries.push(convEntry('user', 'User', block.text));
          }
        }
        break;
      }
      case 'result': {
        const subtype = event.subtype || 'unknown';
        const cost = typeof event.cost_usd === 'number' ? ` · $${event.cost_usd.toFixed(4)}` : '';
        const resultText = event.result ? `\n\n${event.result}` : '';
        const cls = subtype === 'success' ? 'conv-result-success' : subtype === 'error_during_execution' ? 'conv-result-failure' : '';
        entries.push(convEntry('result', `Result: ${subtype}${cost}`, resultText.trim(), cls));
        break;
      }
      default:
        break;
    }
  }

  return entries.length ? entries.join('') : '<div class="conv-loading">No conversation entries found in log.</div>';
}

function renderCompactLog(rawText) {
  const lines = rawText
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);

  if (!lines.length) {
    return '<div class="conv-loading">Compact log is empty.</div>';
  }

  const bulletItems = [];
  const paragraphItems = [];
  let outcome = null;

  for (const line of lines) {
    const normalized = line.replace(/^[-*]\s*/, '').trim();
    if (!normalized) continue;

    if (/^\*{0,2}Outcome[:*]/i.test(normalized)) {
      outcome = normalized;
      continue;
    }

    if (/^[-*]\s/.test(line)) {
      bulletItems.push(normalized);
    } else {
      paragraphItems.push(normalized);
    }
  }

  const sections = ['<div class="compact-log-shell">'];

  if (paragraphItems.length) {
    sections.push(`
      <div class="compact-log-intro">
        ${paragraphItems.map(item => `<p>${renderCompactInline(item)}</p>`).join('')}
      </div>
    `);
  }

  if (bulletItems.length) {
    sections.push(`
      <ul class="compact-log-list">
        ${bulletItems.map(item => `
          <li class="compact-log-item">
            <span class="compact-log-marker"></span>
            <div class="compact-log-item-text">${renderCompactInline(item)}</div>
          </li>
        `).join('')}
      </ul>
    `);
  }

  if (outcome) {
    sections.push(`
      <div class="compact-log-outcome">
        <div class="compact-log-outcome-label">Outcome</div>
        <div class="compact-log-outcome-text">${renderCompactInline(stripOutcomeLabel(outcome))}</div>
      </div>
    `);
  }

  sections.push('</div>');
  return sections.join('');
}

function stripOutcomeLabel(text) {
  return text
    .replace(/^\*{0,2}Outcome\*{0,2}:\s*/i, '')
    .trim();
}

function renderCompactInline(text) {
  return escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

function convEntry(type, role, text, extraClass = '') {
  return `
    <div class="conv-entry conv-${type}${extraClass ? ' ' + extraClass : ''}">
      <div class="conv-role">${escapeHtml(role)}</div>
      <div class="conv-text">${escapeHtml(text)}</div>
    </div>
  `;
}

async function retryTask(key) {
  try {
    await fetch(`${API_BASE}/api/tasks/${key}/retry`, { method: 'POST' });
  } catch (err) {
    console.error('Failed to retry task:', err);
  }
}

async function fixComments(key) {
  try {
    const res = await fetch(`${API_BASE}/api/tasks/${key}/fix-comments`, { method: 'POST' });
    if (!res.ok) {
      let message = `Failed to fix comments: ${res.status}`;
      try {
        const data = await res.json();
        if (data?.error) message = data.error;
      } catch {
        // ignore
      }
      throw new Error(message);
    }
    await fetchSync();
  } catch (err) {
    console.error('Failed to fix comments:', err);
    alert(err.message || 'Failed to fix comments');
  }
}

async function cancelResume(key) {
  try {
    await fetch(`${API_BASE}/api/tasks/${key}/cancel-resume`, { method: 'POST' });
  } catch (err) {
    console.error('Failed to cancel resume:', err);
  }
}

async function resumeTask(key) {
  try {
    await fetch(`${API_BASE}/api/tasks/${key}/resume`, { method: 'POST' });
  } catch (err) {
    console.error('Failed to resume task:', err);
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

fetchSync();
connectWs();
