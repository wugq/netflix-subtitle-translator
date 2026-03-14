'use strict';

class TranslationSession {
  constructor() {
    this._current = null;
  }

  start() {
    if (this._current) this._current.abort();
    this._current = new AbortController();
    return this._current.signal;
  }

  cancel() {
    if (this._current) { this._current.abort(); this._current = null; }
  }

  get signal() { return this._current ? this._current.signal : null; }
}
