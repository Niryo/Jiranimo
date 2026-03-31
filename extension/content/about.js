/**
 * About overlay for Jiranimo.
 * Shown on the board screen when the user presses Cmd+E (or Ctrl+E on Windows/Linux).
 */

// @ts-check

const AboutOverlay = {
  show() {
    // Prevent duplicate overlays
    if (document.querySelector('.jiranimo-about-overlay')) return;

    const overlay = document.createElement('div');
    overlay.className = 'jiranimo-about-overlay';

    const modal = document.createElement('div');
    modal.className = 'jiranimo-about-modal';

    modal.innerHTML = `
      <div class="jiranimo-about-header">
        <div class="jiranimo-about-title">
          <svg class="jiranimo-about-logo" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
            <path fill-rule="evenodd" d="M9 4.5a.75.75 0 01.721.544l.813 2.846a3.75 3.75 0 002.576 2.576l2.846.813a.75.75 0 010 1.442l-2.846.813a3.75 3.75 0 00-2.576 2.576l-.813 2.846a.75.75 0 01-1.442 0l-.813-2.846a3.75 3.75 0 00-2.576-2.576l-2.846-.813a.75.75 0 010-1.442l2.846-.813A3.75 3.75 0 007.466 7.89l.813-2.846A.75.75 0 019 4.5zM18 1.5a.75.75 0 01.728.568l.258 1.036c.236.94.97 1.674 1.91 1.91l1.036.258a.75.75 0 010 1.456l-1.036.258c-.94.236-1.674.97-1.91 1.91l-.258 1.036a.75.75 0 01-1.456 0l-.258-1.036a2.625 2.625 0 00-1.91-1.91l-1.036-.258a.75.75 0 010-1.456l1.036-.258a2.625 2.625 0 001.91-1.91l.258-1.036A.75.75 0 0118 1.5zM16.5 15a.75.75 0 01.712.513l.394 1.183c.15.447.5.799.948.948l1.183.395a.75.75 0 010 1.422l-1.183.395c-.447.15-.799.5-.948.948l-.395 1.183a.75.75 0 01-1.422 0l-.395-1.183a1.5 1.5 0 00-.948-.948l-1.183-.395a.75.75 0 010-1.422l1.183-.395c.447-.15.799-.5.948-.948l.395-1.183A.75.75 0 0116.5 15z" clip-rule="evenodd"/>
          </svg>
          <h2>Jiranimo</h2>
        </div>
        <button class="jiranimo-about-close" title="Close">&times;</button>
      </div>

      <p class="jiranimo-about-tagline">AI-powered Jira task implementation with Claude Code</p>
      <p class="jiranimo-about-version">Version 1.0.0</p>

      <div class="jiranimo-about-section">
        <h3>How to use</h3>
        <ol>
          <li>Click the <strong>&#x2728; sparkle icon</strong> on any Jira card to queue it for implementation</li>
          <li>Claude Code picks up the task and implements it autonomously</li>
          <li>A draft GitHub PR is created and linked back to the Jira issue</li>
          <li>The card transitions automatically through your board columns</li>
        </ol>
      </div>

      <div class="jiranimo-about-section">
        <h3>Badge states</h3>
        <div class="jiranimo-about-states">
          <div class="jiranimo-about-state"><span class="jiranimo-about-dot idle"></span><span>Ready to implement</span></div>
          <div class="jiranimo-about-state"><span class="jiranimo-about-dot queued"></span><span>Queued</span></div>
          <div class="jiranimo-about-state"><span class="jiranimo-about-dot in-progress"></span><span>Claude Code is working</span></div>
          <div class="jiranimo-about-state"><span class="jiranimo-about-dot completed"></span><span>Done — click to open PR</span></div>
          <div class="jiranimo-about-state"><span class="jiranimo-about-dot failed"></span><span>Failed — click to retry</span></div>
        </div>
      </div>

      <div class="jiranimo-about-section">
        <h3>Keyboard shortcuts</h3>
        <div class="jiranimo-about-shortcut">
          <kbd>&#x2318;E</kbd>
          <span>Open this About panel</span>
        </div>
        <div class="jiranimo-about-shortcut">
          <kbd>Esc</kbd>
          <span>Close this panel</span>
        </div>
      </div>
    `;

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    // Close on backdrop click
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.remove();
    });

    // Close button
    modal.querySelector('.jiranimo-about-close').addEventListener('click', () => {
      overlay.remove();
    });

    // Close on Escape key
    const escHandler = (/** @type {KeyboardEvent} */ e) => {
      if (e.key === 'Escape') {
        overlay.remove();
        document.removeEventListener('keydown', escHandler);
      }
    };
    document.addEventListener('keydown', escHandler);
  },
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { AboutOverlay };
} else if (typeof globalThis !== 'undefined') {
  globalThis.AboutOverlay = AboutOverlay;
}
