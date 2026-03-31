/**
 * About overlay for Jiranimo.
 * Displayed on the board screen when the user presses Cmd+E (Mac) / Ctrl+E (Win/Linux).
 */

// @ts-check

const AboutOverlay = {
  /** @type {HTMLElement|null} */
  _overlay: null,

  show() {
    if (this._overlay) return; // already visible

    const overlay = document.createElement('div');
    overlay.className = 'jiranimo-about-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'About Jiranimo');

    const modal = document.createElement('div');
    modal.className = 'jiranimo-about-modal';

    modal.innerHTML = `
      <div class="jiranimo-about-logo">✨</div>
      <h2 class="jiranimo-about-title">Jiranimo</h2>
      <p class="jiranimo-about-subtitle">AI-powered Jira task implementation</p>
      <div class="jiranimo-about-divider"></div>
      <p class="jiranimo-about-description">
        Jiranimo connects your Jira sprint board to Claude Code.
        Click the sparkle icon on any card to have Claude automatically
        implement the task, open a pull request, and update the ticket.
      </p>
      <div class="jiranimo-about-shortcuts">
        <div class="jiranimo-about-shortcut-row">
          <kbd>✨</kbd><span>Click a card badge to implement with AI</span>
        </div>
        <div class="jiranimo-about-shortcut-row">
          <kbd>⌘E</kbd><span>Show this about panel</span>
        </div>
        <div class="jiranimo-about-shortcut-row">
          <kbd>Esc</kbd><span>Close this panel</span>
        </div>
      </div>
      <button class="jiranimo-about-close" aria-label="Close">Close</button>
    `;

    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    this._overlay = overlay;

    // Focus the close button for accessibility
    const closeBtn = modal.querySelector('.jiranimo-about-close');
    if (closeBtn) closeBtn.focus();

    // Close on backdrop click
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) this.hide();
    });

    // Close button
    closeBtn.addEventListener('click', () => this.hide());
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
