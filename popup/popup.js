// popup.js
'use strict';

const statusBadge = document.getElementById('statusBadge');
const openOptionsBtn = document.getElementById('openOptions');

// Show whether API key is configured
browser.storage.local.get('openaiApiKey').then(r => {
  const hasKey = !!(r.openaiApiKey);
  statusBadge.textContent = hasKey ? 'Configured' : 'Not configured';
  statusBadge.className   = hasKey ? 'badge badge-configured' : 'badge badge-unconfigured';
});

// ---------------------------------------------------------------------------
// Translation toggle
// ---------------------------------------------------------------------------
const toggleBtn = document.getElementById('toggleTranslation');
let translationEnabled = true;

function updateToggleBtn() {
  if (translationEnabled) {
    toggleBtn.textContent = 'Stop Translation';
    toggleBtn.className   = 'toggle-btn';
  } else {
    toggleBtn.textContent = 'Resume Translation';
    toggleBtn.className   = 'toggle-btn paused';
  }
}

browser.storage.local.get('translationEnabled').then(r => {
  translationEnabled = r.translationEnabled !== false; // default true
  updateToggleBtn();
});

toggleBtn.addEventListener('click', () => {
  translationEnabled = !translationEnabled;
  browser.storage.local.set({ translationEnabled });
  updateToggleBtn();
});

// Open full options page
openOptionsBtn.addEventListener('click', () => {
  browser.runtime.openOptionsPage();
  window.close();
});

// ---------------------------------------------------------------------------
// Subtitle display controls
// ---------------------------------------------------------------------------
const FONT_MIN = 12,  FONT_MAX = 96, FONT_STEP = 2;
const POS_MIN  = 0,   POS_MAX  = 90, POS_STEP  = 2;
const WIN_MIN  = 1,   WIN_MAX  = 30, WIN_STEP  = 1;
const DEFAULTS = { subtitleFontSize: 24, subtitleBottom: 8, windowMinutes: 5 };

const fontVal = document.getElementById('fontVal');
const posVal  = document.getElementById('posVal');
const winVal  = document.getElementById('winVal');

let settings = { ...DEFAULTS };

function applySettings() {
  fontVal.textContent = settings.subtitleFontSize + 'px';
  posVal.textContent  = settings.subtitleBottom + '%';
  winVal.textContent  = settings.windowMinutes + ' min';
  browser.storage.local.set({
    subtitleFontSize: settings.subtitleFontSize,
    subtitleBottom:   settings.subtitleBottom,
    windowMinutes:    settings.windowMinutes,
  });
}

// Load saved settings
browser.storage.local.get(['subtitleFontSize', 'subtitleBottom', 'windowMinutes']).then(r => {
  settings.subtitleFontSize = r.subtitleFontSize ?? DEFAULTS.subtitleFontSize;
  settings.subtitleBottom   = r.subtitleBottom   ?? DEFAULTS.subtitleBottom;
  settings.windowMinutes    = r.windowMinutes    ?? DEFAULTS.windowMinutes;
  fontVal.textContent = settings.subtitleFontSize + 'px';
  posVal.textContent  = settings.subtitleBottom + '%';
  winVal.textContent  = settings.windowMinutes + ' min';
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
  btn.addEventListener('touchstart', e => { e.preventDefault(); start(); });
  btn.addEventListener('touchend', stop);
}

bindStepper('fontDown', () => { settings.subtitleFontSize = Math.max(FONT_MIN, settings.subtitleFontSize - FONT_STEP); });
bindStepper('fontUp',   () => { settings.subtitleFontSize = Math.min(FONT_MAX, settings.subtitleFontSize + FONT_STEP); });
bindStepper('posDown',  () => { settings.subtitleBottom   = Math.max(POS_MIN,  settings.subtitleBottom   - POS_STEP);  });
bindStepper('posUp',    () => { settings.subtitleBottom   = Math.min(POS_MAX,  settings.subtitleBottom   + POS_STEP);  });
bindStepper('winDown',  () => { settings.windowMinutes    = Math.max(WIN_MIN,  settings.windowMinutes    - WIN_STEP);  });
bindStepper('winUp',    () => { settings.windowMinutes    = Math.min(WIN_MAX,  settings.windowMinutes    + WIN_STEP);  });

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
