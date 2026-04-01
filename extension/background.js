/**
 * Jiranimo background service worker.
 *
 * NOTE: This worker does NOT make Jira API calls. All Jira communication
 * goes through the content script which has session cookies.
 *
 * This worker handles:
 * - Extension settings
 * - Dev mode auto-reload (listens for reload signal from server WebSocket)
 */

// @ts-check

const LOG = '[Jiranimo BG]';
let serverUrl = 'http://localhost:3456';

function normalizeServerUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === '127.0.0.1') {
      parsed.hostname = 'localhost';
    }
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return url;
  }
}

// Load settings on startup
chrome.storage.local.get(['serverUrl'], (result) => {
  if (result.serverUrl) serverUrl = normalizeServerUrl(result.serverUrl);
});

// Listen for settings changes
chrome.storage.onChanged.addListener((changes) => {
  if (changes.serverUrl?.newValue) {
    serverUrl = normalizeServerUrl(changes.serverUrl.newValue);
  }
});

// --- Dev mode auto-reload ---
// Connect to server WebSocket and listen for extension-reload signals.
// In production the server isn't on localhost, so this silently fails.
function connectForAutoReload() {
  const wsUrl = serverUrl.replace(/^http/, 'ws') + '/ws';
  try {
    const ws = new WebSocket(wsUrl);

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'extension-reload') {
          console.log(LOG, 'Reload signal received — reloading extension');
          chrome.runtime.reload();
        }
      } catch {
        // ignore
      }
    };

    ws.onclose = () => {
      // Reconnect after delay (server might restart during dev)
      setTimeout(connectForAutoReload, 5000);
    };

    ws.onerror = () => {
      // Will trigger onclose → reconnect
    };
  } catch {
    // No server running — retry later
    setTimeout(connectForAutoReload, 10000);
  }
}

connectForAutoReload();

// Proxy Jiranimo server API calls from content scripts.
// Content scripts run in the page's origin (atlassian.net), which Chrome's
// Private Network Access policy blocks from fetching localhost directly.
// The background service worker has extension origin and can access localhost freely.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'server-fetch') {
    fetch(serverUrl + msg.path, {
      method: msg.method || 'GET',
      headers: msg.body ? { 'Content-Type': 'application/json' } : undefined,
      body: msg.body ? JSON.stringify(msg.body) : undefined,
    })
      .then(async res => {
        const data = await res.json().catch(() => ({}));
        sendResponse({ ok: res.ok, status: res.status, data });
      })
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true; // keep channel open for async response
  }
});
