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

browser.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const result = _service.handleMessage(msg);
  if (result && typeof result.then === 'function') {
    // Chrome MV3: returning a Promise does not keep the port open.
    // Must return true synchronously and call sendResponse when done.
    result.then(sendResponse).catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  // No response needed (e.g. 'log' messages)
});
