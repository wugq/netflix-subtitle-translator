// options-controller.js
'use strict';

// Chrome compatibility polyfill
if (typeof browser === 'undefined') {
  var browser = new Proxy(chrome, {
    get(target, prop) {
      const area = target[prop];
      if (!area || typeof area !== 'object') return area;
      return new Proxy(area, {
        get(target, prop) {
          const func = target[prop];
          if (typeof func !== 'function') return func;
          if (prop === 'addListener' || prop === 'removeListener' || prop === 'hasListener') {
            return func.bind(target);
          }
          return (...args) => new Promise((resolve, reject) => {
            func.call(target, ...args, (result) => {
              if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
              else resolve(result);
            });
          });
        }
      });
    }
  });
}

class OptionsController {
  constructor() {
    this._LOG_KEY = 'nstLogBuffer';

    this._apiKeyInput = document.getElementById('apiKey');
    this._saveBtn     = document.getElementById('saveBtn');
    this._testBtn     = document.getElementById('testBtn');
    this._statusEl    = document.getElementById('status');

    this._consoleLoggingCheckbox = document.getElementById('consoleLogging');
    this._verboseLoggingCheckbox = document.getElementById('verboseLogging');

    this._logOutput     = document.getElementById('logOutput');
    this._logCount      = document.getElementById('logCount');
    this._copyLogsBtn   = document.getElementById('copyLogs');
    this._clearLogsBtn  = document.getElementById('clearLogs');
    this._refreshLogsBtn = document.getElementById('refreshLogs');

    this._bindEvents();
    this._loadLogs();

    // Load saved API key
    browser.storage.local.get('openaiApiKey').then(result => {
      if (result.openaiApiKey) this._apiKeyInput.value = result.openaiApiKey;
    });

    // Load logging toggles
    browser.storage.local.get(['consoleLogging', 'verboseLogging']).then(r => {
      this._consoleLoggingCheckbox.checked = r.consoleLogging || false;
      this._verboseLoggingCheckbox.checked = r.verboseLogging || false;
    });

    browser.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes[this._LOG_KEY]) {
        this._renderLogs(changes[this._LOG_KEY].newValue);
      }
    });
  }

  _bindEvents() {
    this._consoleLoggingCheckbox.addEventListener('change', () => {
      browser.storage.local.set({ consoleLogging: this._consoleLoggingCheckbox.checked });
    });
    this._verboseLoggingCheckbox.addEventListener('change', () => {
      browser.storage.local.set({ verboseLogging: this._verboseLoggingCheckbox.checked });
    });

    this._copyLogsBtn.addEventListener('click', async () => {
      const text = this._logOutput.value || '';
      if (!text) { this._showStatus('No logs to copy.', 'info'); return; }
      try {
        await navigator.clipboard.writeText(text);
        this._showStatus('Logs copied to clipboard.', 'success');
      } catch (err) {
        this._showStatus(`Copy failed: ${err.message}`, 'error');
      }
    });

    this._clearLogsBtn.addEventListener('click', async () => {
      await browser.storage.local.set({ [this._LOG_KEY]: [] });
      this._renderLogs([]);
      this._showStatus('Logs cleared.', 'success');
    });

    this._refreshLogsBtn.addEventListener('click', () => this._loadLogs());

    this._saveBtn.addEventListener('click', async () => {
      const key = this._apiKeyInput.value.trim();
      if (!key) { this._showStatus('Please enter an API key.', 'error'); return; }
      if (!key.startsWith('sk-')) {
        this._showStatus('API key must start with "sk-". Please check your key.', 'error');
        return;
      }
      await browser.storage.local.set({ openaiApiKey: key });
      this._showStatus('API key saved successfully.', 'success');
    });

    this._testBtn.addEventListener('click', async () => {
      const key = this._apiKeyInput.value.trim();
      if (!key) { this._showStatus('Please enter an API key first.', 'error'); return; }
      if (!key.startsWith('sk-')) {
        this._showStatus('API key must start with "sk-".', 'error');
        return;
      }

      this._showStatus('Testing API key...', 'info');
      this._testBtn.disabled = true;

      try {
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
          body: JSON.stringify({
            model: 'gpt-4o-mini',
            temperature: 0,
            max_tokens: 10,
            messages: [{ role: 'user', content: 'Reply with the word OK.' }],
          }),
        });

        if (response.ok) {
          this._showStatus('API key is valid and working.', 'success');
        } else {
          const body = await response.json().catch(() => ({}));
          const msg = body.error?.message || `HTTP ${response.status}`;
          this._showStatus(`API key test failed: ${msg}`, 'error');
        }
      } catch (err) {
        this._showStatus(`Network error: ${err.message}`, 'error');
      } finally {
        this._testBtn.disabled = false;
      }
    });
  }

  async _loadLogs() {
    const r = await browser.storage.local.get(this._LOG_KEY);
    this._renderLogs(r[this._LOG_KEY]);
  }

  _renderLogs(lines) {
    const arr = Array.isArray(lines) ? lines : [];
    this._logOutput.value = arr.join('\n');
    this._logCount.textContent = arr.length ? `Log entries: ${arr.length}` : 'No logs yet.';
  }

  _showStatus(message, type) {
    this._statusEl.textContent = message;
    this._statusEl.className = `status ${type}`;
    this._statusEl.classList.remove('hidden');
    if (type === 'success' || type === 'info') {
      setTimeout(() => this._statusEl.classList.add('hidden'), 4000);
    }
  }
}

new OptionsController();
