'use strict';

class Logger {
  constructor() {
    this._consoleLogging = false;
    this._verboseLogging = false;
    this._appName = 'Netflix Subtitle Translator';
  }

  configure(consoleLogging, verboseLogging) {
    this._consoleLogging = consoleLogging;
    this._verboseLogging = verboseLogging;
  }

  clog(...args) {
    if (this._consoleLogging) console.log(`[${this._appName}]`, ...args);
  }

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
