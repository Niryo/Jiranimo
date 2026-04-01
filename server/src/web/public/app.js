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

  return `
    <div class="task-card status-${task.status}">
      <div class="task-key">${escapeHtml(task.key)}</div>
      <div class="task-summary">${escapeHtml(task.summary)}</div>
      <div class="task-meta">${meta}</div>
      ${extra}
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
