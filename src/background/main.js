'use strict';

const _cache   = new TranslationCache();
const _logger  = new Logger();
const _service = new TranslationService(_cache, _logger);

_cache.load().then(() => {
  _logger.clog('Cache loaded, movies:', Object.keys(_cache._cache).length);
});

browser.storage.local.get(['consoleLogging', 'verboseLogging']).then(r => {
  _logger.configure(r.consoleLogging || false, r.verboseLogging || false);
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.consoleLogging || changes.verboseLogging) {
    _logger.configure(
      changes.consoleLogging ? changes.consoleLogging.newValue : _logger._consoleLogging,
      changes.verboseLogging ? changes.verboseLogging.newValue : _logger._verboseLogging,
    );
  }
});

browser.runtime.onMessage.addListener(msg => _service.handleMessage(msg));
