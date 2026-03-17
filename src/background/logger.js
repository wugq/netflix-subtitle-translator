'use strict';

class Logger {
  constructor() {
    this._verboseLogging = false;
    this._appName = 'Netflix Subtitle Translator';
    this._logKey = 'nstLogBuffer';
    this._maxLogItems = 500;
  }

  configure(verboseLogging) {
    this._verboseLogging = verboseLogging;
  }

  init() {
    browser.storage.local.get('verboseLogging').then(r => {
      this.configure(r.verboseLogging || false);
    });
    browser.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes.verboseLogging) return;
      this.configure(changes.verboseLogging.newValue);
    });
  }

  clog() {}

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
    // Skip consecutive duplicate messages (same source + text, ignoring timestamp).
    if (arr.length > 0) {
      const prev = arr[arr.length - 1];
      const prevMsg = prev.slice(prev.indexOf('] ') + 2);
      if (prevMsg === message && prev.includes(`[${source}]`)) return;
    }
    arr.push(line.length > 2000 ? line.slice(0, 2000) + '\u2026' : line);
    if (arr.length > this._maxLogItems) arr.splice(0, arr.length - this._maxLogItems);
    await browser.storage.local.set({ [this._logKey]: arr });
  }

  _send(source, message) {
    this.appendLog(source, message);
  }
}
