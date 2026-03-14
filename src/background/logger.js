'use strict';

class Logger {
  constructor() {
    this._consoleLogging = false;
    this._verboseLogging = false;
    this._appName = 'Netflix Subtitle Translator';
    this._logKey = 'nstLogBuffer';
    this._maxLogItems = 500;
  }

  configure(consoleLogging, verboseLogging) {
    this._consoleLogging = consoleLogging;
    this._verboseLogging = verboseLogging;
  }

  clog(...args) {
    if (this._consoleLogging) console.log(`[${this._appName}]`, ...args);
  }

  vlog(...args) {
    if (!this._verboseLogging) return;
    this._send('background', this._formatArgs(args));
  }

  get verboseLogging() { return this._verboseLogging; }

  _formatArgs(args) {
    return args.map(a => {
      if (typeof a === 'string') return a;
      try { return JSON.stringify(a); } catch (_) { return String(a); }
    }).join(' ');
  }

  async appendLog(source, message) {
    if (!this._verboseLogging) return;
    const line = `${new Date().toISOString()} [${source}] ${message}`;
    const r = await browser.storage.local.get(this._logKey);
    const arr = Array.isArray(r[this._logKey]) ? r[this._logKey] : [];
    arr.push(line.length > 2000 ? line.slice(0, 2000) + '\u2026' : line);
    if (arr.length > this._maxLogItems) arr.splice(0, arr.length - this._maxLogItems);
    await browser.storage.local.set({ [this._logKey]: arr });
  }

  _send(source, message) {
    this.appendLog(source, message);
  }
}
