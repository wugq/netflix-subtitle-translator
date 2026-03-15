'use strict';

class Logger {
  constructor() {
    this._verboseLogging = false;
    this._appName = 'Netflix Subtitle Translator';
  }

  configure(verboseLogging) {
    this._verboseLogging = verboseLogging;
  }

  clog() {}

  vlog(...args) {
    if (this._verboseLogging) this._send(this._formatArgs(args));
  }

  get verboseLogging() { return this._verboseLogging; }

  _formatArgs(args) {
    return args.map(a => {
      if (typeof a === 'string') return a;
      try { return JSON.stringify(a); } catch (_) { return String(a); }
    }).join(' ');
  }

  _send(message) {
    try {
      browser.runtime.sendMessage({ type: 'log', source: 'content', message });
    } catch (_) {}
  }
}
