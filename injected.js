// injected.js — runs in Netflix page context, patches JSON.parse to intercept
// timedtexttracks manifest data containing subtitle download URLs.
(function () {
  'use strict';

  const _origParse = JSON.parse;

  JSON.parse = function (text, ...rest) {
    const data = _origParse.apply(this, arguments);
    try {
      // Netflix manifest response: { result: { movieId, timedtexttracks: [...] } }
      if (
        data &&
        data.result &&
        Array.isArray(data.result.timedtexttracks) &&
        data.result.timedtexttracks.length > 0
      ) {
        window.dispatchEvent(
          new CustomEvent('nst_tracks', {
            detail: JSON.stringify({
              movieId: data.result.movieId,
              tracks: data.result.timedtexttracks,
            }),
          })
        );
      }
    } catch (_) {}
    return data;
  };
})();
