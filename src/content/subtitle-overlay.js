'use strict';

const SUBTITLE_STYLES = {
  classic: {
    background:  'rgba(0,0,0,0.75)',
    color:       '#fff',
    textShadow:  'none',
    borderRadius: '3px',
    padding:     '4px 12px 6px',
  },
  shadow: {
    background:  'transparent',
    color:       '#fff',
    textShadow:  '0 1px 6px #000, 0 0 24px rgba(0,0,0,0.95)',
    borderRadius: '0',
    padding:     '4px 12px 6px',
  },
  yellow: {
    background:  'transparent',
    color:       '#ffef00',
    textShadow:  '0 1px 4px #000, 0 0 16px rgba(0,0,0,0.9)',
    borderRadius: '0',
    padding:     '4px 12px 6px',
  },
};

class SubtitleOverlay {
  constructor() {
    this._overlayEl          = null;
    this._flashEl            = null;
    this._flashTimeout       = null;
    this._fullscreenHandler  = null;
    this._fontSize           = 24;
    this._bottomPct          = 8;
    this._style              = 'classic';
  }

  ensure() {
    if (this._overlayEl) return;
    this._hideNetflixSubtitles();

    this._overlayEl = document.createElement('div');
    this._overlayEl.id = 'nst-overlay';
    this._overlayEl.style.cssText = `
      position: fixed;
      left: 0;
      width: 100%;
      bottom: ${this._bottomPct}%;
      z-index: 2147483647;
      pointer-events: none;
      text-align: center;
    `;
    document.body.appendChild(this._overlayEl);

    this._fullscreenHandler = () => {
      const target = document.fullscreenElement || document.body;
      target.appendChild(this._overlayEl);
      if (this._flashEl) target.appendChild(this._flashEl);
    };
    document.addEventListener('fullscreenchange', this._fullscreenHandler);
  }

  render(text) {
    if (!this._overlayEl) return;
    this._overlayEl.textContent = '';
    if (!text) return;
    const s = SUBTITLE_STYLES[this._style] || SUBTITLE_STYLES.classic;
    const div = document.createElement('div');
    div.style.cssText =
      `display:inline-block;background:${s.background};color:${s.color};` +
      `text-shadow:${s.textShadow};` +
      `font-size:${this._fontSize || 24}px;font-family:'Netflix Sans',Arial,sans-serif;` +
      `font-weight:500;line-height:1.5;padding:${s.padding};` +
      `border-radius:${s.borderRadius};white-space:pre-wrap;max-width:90vw;`;
    text.split('\n').forEach((line, i) => {
      if (i > 0) div.appendChild(document.createElement('br'));
      div.appendChild(document.createTextNode(line));
    });
    this._overlayEl.appendChild(div);
  }

  applyStyle(fontSize, bottomPct, style) {
    this._fontSize = fontSize;
    this._bottomPct = bottomPct;
    if (style) this._style = style;
    if (!this._overlayEl) return;
    this._overlayEl.style.bottom = bottomPct + '%';
    const inner = this._overlayEl.querySelector('div');
    if (inner) {
      const s = SUBTITLE_STYLES[this._style] || SUBTITLE_STYLES.classic;
      inner.style.fontSize     = fontSize + 'px';
      inner.style.background   = s.background;
      inner.style.textShadow   = s.textShadow;
      inner.style.borderRadius = s.borderRadius;
      inner.style.padding      = s.padding;
    }
  }

  showFlash(message) {
    if (!this._flashEl) {
      this._flashEl = document.createElement('div');
      this._flashEl.id = 'nst-flash';
      this._flashEl.style.cssText = `
        position: fixed;
        top: 10%;
        left: 50%;
        transform: translateX(-50%);
        z-index: 2147483647;
        background: rgba(0,0,0,0.82);
        color: #ffcc80;
        font-family: 'Netflix Sans', Arial, sans-serif;
        font-size: 14px;
        font-weight: 500;
        padding: 8px 18px;
        border-radius: 6px;
        pointer-events: none;
        text-align: center;
        max-width: 70vw;
        transition: opacity 0.4s;
      `;
      document.body.appendChild(this._flashEl);
    }
    this._flashEl.textContent = message;
    this._flashEl.style.opacity = '1';

    clearTimeout(this._flashTimeout);
    this._flashTimeout = setTimeout(() => {
      this._flashEl.style.opacity = '0';
    }, 4000);
  }

  destroy() {
    if (this._fullscreenHandler) {
      document.removeEventListener('fullscreenchange', this._fullscreenHandler);
      this._fullscreenHandler = null;
    }
    if (this._overlayEl) { this._overlayEl.remove(); this._overlayEl = null; }
    if (this._flashEl)   { this._flashEl.remove();   this._flashEl   = null; }
    clearTimeout(this._flashTimeout);
  }

  _hideNetflixSubtitles() {
    if (document.getElementById('nst-hide-style')) return;
    const el = document.createElement('style');
    el.id = 'nst-hide-style';
    el.textContent = '.player-timedtext { visibility: hidden !important; }';
    document.head.appendChild(el);
  }
}
