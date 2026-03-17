// popup-controller.js
'use strict';

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
    this._showNoticeCheckbox = document.getElementById('showNotice');
    this._showOriginalCheckbox = document.getElementById('showOriginalText');
    this._subtitleStyleSelect = document.getElementById('subtitleStyle');
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

    this._offNetflix  = document.getElementById('offNetflix');
    this._mainContent = document.getElementById('mainContent');

    this._checkCurrentTab();
    this._bindEvents();
  }

  _checkCurrentTab() {
    browser.tabs.query({ active: true, currentWindow: true }).then(tabs => {
      const url = tabs[0]?.url || '';
      if (!url.startsWith('https://www.netflix.com') && !url.startsWith('http://www.netflix.com')) {
        this._offNetflix.hidden  = false;
        this._mainContent.hidden = true;
      } else {
        this._offNetflix.hidden  = true;
        this._mainContent.hidden = false;
        this._loadAndRender();
      }
    });
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

    this._showNoticeCheckbox.addEventListener('change', () => {
      browser.storage.local.set({ showNotice: this._showNoticeCheckbox.checked });
    });

    this._showOriginalCheckbox.addEventListener('change', () => {
      browser.storage.local.set({ showOriginalText: this._showOriginalCheckbox.checked });
    });

    this._subtitleStyleSelect.addEventListener('change', () => {
      browser.storage.local.set({ subtitleStyle: this._subtitleStyleSelect.value });
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
      if (changes.netflixLangStatus) {
        this._updateLangIndicators(changes.netflixLangStatus.newValue || null);
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
    browser.storage.local.get([
      'openaiApiKey', 'aiModel', 'aiBaseUrl',
      'translationEnabled', 'dstLang', 'showNotice', 'showOriginalText', 'subtitleStyle',
      'subtitleFontSize', 'subtitleBottom', 'windowMinutes',
      'translationStatus', 'netflixLangStatus',
    ]).then(r => {
      // AI provider status
      const hasKey = !!(r.openaiApiKey);
      if (hasKey) {
        const model   = r.aiModel || 'gpt-4o-mini';
        const baseUrl = (r.aiBaseUrl || '').trim().replace(/\/$/, '');
        const provider = baseUrl === 'https://api.x.ai/v1' ? 'xAI' : 'OpenAI';
        this._statusBadge.textContent = `${provider} · ${model}`;
        this._statusBadge.className   = 'badge badge-configured';
      } else {
        this._statusBadge.textContent = 'Not configured';
        this._statusBadge.className   = 'badge badge-unconfigured';
      }

      this._translationEnabled = r.translationEnabled !== false;
      this._updateToggleBtn();

      if (r.dstLang) this._dstLangSelect.value = r.dstLang;
      this._showNoticeCheckbox.checked    = r.showNotice !== false;
      this._showOriginalCheckbox.checked  = !!r.showOriginalText;
      if (r.subtitleStyle) this._subtitleStyleSelect.value = r.subtitleStyle;

      this._settings.subtitleFontSize = r.subtitleFontSize ?? this._DEFAULTS.subtitleFontSize;
      this._settings.subtitleBottom   = r.subtitleBottom   ?? this._DEFAULTS.subtitleBottom;
      this._settings.windowMinutes    = r.windowMinutes    ?? this._DEFAULTS.windowMinutes;
      this._fontVal.textContent = this._settings.subtitleFontSize + 'px';
      this._posVal.textContent  = this._settings.subtitleBottom + '%';
      this._winVal.textContent  = this._settings.windowMinutes + ' min';

      this._renderStatus(r.translationStatus || null);
      this._updateLangIndicators(r.netflixLangStatus || null);
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

  _langMatches(a, b) {
    if (!a || !b) return false;
    const la = a.toLowerCase(), lb = b.toLowerCase();
    return la === lb || la.startsWith(lb + '-') || lb.startsWith(la + '-');
  }

  _updateLangIndicators(langStatus) {
    const opts = Array.from(this._dstLangSelect.options);
    for (const opt of opts) {
      const base = opt.dataset.baseText || opt.textContent.replace(/^[●○✦] /, '');
      opt.dataset.baseText = base;

      if (!langStatus) {
        opt.textContent = base;
        continue;
      }
      const { nativeAvailable = [], needsSelection = [] } = langStatus;
      if (nativeAvailable.some(l => this._langMatches(l, opt.value))) {
        opt.textContent = '● ' + base;
      } else if (needsSelection.some(l => this._langMatches(l, opt.value))) {
        opt.textContent = '○ ' + base;
      } else {
        opt.textContent = '✦ ' + base;
      }
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
