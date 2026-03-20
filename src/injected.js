// injected.js — runs in Netflix page context, patches JSON.parse to intercept
// timedtexttracks manifest data, and patches fetch to detect which subtitle
// language Netflix actively loads (used as the source language signal).
(function () {
  'use strict';

  const urlToLang = {};

  // Map of movieId → tracks, kept across navigations so the content script can
  // request a re-dispatch when Netflix re-uses its internal parsed manifest
  // (i.e. does not re-fetch, so JSON.parse is never called again).
  // Capped at 50 entries (FIFO) to avoid unbounded memory growth.
  const manifestByMovieId = {};
  const manifestOrder = [];

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

        for (const key of Object.keys(urlToLang)) delete urlToLang[key];
        for (const track of tracks) extractUrls(track);

        const payload = {
          movieId: data.result.movieId,
          tracks,
        };

        const mid = String(payload.movieId);
        const idx = manifestOrder.indexOf(mid);
        if (idx !== -1) manifestOrder.splice(idx, 1);
        manifestOrder.push(mid);
        manifestByMovieId[mid] = tracks;
        if (manifestOrder.length > 50) {
          delete manifestByMovieId[manifestOrder.shift()];
        }

        window.dispatchEvent(
          new CustomEvent('nst_tracks', {
            detail: JSON.stringify(payload),
          })
        );
      }
    } catch (_) {}
    return data;
  };
  // Respond to manifest requests from the content script. Re-dispatches the
  // manifest if we have it, or fires nst_no_tracks to signal a URL alias
  // (Netflix alias IDs have no manifest; the canonical one arrives separately).
  window.addEventListener('nst_request_tracks', (e) => {
    try {
      const { movieId } = JSON.parse(e.detail);
      const tracks = manifestByMovieId[String(movieId)];
      if (tracks) {
        window.dispatchEvent(new CustomEvent('nst_tracks', {
          detail: JSON.stringify({ movieId, tracks }),
        }));
      } else {
        window.dispatchEvent(new CustomEvent('nst_no_tracks', {
          detail: JSON.stringify({ movieId }),
        }));
      }
    } catch (_) {}
  });
})();
