// injected.js — runs in Netflix page context, patches JSON.parse to intercept
// timedtexttracks manifest data, and patches fetch to detect which subtitle
// language Netflix actively loads (used as the source language signal).
(function () {
  'use strict';

  // Map of subtitle URL → language code, rebuilt on each new movie manifest
  const urlToLang = {};

  function extractUrls(track) {
    const lang = track.language;
    const dl   = track.ttDownloadables;
    if (!dl || !lang) return;
    function walk(obj) {
      if (typeof obj === 'string' && obj.startsWith('https://')) {
        urlToLang[obj] = lang;
      } else if (obj && typeof obj === 'object') {
        for (const v of Object.values(obj)) walk(v);
      }
    }
    walk(dl);
  }

  // Intercept fetch — when Netflix loads a subtitle URL we know, dispatch
  // nst_src_lang so the content script can detect the active subtitle language.
  const _origFetch = window.fetch;
  window.fetch = function (resource, ...args) {
    try {
      const url = typeof resource === 'string' ? resource : (resource && resource.url);
      if (url && urlToLang[url]) {
        window.dispatchEvent(new CustomEvent('nst_src_lang', {
          detail: JSON.stringify({ lang: urlToLang[url] }),
        }));
      }
    } catch (_) {}
    return _origFetch.apply(this, [resource, ...args]);
  };

  const _origParse = JSON.parse;

  JSON.parse = function (text, ...rest) {
    const data = _origParse.apply(this, arguments);
    try {
      if (
        data &&
        data.result &&
        Array.isArray(data.result.timedtexttracks) &&
        data.result.timedtexttracks.length > 0
      ) {
        const tracks = data.result.timedtexttracks;

        // Rebuild URL→lang map for the new movie
        for (const key of Object.keys(urlToLang)) delete urlToLang[key];
        for (const track of tracks) extractUrls(track);

        const availableLangs = tracks.map(t => ({
          code:  t.language,
          label: t.languageDescription || t.language,
        }));

        window.dispatchEvent(
          new CustomEvent('nst_tracks', {
            detail: JSON.stringify({
              movieId: data.result.movieId,
              tracks,
              availableLangs,
            }),
          })
        );
      }
    } catch (_) {}
    return data;
  };
})();
