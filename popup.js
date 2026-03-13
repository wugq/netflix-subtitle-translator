// popup.js
'use strict';

const apiKeyInput = document.getElementById('apiKey');
const saveBtn = document.getElementById('saveBtn');
const testBtn = document.getElementById('testBtn');
const feedbackEl = document.getElementById('feedback');
const statusBadge = document.getElementById('statusBadge');
const toggleVisBtn = document.getElementById('toggleVisibility');
const openOptionsBtn = document.getElementById('openOptions');

let feedbackTimer = null;

function showFeedback(message, type) {
  clearTimeout(feedbackTimer);
  feedbackEl.textContent = message;
  feedbackEl.className = `feedback ${type}`;
  if (type !== 'loading') {
    feedbackTimer = setTimeout(() => {
      feedbackEl.className = 'feedback hidden';
    }, 3500);
  }
}

function updateBadge(hasKey) {
  if (hasKey) {
    statusBadge.textContent = 'Configured';
    statusBadge.className = 'badge badge-configured';
  } else {
    statusBadge.textContent = 'Not configured';
    statusBadge.className = 'badge badge-unconfigured';
  }
}

// Load saved key
browser.storage.local.get('openaiApiKey').then(result => {
  const key = result.openaiApiKey || '';
  if (key) {
    apiKeyInput.value = key;
    updateBadge(true);
  }
});

// Toggle key visibility
toggleVisBtn.addEventListener('click', () => {
  apiKeyInput.type = apiKeyInput.type === 'password' ? 'text' : 'password';
});

// Save
saveBtn.addEventListener('click', async () => {
  const key = apiKeyInput.value.trim();
  if (!key) {
    showFeedback('Please enter an API key.', 'error');
    return;
  }
  if (!key.startsWith('sk-')) {
    showFeedback('Key must start with "sk-".', 'error');
    return;
  }
  await browser.storage.local.set({ openaiApiKey: key });
  updateBadge(true);
  showFeedback('Saved.', 'success');
});

// Test
testBtn.addEventListener('click', async () => {
  const key = apiKeyInput.value.trim();
  if (!key) {
    showFeedback('Enter a key first.', 'error');
    return;
  }
  if (!key.startsWith('sk-')) {
    showFeedback('Key must start with "sk-".', 'error');
    return;
  }

  showFeedback('Testing…', 'loading');
  testBtn.disabled = true;

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0,
        max_tokens: 5,
        messages: [{ role: 'user', content: 'Say OK.' }],
      }),
    });

    if (res.ok) {
      showFeedback('Key is valid.', 'success');
    } else {
      const body = await res.json().catch(() => ({}));
      showFeedback(body.error?.message || `Error ${res.status}`, 'error');
    }
  } catch (err) {
    showFeedback(`Network error: ${err.message}`, 'error');
  } finally {
    testBtn.disabled = false;
  }
});

// Open full options page
openOptionsBtn.addEventListener('click', () => {
  browser.runtime.openOptionsPage();
  window.close();
});

// ---------------------------------------------------------------------------
// Subtitle display controls
// ---------------------------------------------------------------------------
const FONT_MIN = 12, FONT_MAX = 96, FONT_STEP = 2;
const POS_MIN  = 0,  POS_MAX  = 90, POS_STEP  = 2;
const DEFAULTS = { subtitleFontSize: 24, subtitleBottom: 8 };

const fontVal = document.getElementById('fontVal');
const posVal  = document.getElementById('posVal');

let settings = { ...DEFAULTS };

function applySettings() {
  fontVal.textContent = settings.subtitleFontSize + 'px';
  posVal.textContent  = settings.subtitleBottom + '%';
  browser.storage.local.set({
    subtitleFontSize: settings.subtitleFontSize,
    subtitleBottom:   settings.subtitleBottom,
  });
}

// Load saved settings
browser.storage.local.get(['subtitleFontSize', 'subtitleBottom']).then(r => {
  settings.subtitleFontSize = r.subtitleFontSize ?? DEFAULTS.subtitleFontSize;
  settings.subtitleBottom   = r.subtitleBottom   ?? DEFAULTS.subtitleBottom;
  fontVal.textContent = settings.subtitleFontSize + 'px';
  posVal.textContent  = settings.subtitleBottom + '%';
});

// Hold-to-repeat: fires once immediately, then accelerates after a delay
function bindStepper(btnId, action) {
  const btn = document.getElementById(btnId);
  let timeout, interval;

  function step() { action(); applySettings(); }

  function start() {
    step();
    timeout = setTimeout(() => {
      interval = setInterval(step, 80);
    }, 400);
  }

  function stop() {
    clearTimeout(timeout);
    clearInterval(interval);
  }

  btn.addEventListener('mousedown', start);
  btn.addEventListener('mouseup', stop);
  btn.addEventListener('mouseleave', stop);
  // Touch support
  btn.addEventListener('touchstart', e => { e.preventDefault(); start(); });
  btn.addEventListener('touchend', stop);
}

bindStepper('fontDown', () => { settings.subtitleFontSize = Math.max(FONT_MIN, settings.subtitleFontSize - FONT_STEP); });
bindStepper('fontUp',   () => { settings.subtitleFontSize = Math.min(FONT_MAX, settings.subtitleFontSize + FONT_STEP); });
bindStepper('posDown',  () => { settings.subtitleBottom   = Math.max(POS_MIN,  settings.subtitleBottom   - POS_STEP);  });
bindStepper('posUp',    () => { settings.subtitleBottom   = Math.min(POS_MAX,  settings.subtitleBottom   + POS_STEP);  });

// ---------------------------------------------------------------------------
// Translation status panel
// ---------------------------------------------------------------------------
const statusRow = document.getElementById('statusRow');
const statusText = document.getElementById('statusText');
const statusTime = document.getElementById('statusTime');

const STATE_CONFIG = {
  idle:        { label: 'Waiting for Netflix…',    cls: 'state-idle' },
  detected:    { label: null,                       cls: 'state-detected' },
  translating: { label: null,                       cls: 'state-translating' },
  done:        { label: null,                       cls: 'state-done' },
  error:       { label: null,                       cls: 'state-error' },
};

function relativeTime(ts) {
  const diff = Math.round((Date.now() - ts) / 1000);
  if (diff < 5)  return 'just now';
  if (diff < 60) return `${diff}s ago`;
  const m = Math.round(diff / 60);
  return `${m}m ago`;
}

function renderStatus(status) {
  if (!status) return;
  const { state, message, ts } = status;
  const cfg = STATE_CONFIG[state] || STATE_CONFIG.idle;

  // Remove all state classes, apply the right one
  statusRow.className = `status-row ${cfg.cls}`;
  statusText.textContent = cfg.label || message;
  statusTime.textContent = ts ? relativeTime(ts) : '';
}

// Load on open
browser.storage.local.get('translationStatus').then(r => {
  renderStatus(r.translationStatus || null);
});

// Live updates while popup is open
browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.translationStatus) {
    renderStatus(changes.translationStatus.newValue);
    if (changes.translationStatus.newValue?.ts) {
      // keep relative timestamp fresh
      clearInterval(window._timeInterval);
      window._timeInterval = setInterval(() => {
        const ts = changes.translationStatus.newValue.ts;
        statusTime.textContent = relativeTime(ts);
      }, 10000);
    }
  }
});
