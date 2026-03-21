// options-controller.js
'use strict';

// Prices are indicative as of 2026-03 — check the provider's official pricing page before use.
const PROVIDER_CONFIGS = {
  openai: {
    label:   'OpenAI',
    baseUrl: '',
    pricingUrl: 'https://openai.com/api/pricing',
    models: [
      { id: 'gpt-4.1-nano', desc: 'Default — ultra-cheap, proven generation, good translation quality',          price: '$0.10 / $0.40 per 1M tokens' },
      { id: 'gpt-5-nano',   desc: 'Cheapest available — newer generation, worth testing',                        price: '$0.05 / $0.40 per 1M tokens' },
      { id: 'gpt-5-mini',   desc: 'Mid-tier newer generation — better quality than nano at modest cost',         price: '$0.25 / $2.00 per 1M tokens' },
      { id: 'gpt-5.4-nano', desc: 'Latest ultra-lightweight variant from the 5.4 flagship family',              price: '$0.20 / $1.25 per 1M tokens' },
      { id: 'gpt-4o-mini',  desc: 'Fast & affordable — well-tested, reliable for subtitle translation',          price: '$0.15 / $0.60 per 1M tokens' },
      { id: 'gpt-4.1-mini', desc: 'Newer efficient model — better instruction following than gpt-4o-mini',       price: '$0.40 / $1.60 per 1M tokens' },
      { id: 'gpt-4.1',      desc: 'High quality — best choice if translation accuracy matters most',             price: '$2.00 / $8.00 per 1M tokens' },
    ],
  },
  xai: {
    label:   'xAI',
    baseUrl: 'https://api.x.ai/v1',
    pricingUrl: 'https://docs.x.ai/developers/models',
    models: [
      { id: 'grok-4-1-fast-non-reasoning', desc: 'Default — fast and cheapest, great for subtitle translation', price: '$0.20 / $0.50 per 1M tokens' },
      { id: 'grok-4.20-non-reasoning',     desc: 'Latest flagship — higher quality, use if fast model falls short', price: '$2.00 / $6.00 per 1M tokens' },
    ],
  },
};

function detectProvider(baseUrl) {
  const url = (baseUrl || '').trim().replace(/\/$/, '');
  if (url === PROVIDER_CONFIGS.xai.baseUrl) return 'xai';
  return 'openai';
}

class OptionsController {
  constructor() {
    this._LOG_KEY       = 'nstLogBuffer';
    this._TRANS_LOG_KEY = 'nstTranslationLog';

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

    this._modelTableEl = document.getElementById('modelTable');
    this._transLogEnabledCheckbox = document.getElementById('transLogEnabled');
    this._transLogOutput  = document.getElementById('transLogOutput');
    this._transLogCount   = document.getElementById('transLogCount');
    this._transLogStatus  = document.getElementById('transLogStatus');
    this._copyTransLogBtn  = document.getElementById('copyTransLog');
    this._clearTransLogBtn = document.getElementById('clearTransLog');
    this._refreshTransLogBtn = document.getElementById('refreshTransLog');

    this._bindEvents();
    this._loadLogs();
    this._loadTransLog();

    browser.storage.local.get(['openaiApiKey', 'aiModel', 'aiBaseUrl', 'verboseLogging', 'transLogEnabled']).then(r => {
      if (r.openaiApiKey) this._apiKeyInput.value = r.openaiApiKey;
      this._setProvider(detectProvider(r.aiBaseUrl), r.aiModel);
      this._verboseLoggingCheckbox.checked = r.verboseLogging || false;
      this._transLogEnabledCheckbox.checked = r.transLogEnabled || false;
    });

    browser.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes[this._LOG_KEY]) this._renderLogs(changes[this._LOG_KEY].newValue);
      if (changes[this._TRANS_LOG_KEY]) this._renderTransLog(changes[this._TRANS_LOG_KEY].newValue);
    });
  }

  _populateModels(providerKey, currentModel) {
    const cfg = PROVIDER_CONFIGS[providerKey];
    this._aiModelSelect.innerHTML = '';
    cfg.models.forEach(m => {
      const opt = document.createElement('option');
      opt.value = m.id; opt.textContent = m.id;
      this._aiModelSelect.appendChild(opt);
    });
    if (currentModel && cfg.models.some(m => m.id === currentModel)) {
      this._aiModelSelect.value = currentModel;
    }
    this._renderModelDesc(providerKey);
  }

  _renderModelDesc(providerKey) {
    const cfg = PROVIDER_CONFIGS[providerKey];
    const selectedId = this._aiModelSelect.value;

    const table = document.createElement('table');
    table.className = 'model-table';

    cfg.models.forEach(m => {
      const tr = document.createElement('tr');
      if (m.id === selectedId) tr.className = 'selected';

      const tdName = document.createElement('td');
      tdName.className = 'model-table-name';
      tdName.innerHTML = `<span class="model-table-id">${m.id}</span><span class="model-table-desc">${m.desc}</span>`;

      const tdPrice = document.createElement('td');
      tdPrice.className = 'model-table-price';
      tdPrice.textContent = m.price;

      tr.append(tdName, tdPrice);
      tr.addEventListener('click', () => {
        this._aiModelSelect.value = m.id;
        this._renderModelDesc(providerKey);
      });
      table.appendChild(tr);
    });

    const footer = document.createElement('p');
    footer.className = 'note model-table-footer';
    footer.innerHTML = `Prices indicative as of 2026-03 — <a href="${cfg.pricingUrl}" target="_blank" rel="noopener">check official pricing</a>`;

    this._modelTableEl.replaceChildren(table, footer);
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

    this._aiModelSelect.addEventListener('change', () => {
      this._renderModelDesc(this._providerSelect.value);
    });

    this._verboseLoggingCheckbox.addEventListener('change', () => {
      browser.storage.local.set({ verboseLogging: this._verboseLoggingCheckbox.checked });
    });

    this._transLogEnabledCheckbox.addEventListener('change', () => {
      browser.storage.local.set({ transLogEnabled: this._transLogEnabledCheckbox.checked });
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

    this._copyTransLogBtn.addEventListener('click', async () => {
      const text = this._transLogOutput.value || '';
      if (!text) { this._showTransLogStatus('No entries to copy.', 'info'); return; }
      try {
        await navigator.clipboard.writeText(text);
        this._showTransLogStatus('Log copied to clipboard.', 'success');
      } catch (err) {
        this._showTransLogStatus(`Copy failed: ${err.message}`, 'error');
      }
    });

    this._clearTransLogBtn.addEventListener('click', async () => {
      await browser.storage.local.set({ [this._TRANS_LOG_KEY]: [] });
      this._renderTransLog([]);
      this._showTransLogStatus('Log cleared.', 'success');
    });

    this._refreshTransLogBtn.addEventListener('click', () => this._loadTransLog());

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
            max_completion_tokens: 10,
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

  async _loadTransLog() {
    const r = await browser.storage.local.get(this._TRANS_LOG_KEY);
    this._renderTransLog(r[this._TRANS_LOG_KEY]);
  }

  _renderTransLog(entries) {
    const arr = Array.isArray(entries) ? entries : [];
    this._transLogOutput.value = arr.map(e => JSON.stringify(e, null, 2)).join('\n\n---\n\n');
    this._transLogCount.textContent = arr.length ? `Entries: ${arr.length}` : 'No entries yet.';
  }

  _showTransLogStatus(message, type) {
    this._transLogStatus.textContent = message;
    this._transLogStatus.className = `status ${type}`;
    this._transLogStatus.classList.remove('hidden');
    if (type === 'success' || type === 'info') {
      setTimeout(() => this._transLogStatus.classList.add('hidden'), 4000);
    }
  }
}

new OptionsController();
