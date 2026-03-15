'use strict';

const LOOKAHEAD_SECONDS = 60;

class PlaybackSync {
  constructor(store, overlay, bus, logger, stateCallbacks) {
    this._store    = store;
    this._overlay  = overlay;
    this._bus      = bus;
    this._logger   = logger;
    this._cbs      = stateCallbacks;

    this._videoEl           = null;
    this._rafId             = null;
    this._seekedHandler     = null;
    this._playHandler       = null;
    this._pauseHandler      = null;
    this._lastRenderedText  = null;
    this._lastRenderedOrig  = null;
    this._lastVerboseLogTime = -1;
    this._lastWatchPageState = null;
  }

  start() {
    if (!this._videoEl) this._videoEl = document.querySelector('video');
    if (!this._videoEl) {
      this._logger.clog('Video element not found, retrying in 1s');
      setTimeout(() => this.start(), 1000); return;
    }
    if (this._rafId) cancelAnimationFrame(this._rafId);

    this._removeVideoListeners();

    this._seekedHandler = () => {
      const t = this._videoEl.currentTime;
      this._logger.clog(`Video seeked to ${this._fmt(t)}`);
      this._bus.emit('playback:seeked', { time: t });
    };
    this._playHandler = () => {
      if (!this._cbs.isOnWatchPage()) return;
      const t = this._videoEl.currentTime;
      this._logger.clog(`Video play at ${this._fmt(t)}`);
      this._bus.emit('playback:play', { time: t });
    };
    this._pauseHandler = () => {
      if (!this._cbs.isOnWatchPage()) return;
      this._logger.clog('Video pause');
      this._bus.emit('playback:pause', {});
    };

    this._videoEl.addEventListener('seeked',  this._seekedHandler);
    this._videoEl.addEventListener('play',    this._playHandler);
    this._videoEl.addEventListener('pause',   this._pauseHandler);

    this._tick();
    this._logger.clog('Subtitle sync started');
  }

  stop() {
    if (this._rafId) { cancelAnimationFrame(this._rafId); this._rafId = null; }
    this._removeVideoListeners();
    this._logger.clog('Subtitle sync stopped');
    this._videoEl = null;
  }

  get videoEl() { return this._videoEl; }
  set videoEl(el) { this._videoEl = el; }

  _removeVideoListeners() {
    if (this._videoEl) {
      if (this._seekedHandler) this._videoEl.removeEventListener('seeked', this._seekedHandler);
      if (this._playHandler)   this._videoEl.removeEventListener('play',   this._playHandler);
      if (this._pauseHandler)  this._videoEl.removeEventListener('pause',  this._pauseHandler);
    }
    this._seekedHandler = this._playHandler = this._pauseHandler = null;
  }

  _tick() {
    this._rafId = requestAnimationFrame(() => this._tick());

    const state = this._cbs.read();

    if (!this._cbs.isOnWatchPage()) {
      if (this._lastRenderedText !== null) {
        this._lastRenderedText = null;
        this._lastRenderedOrig = null;
        this._overlay.render('');
      }
      if (this._lastWatchPageState !== false) {
        this._lastWatchPageState = false;
        this._cbs.setStatus('idle', 'Waiting for a video to play\u2026');
      }
      return;
    }
    if (this._lastWatchPageState !== true) this._lastWatchPageState = true;

    const t = this._videoEl ? this._videoEl.currentTime : 0;

    // Lookahead: trigger next rolling window before the current one is exhausted
    if (state.needsAiTranslation && state.translationEnabled && this._cbs.canTranslateNow() &&
        t >= state.nextWindowStart - LOOKAHEAD_SECONDS &&
        state.nextWindowStart >= state.rollingWindowEnd) {
      const duration = this._videoEl?.duration || Infinity;
      const wEnd = Math.min(state.nextWindowStart + state.windowMinutes * 60, duration);

      if (wEnd > state.nextWindowStart) {
        this._cbs.book(wEnd);
        this._logger.vlog(`Rolling window triggered: ${this._fmt(state.nextWindowStart)} → ${this._fmt(wEnd)} (at ${this._fmt(t)})`);
        const signal = state.signal;
        if (signal && !signal.aborted) {
          this._cbs.translate(state.nextWindowStart, wEnd, signal)
            .catch(() => { this._cbs.book(0); });
        }
      }
    }

    // When AI is disabled, fall back to original (source-language) segments
    const segs = (state.needsAiTranslation && !state.translationEnabled)
      ? this._store.getOriginal()
      : this._store.getOverlay();
    const activeSegs = this._findSegments(t, segs);
    const text = activeSegs.map(s => s.text).filter(Boolean).join('\n');

    // Show original text below translation when enabled
    let origText = null;
    if (state.showOriginalText && state.needsAiTranslation && state.translationEnabled) {
      const origSegs = this._findSegments(t, this._store.getOriginal());
      const raw = origSegs.map(s => s.text).filter(Boolean).join('\n');
      if (raw) origText = raw;
    }

    if (this._logger.verboseLogging && t - this._lastVerboseLogTime >= 30) {
      this._lastVerboseLogTime = t;
      this._logger.vlog('Playback timing', {
        currentTime: t,
        playbackRate: this._videoEl?.playbackRate,
        activeCount: activeSegs.length,
        firstSegText: activeSegs[0]?.text ?? null,
        nextWindowStart: state.nextWindowStart,
        rollingWindowEnd: state.rollingWindowEnd,
      });
    }

    if (text !== this._lastRenderedText || origText !== this._lastRenderedOrig) {
      this._lastRenderedText = text;
      this._lastRenderedOrig = origText;
      this._overlay.render(text, origText);
    }
  }

  _findSegments(time, segs) {
    if (!segs.length) return [];
    let lo = 0, hi = segs.length - 1, startIdx = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (segs[mid].begin <= time) { startIdx = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    const results = [];
    for (let i = startIdx; i >= 0; i--) {
      const s = segs[i];
      if (s.begin <= time && s.end > time) results.push(s);
      if (time - s.begin > 60) break;
    }
    return results.sort((a, b) => a.begin - b.begin || a.seq - b.seq);
  }

  _fmt(s) {
    return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  }
}
