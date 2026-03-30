import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Stub browser globals not available in jsdom
global.chrome = {
  runtime: {
    sendMessage: vi.fn(),
  },
};

const { AboutOverlay } = require('./about-overlay.js');

describe('AboutOverlay', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    AboutOverlay._overlay = null;
  });

  afterEach(() => {
    // Clean up any overlays left in DOM
    document.querySelectorAll('.jiranimo-about-overlay').forEach(el => el.remove());
    AboutOverlay._overlay = null;
  });

  describe('show()', () => {
    it('appends overlay to document body', () => {
      AboutOverlay.show();
      expect(document.querySelector('.jiranimo-about-overlay')).not.toBeNull();
    });

    it('contains the modal element', () => {
      AboutOverlay.show();
      expect(document.querySelector('.jiranimo-about-modal')).not.toBeNull();
    });

    it('sets _overlay reference', () => {
      AboutOverlay.show();
      expect(AboutOverlay._overlay).not.toBeNull();
    });

    it('does nothing if already visible', () => {
      AboutOverlay.show();
      AboutOverlay.show();
      expect(document.querySelectorAll('.jiranimo-about-overlay').length).toBe(1);
    });
  });

  describe('hide()', () => {
    it('clears _overlay reference immediately', () => {
      AboutOverlay.show();
      AboutOverlay.hide();
      expect(AboutOverlay._overlay).toBeNull();
    });

    it('does nothing when not visible', () => {
      expect(() => AboutOverlay.hide()).not.toThrow();
    });
  });

  describe('toggle()', () => {
    it('shows overlay when hidden', () => {
      AboutOverlay.toggle();
      expect(document.querySelector('.jiranimo-about-overlay')).not.toBeNull();
    });

    it('hides overlay when shown', () => {
      AboutOverlay.show();
      AboutOverlay.toggle();
      expect(AboutOverlay._overlay).toBeNull();
    });
  });

  describe('registerShortcut()', () => {
    it('registers a keydown listener that toggles on Cmd+E', () => {
      AboutOverlay.registerShortcut();

      const event = new KeyboardEvent('keydown', { key: 'e', metaKey: true, bubbles: true });
      document.dispatchEvent(event);

      expect(AboutOverlay._overlay).not.toBeNull();
    });

    it('does not toggle when typing in an input', () => {
      AboutOverlay.registerShortcut();

      const input = document.createElement('input');
      document.body.appendChild(input);

      const event = new KeyboardEvent('keydown', { key: 'e', metaKey: true, bubbles: true });
      Object.defineProperty(event, 'target', { value: input });
      document.dispatchEvent(event);

      // Overlay should NOT have been shown
      expect(AboutOverlay._overlay).toBeNull();
    });

    it('closes overlay on Escape', () => {
      AboutOverlay.show();
      AboutOverlay.registerShortcut();

      const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
      document.dispatchEvent(event);

      expect(AboutOverlay._overlay).toBeNull();
    });
  });
});
