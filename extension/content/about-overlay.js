/**
 * Jiranimo About overlay.
 * Shows an informational overlay when the user presses Cmd+E on the board.
 */

// @ts-check

const AboutOverlay = {
  /** @type {HTMLElement|null} */
  _overlay: null,

  show() {
    if (this._overlay) return; // already open

    const overlay = document.createElement('div');
    overlay.className = 'jiranimo-about-overlay';

    const modal = document.createElement('div');
    modal.className = 'jiranimo-about-modal';

    modal.innerHTML = `
      <div class="jiranimo-about-header">
        <span class="jiranimo-about-logo">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" width="32" height="32">
            <path fill-rule="evenodd" d="M9 4.5a.75.75 0 01.721.544l.813 2.846a3.75 3.75 0 002.576 2.576l2.846.813a.75.75 0 010 1.442l-2.846.813a3.75 3.75 0 00-2.576 2.576l-.813 2.846a.75.75 0 01-1.442 0l-.813-2.846a3.75 3.75 0 00-2.576-2.576l-2.846-.813a.75.75 0 010-1.442l2.846-.813A3.75 3.75 0 007.466 7.89l.813-2.846A.75.75 0 019 4.5zM18 1.5a.75.75 0 01.728.568l.258 1.036c.236.94.97 1.674 1.91 1.91l1.036.258a.75.75 0 010 1.456l-1.036.258c-.94.236-1.674.97-1.91 1.91l-.258 1.036a.75.75 0 01-1.456 0l-.258-1.036a2.625 2.625 0 00-1.91-1.91l-1.036-.258a.75.75 0 010-1.456l1.036-.258a2.625 2.625 0 001.91-1.91l.258-1.036A.75.75 0 0118 1.5zM16.5 15a.75.75 0 01.712.513l.394 1.183c.15.447.5.799.948.948l1.183.395a.75.75 0 010 1.422l-1.183.395c-.447.15-.799.5-.948.948l-.395 1.183a.75.75 0 01-1.422 0l-.395-1.183a1.5 1.5 0 00-.948-.948l-1.183-.395a.75.75 0 010-1.422l1.183-.395c.447-.15.799-.5.948-.948l.395-1.183A.75.75 0 0116.5 15z" clip-rule="evenodd"/>
          </svg>
        </span>
        <div>
          <h2 class="jiranimo-about-title">Jiranimo</h2>
          <p class="jiranimo-about-version">v1.0.0</p>
        </div>
        <button class="jiranimo-about-close" aria-label="Close">✕</button>
      </div>

      <p class="jiranimo-about-tagline">AI-powered Jira task implementation via Claude Code</p>

      <div class="jiranimo-about-section">
        <h3>How it works</h3>
        <ol>
          <li>Click the <strong>✦ sparkle icon</strong> on any task card to queue it for implementation.</li>
          <li>Jiranimo sends the task to a local server that runs <strong>Claude Code</strong> to implement it.</li>
          <li>When done, a draft PR is automatically created and the card moves to <em>In Review</em>.</li>
        </ol>
      </div>

      <div class="jiranimo-about-section">
        <h3>Badge states</h3>
        <ul class="jiranimo-about-states">
          <li><span class="jiranimo-about-dot idle"></span><span><strong>Idle</strong> — ready to implement</span></li>
          <li><span class="jiranimo-about-dot queued"></span><span><strong>Queued</strong> — waiting for an available slot</span></li>
          <li><span class="jiranimo-about-dot in-progress"></span><span><strong>Running</strong> — Claude Code is implementing</span></li>
          <li><span class="jiranimo-about-dot completed"></span><span><strong>Done</strong> — PR created, click to open</span></li>
          <li><span class="jiranimo-about-dot failed"></span><span><strong>Failed</strong> — click to retry</span></li>
        </ul>
      </div>

      <div class="jiranimo-about-section">
        <h3>Keyboard shortcuts</h3>
        <ul class="jiranimo-about-shortcuts">
          <li><kbd>⌘ E</kbd> Toggle this overlay</li>
        </ul>
      </div>

      <p class="jiranimo-about-footer">
        Built with ♥ using <a href="https://www.anthropic.com/claude" target="_blank" rel="noopener noreferrer">Claude</a>
      </p>
    `;

    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    this._overlay = overlay;

    // Close on backdrop click
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) this.hide();
    });

    // Close button
    modal.querySelector('.jiranimo-about-close').addEventListener('click', () => this.hide());
  },

  hide() {
    if (this._overlay) {
      this._overlay.remove();
      this._overlay = null;
    }
  },

  toggle() {
    if (this._overlay) {
      this.hide();
    } else {
      this.show();
    }
  },
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { AboutOverlay };
} else if (typeof globalThis !== 'undefined') {
  globalThis.AboutOverlay = AboutOverlay;
}
