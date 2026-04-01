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
    extra += `<button class="btn btn-log" onclick="openConvLog('${task.key}', '${escapeHtml(task.key)} — ${escapeHtml(task.summary).replace(/'/g, '&#39;')}')">View Log</button>`;
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

async function openConvLog(key, title) {
  const modal = document.getElementById('conv-modal');
  const body = document.getElementById('conv-modal-body');
  document.getElementById('conv-modal-title').textContent = title;
  body.innerHTML = '<div class="conv-loading">Loading conversation…</div>';
  modal.style.display = 'flex';
  document.body.style.overflow = 'hidden';

  try {
    const res = await fetch(`${API_BASE}/api/tasks/${key}/logs`);
    if (!res.ok) throw new Error(res.status === 404 ? 'No logs available for this task yet.' : `HTTP ${res.status}`);
    const text = await res.text();
    body.innerHTML = renderConvLog(text);
    // Scroll to bottom so latest messages are visible
    body.scrollTop = body.scrollHeight;
  } catch (err) {
    body.innerHTML = `<div class="conv-loading">${escapeHtml(err.message)}</div>`;
  }
}

function closeConvModal(event) {
  // Close when clicking the overlay background or the close button
  if (event && event.target !== document.getElementById('conv-modal') && !event.target.classList.contains('modal-close')) return;
  document.getElementById('conv-modal').style.display = 'none';
  document.body.style.overflow = '';
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
