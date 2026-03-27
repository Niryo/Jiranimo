// @ts-check
/* global chrome */

document.addEventListener('DOMContentLoaded', () => {
  loadSettings();

  document.getElementById('save-btn').addEventListener('click', saveSettings);
});

async function loadSettings() {
  const settings = await chrome.storage.local.get(['jiraHost', 'serverUrl']);

  document.getElementById('jira-host').value = settings.jiraHost || '';
  document.getElementById('server-url').value = settings.serverUrl || 'http://localhost:3456';

  loadBoardConfigs();
}

async function saveSettings() {
  const jiraHost = document.getElementById('jira-host').value.trim();
  const serverUrl = document.getElementById('server-url').value.trim() || 'http://localhost:3456';

  await chrome.storage.local.set({ jiraHost, serverUrl });

  const msg = document.getElementById('saved-msg');
  msg.style.display = 'inline';
  setTimeout(() => { msg.style.display = 'none'; }, 2000);
}

async function loadBoardConfigs() {
  const all = await chrome.storage.local.get(null);
  const container = document.getElementById('boards-list');
  container.innerHTML = '';

  const boardKeys = Object.keys(all).filter(k => k.startsWith('boardConfig_'));

  if (boardKeys.length === 0) {
    container.innerHTML = '<p style="color: #6b778c; font-size: 13px;">No boards configured yet. Visit a Jira board to set one up.</p>';
    return;
  }

  for (const key of boardKeys) {
    const config = all[key];
    const item = document.createElement('div');
    item.className = 'board-item';
    item.innerHTML = `
      <div>
        <strong>Board ${config.boardId}</strong> (${config.projectKey || '?'})
      </div>
      <button data-key="${key}">Remove</button>
    `;
    item.querySelector('button').addEventListener('click', async () => {
      await chrome.storage.local.remove(key);
      loadBoardConfigs();
    });
    container.appendChild(item);
  }
}
