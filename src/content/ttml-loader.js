'use strict';

class TtmlLoader {
  constructor(logger, onStatus) {
    this._logger   = logger;
    this._onStatus = onStatus;
  }

  async load(tracks, langCode, trackResolver) {
    const url = trackResolver.findTtmlUrl(tracks, langCode);
    if (!url) {
      this._onStatus('error', `No subtitle track for "${langCode}"`);
      return null;
    }
    let xml;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      xml = await res.text();
    } catch (err) {
      this._onStatus('error', 'Fetch failed: ' + err.message);
      return null;
    }
    try {
      const segs = TtmlParser.parse(xml);
      if (!segs.length) { this._onStatus('error', 'No subtitle segments found'); return null; }
      this._logger.vlog('TTML parsed', segs.length, 'segments');
      return segs;
    } catch (err) {
      this._onStatus('error', 'TTML parse failed: ' + err.message);
      return null;
    }
  }
}
