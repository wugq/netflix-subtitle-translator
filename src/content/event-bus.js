'use strict';

class EventBus {
  constructor() {
    this._listeners = Object.create(null);
  }

  on(event, fn) {
    (this._listeners[event] || (this._listeners[event] = [])).push(fn);
  }

  off(event, fn) {
    if (this._listeners[event]) {
      this._listeners[event] = this._listeners[event].filter(f => f !== fn);
    }
  }

  emit(event, payload) {
    const fns = this._listeners[event];
    if (fns) {
      for (const fn of fns.slice()) {
        try { fn(payload); } catch (e) { console.error('[NST]', e); }
      }
    }
  }
}
