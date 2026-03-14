// popup-controller.js
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

function relativeTime(ts) {
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

class PopupController {
  constructor() {
    this._statusBadge   = document.getElementById('statusBadge');
    this._toggleBtn     = document.getElementById('toggleTranslation');
    this._openOptionsBtn = document.getElementById('openOptions');
    this._dstLangSelect = document.getElementById('dstLang');
    this._showAiNoticeCheckbox = document.getElementById('showAiNotice');
    this._statusRow  = document.getElementById('statusRow');
    this._statusText = document.getElementById('statusText');
    this._statusTime = document.getElementById('statusTime');

    this._translationEnabled = true;
    this._timeInterval = null;

    this._FONT_MIN = 12; this._FONT_MAX = 96; this._FONT_STEP = 2;
    this._POS_MIN  = 0;  this._POS_MAX  = 90; this._POS_STEP  = 2;
    this._WIN_MIN  = 1;  this._WIN_MAX  = 30; this._WIN_STEP  = 1;
    this._DEFAULTS = { subtitleFontSize: 24, subtitleBottom: 8, windowMinutes: 5 };

    this._fontVal = document.getElementById('fontVal');
    this._posVal  = document.getElementById('posVal');
    this._winVal  = document.getElementById('winVal');

    this._settings = { ...this._DEFAULTS };

    this._STATE_CONFIG = {
      idle:        { cls: 'state-idle' },
      detected:    { cls: 'state-detected' },
      translating: { cls: 'state-translating' },
      done:        { cls: 'state-done' },
      error:       { cls: 'state-error' },
      ai_notice:   { cls: 'state-ai_notice' },
    };

    this._loadAndRender();
    this._bindEvents();
  }

  _bindEvents() {
    this._openOptionsBtn.addEventListener('click', () => {
      browser.runtime.openOptionsPage();
      window.close();
    });

    this._toggleBtn.addEventListener('click', () => {
      this._translationEnabled = !this._translationEnabled;
      browser.storage.local.set({ translationEnabled: this._translationEnabled });
      this._updateToggleBtn();
    });

    this._dstLangSelect.addEventListener('change', () => {
      browser.storage.local.set({ dstLang: this._dstLangSelect.value });
    });

    this._showAiNoticeCheckbox.addEventListener('change', () => {
      browser.storage.local.set({ showAiNotice: this._showAiNoticeCheckbox.checked });
    });

    this._bindSteppers();

    browser.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes.translationStatus) {
        this._renderStatus(changes.translationStatus.newValue);
        if (changes.translationStatus.newValue?.ts) {
          clearInterval(this._timeInterval);
          this._timeInterval = setInterval(() => {
            const ts = changes.translationStatus.newValue.ts;
            this._statusTime.textContent = relativeTime(ts);
          }, 10000);
        }
      }
    });
  }

  _bindSteppers() {
    this._bindStepper('fontDown', () => { this._settings.subtitleFontSize = Math.max(this._FONT_MIN, this._settings.subtitleFontSize - this._FONT_STEP); });
    this._bindStepper('fontUp',   () => { this._settings.subtitleFontSize = Math.min(this._FONT_MAX, this._settings.subtitleFontSize + this._FONT_STEP); });
    this._bindStepper('posDown',  () => { this._settings.subtitleBottom   = Math.max(this._POS_MIN,  this._settings.subtitleBottom   - this._POS_STEP);  });
    this._bindStepper('posUp',    () => { this._settings.subtitleBottom   = Math.min(this._POS_MAX,  this._settings.subtitleBottom   + this._POS_STEP);  });
    this._bindStepper('winDown',  () => { this._settings.windowMinutes    = Math.max(this._WIN_MIN,  this._settings.windowMinutes    - this._WIN_STEP);  });
    this._bindStepper('winUp',    () => { this._settings.windowMinutes    = Math.min(this._WIN_MAX,  this._settings.windowMinutes    + this._WIN_STEP);  });
  }

  _bindStepper(btnId, action) {
    const btn = document.getElementById(btnId);
    let timeout, interval;

    const step = () => { action(); this._applySettings(); };

    const start = () => {
      step();
      timeout = setTimeout(() => { interval = setInterval(step, 80); }, 400);
    };

    const stop = () => { clearTimeout(timeout); clearInterval(interval); };

    btn.addEventListener('mousedown', start);
    btn.addEventListener('mouseup', stop);
    btn.addEventListener('mouseleave', stop);
    btn.addEventListener('touchstart', e => { e.preventDefault(); start(); });
    btn.addEventListener('touchend', stop);
  }

  _loadAndRender() {
    // API key status
    browser.storage.local.get('openaiApiKey').then(r => {
      const hasKey = !!(r.openaiApiKey);
      this._statusBadge.textContent = hasKey ? 'Configured' : 'Not configured';
      this._statusBadge.className   = hasKey ? 'badge badge-configured' : 'badge badge-unconfigured';
    });

    // Translation enabled
    browser.storage.local.get('translationEnabled').then(r => {
      this._translationEnabled = r.translationEnabled !== false;
      this._updateToggleBtn();
    });

    // Destination language
    browser.storage.local.get('dstLang').then(r => {
      if (r.dstLang) this._dstLangSelect.value = r.dstLang;
    });

    // AI notice toggle
    browser.storage.local.get('showAiNotice').then(r => {
      this._showAiNoticeCheckbox.checked = r.showAiNotice !== false;
    });

    // Display settings
    browser.storage.local.get(['subtitleFontSize', 'subtitleBottom', 'windowMinutes']).then(r => {
      this._settings.subtitleFontSize = r.subtitleFontSize ?? this._DEFAULTS.subtitleFontSize;
      this._settings.subtitleBottom   = r.subtitleBottom   ?? this._DEFAULTS.subtitleBottom;
      this._settings.windowMinutes    = r.windowMinutes    ?? this._DEFAULTS.windowMinutes;
      this._fontVal.textContent = this._settings.subtitleFontSize + 'px';
      this._posVal.textContent  = this._settings.subtitleBottom + '%';
      this._winVal.textContent  = this._settings.windowMinutes + ' min';
    });

    // Translation status
    browser.storage.local.get('translationStatus').then(r => {
      this._renderStatus(r.translationStatus || null);
    });
  }

  _renderStatus(status) {
    if (!status) return;
    const { state, message, ts } = status;
    const cfg = this._STATE_CONFIG[state] || this._STATE_CONFIG.idle;
    this._statusRow.className    = `status-row ${cfg.cls}`;
    this._statusText.textContent = message;
    this._statusTime.textContent = ts ? relativeTime(ts) : '';
  }

  _updateToggleBtn() {
    if (this._translationEnabled) {
      this._toggleBtn.textContent = 'Stop Translation';
      this._toggleBtn.className   = 'toggle-btn';
    } else {
      this._toggleBtn.textContent = 'Resume Translation';
      this._toggleBtn.className   = 'toggle-btn paused';
    }
  }

  _applySettings() {
    this._fontVal.textContent = this._settings.subtitleFontSize + 'px';
    this._posVal.textContent  = this._settings.subtitleBottom + '%';
    this._winVal.textContent  = this._settings.windowMinutes + ' min';
    browser.storage.local.set({
      subtitleFontSize: this._settings.subtitleFontSize,
      subtitleBottom:   this._settings.subtitleBottom,
      windowMinutes:    this._settings.windowMinutes,
    });
  }
}

new PopupController();
