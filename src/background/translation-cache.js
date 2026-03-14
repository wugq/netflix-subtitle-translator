'use strict';

class TranslationCache {
  constructor() {
    this._cache = {};
    this._cacheKey = 'nstTranslationCache';
  }

  async load() {
    const r = await browser.storage.local.get(this._cacheKey);
    if (r[this._cacheKey]) this._cache = r[this._cacheKey];
  }

  get(movieId, dstLang) {
    if (!this._cache[movieId]) return null;
    return this._cache[movieId][dstLang] || null;
  }

  update(movieId, dstLang, translations) {
    if (!movieId || !dstLang || !translations) return;
    if (!this._cache[movieId]) this._cache[movieId] = {};
    if (!this._cache[movieId][dstLang]) this._cache[movieId][dstLang] = {};
    Object.assign(this._cache[movieId][dstLang], translations);
    this._save();
  }

  async _save() {
    try {
      const movieIds = Object.keys(this._cache);
      if (movieIds.length > 10) {
        const toRemove = movieIds.slice(0, movieIds.length - 10);
        toRemove.forEach(id => delete this._cache[id]);
      }
      await browser.storage.local.set({ [this._cacheKey]: this._cache });
    } catch (err) {
      console.error('[NST] Cache save error:', err.message);
    }
  }
}
