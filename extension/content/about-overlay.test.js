// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
const { AboutOverlay } = require('./about-overlay.js');

describe('AboutOverlay', () => {
  beforeEach(() => {
    // Ensure clean DOM state
    AboutOverlay._overlay = null;
    document.body.innerHTML = '';
  });

  afterEach(() => {
    AboutOverlay.hide();
  });

  it('show() appends overlay to document.body', () => {
    AboutOverlay.show();
    expect(document.querySelector('.jiranimo-about-overlay')).not.toBeNull();
  });

  it('show() sets _overlay reference', () => {
    AboutOverlay.show();
    expect(AboutOverlay._overlay).not.toBeNull();
  });

  it('show() does not create duplicate overlays', () => {
    AboutOverlay.show();
    AboutOverlay.show();
    expect(document.querySelectorAll('.jiranimo-about-overlay').length).toBe(1);
  });

  it('hide() removes overlay from DOM', () => {
    AboutOverlay.show();
    AboutOverlay.hide();
    expect(document.querySelector('.jiranimo-about-overlay')).toBeNull();
  });

  it('hide() clears _overlay reference', () => {
    AboutOverlay.show();
    AboutOverlay.hide();
    expect(AboutOverlay._overlay).toBeNull();
  });

  it('hide() is safe to call when not visible', () => {
    expect(() => AboutOverlay.hide()).not.toThrow();
  });

  it('toggle() shows when hidden', () => {
    AboutOverlay.toggle();
    expect(document.querySelector('.jiranimo-about-overlay')).not.toBeNull();
  });

  it('toggle() hides when visible', () => {
    AboutOverlay.show();
    AboutOverlay.toggle();
    expect(document.querySelector('.jiranimo-about-overlay')).toBeNull();
  });

  it('overlay contains title and close button', () => {
    AboutOverlay.show();
    expect(document.querySelector('.jiranimo-about-title').textContent.trim()).toBe('Jiranimo');
    expect(document.querySelector('.jiranimo-about-close')).not.toBeNull();
  });

  it('clicking close button hides the overlay', () => {
    AboutOverlay.show();
    document.querySelector('.jiranimo-about-close').click();
    expect(document.querySelector('.jiranimo-about-overlay')).toBeNull();
  });

  it('clicking backdrop hides the overlay', () => {
    AboutOverlay.show();
    const overlay = document.querySelector('.jiranimo-about-overlay');
    overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    // Simulate the target === overlay check
    const event = new MouseEvent('click', { bubbles: false });
    Object.defineProperty(event, 'target', { value: overlay });
    overlay.dispatchEvent(event);
    expect(AboutOverlay._overlay).toBeNull();
  });
});
