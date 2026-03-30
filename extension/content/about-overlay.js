/**
 * Jiranimo About Overlay.
 * Shown on the board screen when the user presses Cmd+E.
 */

// @ts-check

const AboutOverlay = {
  /** @type {HTMLElement|null} */
  _overlay: null,

  /**
   * Show the about overlay. If already visible, hide it (toggle).
   */
  toggle() {
    if (this._overlay) {
      this.hide();
    } else {
      this.show();
    }
  },

  show() {
    if (this._overlay) return;

    const overlay = document.createElement('div');
    overlay.className = 'jiranimo-about-overlay';

    const modal = document.createElement('div');
    modal.className = 'jiranimo-about-modal';
    modal.innerHTML = `
      <div class="jiranimo-about-header">
        <span class="jiranimo-about-logo">✦</span>
        <h2>Jiranimo</h2>
        <span class="jiranimo-about-version">v1.0.0</span>
      </div>
      <p class="jiranimo-about-tagline">Implement Jira tasks with Claude Code — automatically.</p>
      <div class="jiranimo-about-section">
        <h3>How it works</h3>
        <ul>
          <li>Click the <strong>✦</strong> sparkle badge next to any issue to queue it for implementation</li>
          <li>Jiranimo sends the task to Claude Code running locally</li>
          <li>Claude creates a branch, writes the code, and opens a pull request</li>
          <li>The badge turns green when complete — click it to open the PR</li>
        </ul>
      </div>
      <div class="jiranimo-about-section">
        <h3>Keyboard shortcuts</h3>
        <table class="jiranimo-about-shortcuts">
          <tr><td><kbd>⌘E</kbd></td><td>Toggle this About overlay</td></tr>
          <tr><td><kbd>Esc</kbd></td><td>Close this overlay</td></tr>
        </table>
      </div>
      <div class="jiranimo-about-section">
        <h3>Setup</h3>
        <p>Make sure the Jiranimo server is running locally on <code>http://localhost:3456</code>. Visit the extension <a href="#" id="jiranimo-about-options">Options</a> page to configure the server URL.</p>
      </div>
      <button class="jiranimo-about-close" aria-label="Close">✕</button>
    `;

    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    this._overlay = overlay;

    // Close on overlay backdrop click
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) this.hide();
    });

    // Close button
    modal.querySelector('.jiranimo-about-close').addEventListener('click', () => this.hide());

    // Options link opens extension options page
    modal.querySelector('#jiranimo-about-options').addEventListener('click', (e) => {
      e.preventDefault();
      if (typeof chrome !== 'undefined' && chrome.runtime) {
        chrome.runtime.sendMessage({ type: 'open-options' });
      }
    });

    // Animate in
    requestAnimationFrame(() => overlay.classList.add('jiranimo-about-visible'));
  },

  hide() {
    if (!this._overlay) return;
    const overlay = this._overlay;
    this._overlay = null;
    overlay.classList.remove('jiranimo-about-visible');
    // Remove after transition
    overlay.addEventListener('transitionend', () => overlay.remove(), { once: true });
    // Fallback removal
    setTimeout(() => overlay.remove(), 350);
  },

  /**
   * Register the Cmd+E keyboard shortcut.
   * Call once during content script initialization.
   */
  registerShortcut() {
    document.addEventListener('keydown', (e) => {
      // Cmd+E (Mac) or Ctrl+E (other platforms)
      if ((e.metaKey || e.ctrlKey) && e.key === 'e') {
        // Don't trigger when typing in an input/textarea/contenteditable
        const tag = /** @type {HTMLElement} */ (e.target).tagName;
        const isEditable = /** @type {HTMLElement} */ (e.target).isContentEditable;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || isEditable) return;

        e.preventDefault();
        AboutOverlay.toggle();
      }

      // Esc closes the overlay
      if (e.key === 'Escape' && AboutOverlay._overlay) {
        AboutOverlay.hide();
      }
    });
  },
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { AboutOverlay };
} else if (typeof globalThis !== 'undefined') {
  globalThis.AboutOverlay = AboutOverlay;
}
