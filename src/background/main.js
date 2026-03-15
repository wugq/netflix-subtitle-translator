'use strict';

const _cache   = new TranslationCache();
const _logger  = new Logger();
const _service = new TranslationService(_cache, _logger);

_cache.load();

browser.storage.local.get('verboseLogging').then(r => {
  _logger.configure(r.verboseLogging || false);
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.verboseLogging) {
    _logger.configure(changes.verboseLogging.newValue);
  }
});

browser.runtime.onMessage.addListener(msg => _service.handleMessage(msg));
