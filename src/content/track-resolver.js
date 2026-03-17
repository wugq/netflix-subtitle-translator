'use strict';

class TrackResolver {
  langMatches(a, b) {
    if (!a || !b) return false;
    const la = a.toLowerCase(), lb = b.toLowerCase();
    return la === lb || la.startsWith(lb + '-') || lb.startsWith(la + '-');
  }

  findTtmlUrl(tracks, langCode) {
    const FORMATS = ['imsc1.1', 'dfxp-ls-sdh', 'simplesdh', 'nflx-cmisc', 'dfxp'];
    const candidates = tracks.filter(t => this.langMatches(t.language, langCode));
    if (!candidates.length) return null;

    function firstHttps(obj) {
      if (typeof obj === 'string' && obj.startsWith('https://')) return obj;
      if (obj && typeof obj === 'object') {
        for (const v of Object.values(obj)) {
          const found = firstHttps(v);
          if (found) return found;
        }
      }
      return null;
    }

    for (const track of candidates) {
      const dl = track.ttDownloadables;
      if (!dl) continue;
      for (const fmt of FORMATS) {
        const entry = dl[fmt];
        if (!entry) continue;
        const url = firstHttps(entry.downloadUrls || entry.urls || entry);
        if (url) return url;
      }
    }
    return null;
  }

  langLabel(code, tracks) {
    if (!code) return 'Source';
    const track = tracks.find(t => this.langMatches(t.language, code));
    return track?.languageDescription || code;
  }

  determineMode(srcLang, dstLang, tracks) {
    if (this.langMatches(srcLang, dstLang)) {
      return { mode: 'passthrough', ttmlLang: srcLang };
    }
    if (this.findTtmlUrl(tracks, dstLang)) {
      return { mode: 'native', ttmlLang: dstLang };
    }
    const dstListed = tracks.some(t => this.langMatches(t.language, dstLang));
    const ttmlLang  = this.findTtmlUrl(tracks, 'en') ? 'en' : srcLang;
    return { mode: 'ai', ttmlLang, dstNotLoaded: dstListed };
  }
}
