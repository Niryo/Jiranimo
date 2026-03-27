const API_BASE = '';
let ws = null;
let tasks = [];

async function fetchTasks() {
  try {
    const res = await fetch(`${API_BASE}/api/tasks`);
    tasks = await res.json();
    render();
  } catch (err) {
    console.error('Failed to fetch tasks:', err);
  }
}

function connectWs() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}/ws`);

  ws.onopen = () => {
    document.getElementById('ws-status').textContent = 'Connected';
    document.getElementById('ws-status').className = 'connected';
  };

  ws.onclose = () => {
    document.getElementById('ws-status').textContent = 'Disconnected';
    document.getElementById('ws-status').className = 'disconnected';
    setTimeout(connectWs, 3000);
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    handleWsMessage(msg);
  };
}

function handleWsMessage(msg) {
  if (msg.type === 'task-created' || msg.type === 'task-status-changed' || msg.type === 'task-completed') {
    const idx = tasks.findIndex(t => t.key === msg.task.key);
    if (idx >= 0) {
      tasks[idx] = msg.task;
    } else {
      tasks.push(msg.task);
    }
    render();
  }
}

function render() {
  const queued = tasks.filter(t => t.status === 'queued');
  const inProgress = tasks.filter(t => t.status === 'in-progress');
  const completed = tasks.filter(t => t.status === 'completed');
  const failed = tasks.filter(t => t.status === 'failed');

  document.getElementById('queued-tasks').innerHTML = queued.map(taskCard).join('');
  document.getElementById('in-progress-tasks').innerHTML = inProgress.map(taskCard).join('');
  document.getElementById('completed-tasks').innerHTML = completed.map(taskCard).join('');
  document.getElementById('failed-tasks').innerHTML = failed.map(taskCard).join('');

  document.getElementById('task-counts').textContent =
    `${queued.length} queued | ${inProgress.length} running | ${completed.length} done | ${failed.length} failed`;
}

function taskCard(task) {
  let meta = `<span>${task.priority}</span><span>${task.issueType}</span>`;

  if (task.prUrl) {
    meta += `<a href="${task.prUrl}" target="_blank">View PR</a>`;
  }
  if (task.claudeCostUsd) {
    meta += `<span>$${task.claudeCostUsd.toFixed(2)}</span>`;
  }

  let extra = '';
  if (task.status === 'failed' && task.errorMessage) {
    extra = `<div class="error-msg">${escapeHtml(task.errorMessage)}</div>`;
    extra += `<button class="btn" onclick="retryTask('${task.key}')">Retry</button>`;
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

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

fetchTasks();
connectWs();
