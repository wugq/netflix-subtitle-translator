// options.js
'use strict';

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

// Debug logging toggle
const debugLoggingCheckbox = document.getElementById('debugLogging');
browser.storage.local.get('debugLogging').then(r => {
  debugLoggingCheckbox.checked = r.debugLogging || false;
});
debugLoggingCheckbox.addEventListener('change', () => {
  browser.storage.local.set({ debugLogging: debugLoggingCheckbox.checked });
});

// Load saved key on open
browser.storage.local.get('openaiApiKey').then(result => {
  if (result.openaiApiKey) {
    apiKeyInput.value = result.openaiApiKey;
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
