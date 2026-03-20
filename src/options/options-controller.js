// options-controller.js
'use strict';

const PROVIDER_CONFIGS = {
  openai: {
    label:   'OpenAI',
    baseUrl: '',
    models:  ['gpt-4o-mini'],
  },
  xai: {
    label:   'xAI',
    baseUrl: 'https://api.x.ai/v1',
    models:  ['grok-3-mini'],
  },
};

function detectProvider(baseUrl) {
  const url = (baseUrl || '').trim().replace(/\/$/, '');
  if (url === PROVIDER_CONFIGS.xai.baseUrl) return 'xai';
  return 'openai';
}

class OptionsController {
  constructor() {
    this._LOG_KEY = 'nstLogBuffer';

    this._apiKeyInput    = document.getElementById('apiKey');
    this._providerSelect = document.getElementById('aiProvider');
    this._aiModelSelect  = document.getElementById('aiModel');
    this._saveBtn        = document.getElementById('saveBtn');
    this._testBtn         = document.getElementById('testBtn');
    this._statusEl        = document.getElementById('status');

    this._clearCacheBtn  = document.getElementById('clearCacheBtn');
    this._cacheStatusEl  = document.getElementById('cacheStatus');

    this._verboseLoggingCheckbox = document.getElementById('verboseLogging');

    this._logOutput     = document.getElementById('logOutput');
    this._logCount      = document.getElementById('logCount');
    this._logStatusEl   = document.getElementById('logStatus');
    this._copyLogsBtn   = document.getElementById('copyLogs');
    this._clearLogsBtn  = document.getElementById('clearLogs');
    this._refreshLogsBtn = document.getElementById('refreshLogs');

    this._bindEvents();
    this._loadLogs();

    browser.storage.local.get(['openaiApiKey', 'aiModel', 'aiBaseUrl', 'verboseLogging']).then(r => {
      if (r.openaiApiKey) this._apiKeyInput.value = r.openaiApiKey;
      this._setProvider(detectProvider(r.aiBaseUrl), r.aiModel);
      this._verboseLoggingCheckbox.checked = r.verboseLogging || false;
    });

    browser.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes[this._LOG_KEY]) {
        this._renderLogs(changes[this._LOG_KEY].newValue);
      }
    });
  }

  _populateModels(providerKey, currentModel) {
    const cfg = PROVIDER_CONFIGS[providerKey];
    this._aiModelSelect.innerHTML = '';
    cfg.models.forEach(m => {
      const opt = document.createElement('option');
      opt.value = m; opt.textContent = m;
      this._aiModelSelect.appendChild(opt);
    });
    if (currentModel && cfg.models.includes(currentModel)) {
      this._aiModelSelect.value = currentModel;
    }
  }

  _setProvider(providerKey, currentModel) {
    this._providerSelect.value = providerKey;
    this._populateModels(providerKey, currentModel);
  }

  _getSelectedModel() {
    return this._aiModelSelect.value;
  }

  _bindEvents() {
    this._clearCacheBtn.addEventListener('click', async () => {
      this._clearCacheBtn.disabled = true;
      try {
        await browser.runtime.sendMessage({ type: 'clearCache' });
        this._showCacheStatus('Translation cache cleared.', 'success');
      } catch (err) {
        this._showCacheStatus('Failed to clear cache: ' + err.message, 'error');
      } finally {
        this._clearCacheBtn.disabled = false;
      }
    });

    this._providerSelect.addEventListener('change', () => {
      this._setProvider(this._providerSelect.value, null);
    });

    this._verboseLoggingCheckbox.addEventListener('change', () => {
      browser.storage.local.set({ verboseLogging: this._verboseLoggingCheckbox.checked });
    });

    this._copyLogsBtn.addEventListener('click', async () => {
      const text = this._logOutput.value || '';
      if (!text) { this._showLogStatus('No logs to copy.', 'info'); return; }
      try {
        await navigator.clipboard.writeText(text);
        this._showLogStatus('Logs copied to clipboard.', 'success');
      } catch (err) {
        this._showLogStatus(`Copy failed: ${err.message}`, 'error');
      }
    });

    this._clearLogsBtn.addEventListener('click', async () => {
      await browser.storage.local.set({ [this._LOG_KEY]: [] });
      this._renderLogs([]);
      this._showLogStatus('Logs cleared.', 'success');
    });

    this._refreshLogsBtn.addEventListener('click', () => this._loadLogs());

    this._saveBtn.addEventListener('click', async () => {
      const key = this._apiKeyInput.value.trim();
      const providerKey = this._providerSelect.value;
      const model = this._getSelectedModel();
      const baseUrl = PROVIDER_CONFIGS[providerKey].baseUrl;
      if (!key) { this._showStatus('Please enter an API key.', 'error'); return; }
      await browser.storage.local.set({ openaiApiKey: key, aiModel: model, aiBaseUrl: baseUrl });
      this._showStatus('Settings saved successfully.', 'success');
    });

    this._testBtn.addEventListener('click', async () => {
      const key = this._apiKeyInput.value.trim();
      const providerKey = this._providerSelect.value;
      const model = this._getSelectedModel();
      const rawBaseUrl = PROVIDER_CONFIGS[providerKey].baseUrl || 'https://api.openai.com/v1';

      this._showStatus('Testing connection...', 'info');
      this._testBtn.disabled = true;

      try {
        const response = await fetch(`${rawBaseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
          body: JSON.stringify({
            model,
            temperature: 0,
            max_tokens: 10,
            messages: [{ role: 'user', content: 'Reply with the word OK.' }],
          }),
        });

        if (response.ok) {
          this._showStatus('Connection successful — provider is working.', 'success');
        } else {
          const body = await response.json().catch(() => ({}));
          const msg = body.error?.message || `HTTP ${response.status}`;
          this._showStatus(`Test failed: ${msg}`, 'error');
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

  _showCacheStatus(message, type) {
    this._cacheStatusEl.textContent = message;
    this._cacheStatusEl.className = `status ${type}`;
    this._cacheStatusEl.classList.remove('hidden');
    if (type === 'success' || type === 'info') {
      setTimeout(() => this._cacheStatusEl.classList.add('hidden'), 4000);
    }
  }

  _showLogStatus(message, type) {
    this._logStatusEl.textContent = message;
    this._logStatusEl.className = `status ${type}`;
    this._logStatusEl.classList.remove('hidden');
    if (type === 'success' || type === 'info') {
      setTimeout(() => this._logStatusEl.classList.add('hidden'), 4000);
    }
  }
}

new OptionsController();
