// options.js
'use strict';

// Chrome compatibility polyfill (Handles Promise vs Callback mismatch)
if (typeof browser === 'undefined') {
  var browser = new Proxy(chrome, {
    get(target, prop) {
      const area = target[prop];
      if (!area || typeof area !== 'object') return area;
      return new Proxy(area, {
        get(target, prop) {
          const func = target[prop];
          if (typeof func !== 'function') return func;
          // Don't promisify listener methods
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

const apiKeyInput = document.getElementById('apiKey');
const saveBtn = document.getElementById('saveBtn');
const testBtn = document.getElementById('testBtn');
const statusEl = document.getElementById('status');

function showStatus(message, type) {
  statusEl.textContent = message;
  statusEl.className = `status ${type}`;
  statusEl.classList.remove('hidden');
  if (type === 'success' || type === 'info') {
    setTimeout(() => statusEl.classList.add('hidden'), 4000);
  }
}

// Logging toggles
const consoleLoggingCheckbox = document.getElementById('consoleLogging');
const verboseLoggingCheckbox = document.getElementById('verboseLogging');
browser.storage.local.get(['consoleLogging', 'verboseLogging']).then(r => {
  consoleLoggingCheckbox.checked = r.consoleLogging || false;
  verboseLoggingCheckbox.checked = r.verboseLogging || false;
});
consoleLoggingCheckbox.addEventListener('change', () => {
  browser.storage.local.set({ consoleLogging: consoleLoggingCheckbox.checked });
});
verboseLoggingCheckbox.addEventListener('change', () => {
  browser.storage.local.set({ verboseLogging: verboseLoggingCheckbox.checked });
});

// Log viewer
const LOG_KEY = 'nstLogBuffer';
const logOutput = document.getElementById('logOutput');
const logCount = document.getElementById('logCount');
const copyLogsBtn = document.getElementById('copyLogs');
const clearLogsBtn = document.getElementById('clearLogs');
const refreshLogsBtn = document.getElementById('refreshLogs');

function renderLogs(lines) {
  const arr = Array.isArray(lines) ? lines : [];
  logOutput.value = arr.join('\n');
  logCount.textContent = arr.length ? `Log entries: ${arr.length}` : 'No logs yet.';
}

async function loadLogs() {
  const r = await browser.storage.local.get(LOG_KEY);
  renderLogs(r[LOG_KEY]);
}

copyLogsBtn.addEventListener('click', async () => {
  const text = logOutput.value || '';
  if (!text) {
    showStatus('No logs to copy.', 'info');
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    showStatus('Logs copied to clipboard.', 'success');
  } catch (err) {
    showStatus(`Copy failed: ${err.message}`, 'error');
  }
});

clearLogsBtn.addEventListener('click', async () => {
  await browser.storage.local.set({ [LOG_KEY]: [] });
  renderLogs([]);
  showStatus('Logs cleared.', 'success');
});

refreshLogsBtn.addEventListener('click', loadLogs);

// Load saved key on open
browser.storage.local.get('openaiApiKey').then(result => {
  if (result.openaiApiKey) {
    apiKeyInput.value = result.openaiApiKey;
  }
});

loadLogs();

browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[LOG_KEY]) {
    renderLogs(changes[LOG_KEY].newValue);
  }
});

saveBtn.addEventListener('click', async () => {
  const key = apiKeyInput.value.trim();

  if (!key) {
    showStatus('Please enter an API key.', 'error');
    return;
  }
  if (!key.startsWith('sk-')) {
    showStatus('API key must start with "sk-". Please check your key.', 'error');
    return;
  }

  await browser.storage.local.set({ openaiApiKey: key });
  showStatus('API key saved successfully.', 'success');
});

testBtn.addEventListener('click', async () => {
  const key = apiKeyInput.value.trim();

  if (!key) {
    showStatus('Please enter an API key first.', 'error');
    return;
  }
  if (!key.startsWith('sk-')) {
    showStatus('API key must start with "sk-".', 'error');
    return;
  }

  showStatus('Testing API key...', 'info');
  testBtn.disabled = true;

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0,
        max_tokens: 10,
        messages: [{ role: 'user', content: 'Reply with the word OK.' }],
      }),
    });

    if (response.ok) {
      showStatus('API key is valid and working.', 'success');
    } else {
      const body = await response.json().catch(() => ({}));
      const msg = body.error?.message || `HTTP ${response.status}`;
      showStatus(`API key test failed: ${msg}`, 'error');
    }
  } catch (err) {
    showStatus(`Network error: ${err.message}`, 'error');
  } finally {
    testBtn.disabled = false;
  }
});
