'use strict';

class SegmentStore {
  constructor() {
    this._orig = [];
    this._overlay = [];
    this._done = [];
  }

  load(segs) {
    this._orig    = segs.map(s => ({ ...s }));
    this._overlay = segs.map(s => ({ ...s }));
    this._done    = new Array(segs.length).fill(false);
  }

  reset() { this._orig = []; this._overlay = []; this._done = []; }

  getOverlay()  { return this._overlay; }
  getOriginal() { return this._orig; }

  pendingIndices(from, to) {
    return this._overlay.reduce(
      (a, s, i) => (!this._done[i] && s.end > from && s.begin < to) ? [...a, i] : a,
      []
    );
  }

  applyTranslations(indices, map) {
    let n = 0;
    for (const i of indices) {
      const key = this._orig[i]?.key || this._overlay[i]?.key || `idx-${i}`;
      if (typeof map[key] === 'string') {
        this._overlay[i] = { ...this._overlay[i], text: map[key] };
        this._done[i] = true;
        n++;
      }
    }
    return n;
  }

  getItemsForIndices(indices) {
    return indices.map(i => ({
      key:  this._orig[i]?.key  || this._overlay[i]?.key  || `idx-${i}`,
      text: this._orig[i]?.text || this._overlay[i]?.text,
    }));
  }
}
