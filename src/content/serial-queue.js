'use strict';

class SerialQueue {
  constructor() {
    this._running = false;
    this._pending = null;
  }

  push(fn) {
    this._pending = { fn };
    if (!this._running) { this._running = true; this._drain(); }
  }

  async _drain() {
    while (this._pending) {
      const { fn } = this._pending; this._pending = null;
      try { await fn(); } catch (e) { console.error('[NST SerialQueue]', e); }
    }
    this._running = false;
  }
}
