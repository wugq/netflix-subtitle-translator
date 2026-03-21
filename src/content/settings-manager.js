'use strict';

class SettingsManager {
  constructor(logger, callbacks) {
    this._logger = logger;
    this._cbs    = callbacks;
    // Defaults (mirrors the previous SubtitleController inline defaults)
    this.windowMinutes      = 5;
    this.subtitleFontSize   = 24;
    this.subtitleBottom     = 8;
    this.subtitleStyle      = 'classic';
    this.translationEnabled = true;
    this.dstLang            = 'zh-Hans';
    this.showNotice         = true;
    this.showOriginalText   = false;
  }

  load() {
    browser.storage.local.get([
      'subtitleFontSize', 'subtitleBottom', 'subtitleStyle', 'windowMinutes', 'translationEnabled', 'dstLang',
      'showNotice', 'verboseLogging', 'showOriginalText',
    ]).then(r => {
      if (r.subtitleFontSize   != null) this.subtitleFontSize   = r.subtitleFontSize;
      if (r.subtitleBottom     != null) this.subtitleBottom     = r.subtitleBottom;
      if (r.subtitleStyle      != null) this.subtitleStyle      = r.subtitleStyle;
      if (r.windowMinutes      != null) this.windowMinutes      = r.windowMinutes;
      if (r.translationEnabled != null) this.translationEnabled = r.translationEnabled;
      if (r.dstLang            != null) this.dstLang            = r.dstLang;
      if (r.showNotice         != null) this.showNotice         = r.showNotice;
      if (r.showOriginalText   != null) this.showOriginalText   = r.showOriginalText;
      if (r.verboseLogging     != null) this._cbs.onVerboseLoggingChanged(r.verboseLogging);
      this._cbs.onStyleChanged(this.subtitleFontSize, this.subtitleBottom, this.subtitleStyle);
    }).catch(err => this._logger.vlog('Failed to load settings: ' + err.message));

    browser.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      let styleChanged = false;
      if ('subtitleFontSize' in changes) { this.subtitleFontSize = changes.subtitleFontSize.newValue; styleChanged = true; }
      if ('subtitleBottom'   in changes) { this.subtitleBottom   = changes.subtitleBottom.newValue;   styleChanged = true; }
      if ('subtitleStyle'    in changes) { this.subtitleStyle    = changes.subtitleStyle.newValue;    styleChanged = true; }
      if ('windowMinutes'      in changes) this.windowMinutes      = changes.windowMinutes.newValue;
      if ('translationEnabled' in changes) {
        this.translationEnabled = changes.translationEnabled.newValue;
        this._cbs.onTranslationEnabledChanged(this.translationEnabled);
      }
      if ('dstLang' in changes) {
        this.dstLang = changes.dstLang.newValue;
        this._cbs.onDstLangChanged();
      }
      if ('showNotice'       in changes) this.showNotice       = changes.showNotice.newValue;
      if ('showOriginalText' in changes) this.showOriginalText = changes.showOriginalText.newValue;
      if ('verboseLogging'   in changes) this._cbs.onVerboseLoggingChanged(changes.verboseLogging.newValue);
      if (styleChanged) this._cbs.onStyleChanged(this.subtitleFontSize, this.subtitleBottom, this.subtitleStyle);
    });
  }
}
