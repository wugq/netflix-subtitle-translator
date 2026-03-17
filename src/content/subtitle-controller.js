'use strict';

const BATCH_SIZE = 50;

class SubtitleController {
  constructor() {
    // Primitive instances
    this._logger  = new Logger();
    this._bus     = new EventBus();
    this._queue   = new SerialQueue();
    this._session = new TranslationSession();
    this._store   = new SegmentStore();
    this._overlay = new SubtitleOverlay();

    // Extracted helpers
    this._trackResolver = new TrackResolver();
    this._loader        = new TtmlLoader(this._logger, (state, msg) => this._setStatus(state, msg));
    this._settings      = new SettingsManager(this._logger, {
      onStyleChanged:              (fontSize, bottom, style) => this._overlay.applyStyle(fontSize, bottom, style),
      onTranslationEnabledChanged: (enabled) => this._bus.emit('settings:translationEnabled', { enabled }),
      onDstLangChanged:            () => this._onLanguageChanged('dstLang'),
      onVerboseLoggingChanged:     (verbose) => this._logger.configure(verbose),
    });
    this._nav = new NavigationWatcher(this._logger);

    // Manifest cache keyed by movieId — content script can't read window.__NST_LAST_MANIFEST__
    // because injected.js runs in the page's JS world (isolated from the content script world)
    this._manifestCache = {};

    // Movie lifecycle state
    this._currentMovieId      = null;
    this._srcLang             = 'en';
    this._availableTracks     = [];
    this._currentMode         = null;
    this._currentTtmlLang     = null;
    this._needsAiTranslation  = false;

    // Translation window state
    this._nextWindowStart = 0;
    this._rollingWindowEnd = 0;
    this._aiRequestSeq    = 0;

    // Status tracking
    this._lastStatus = null;

    // PlaybackSync wired with state callbacks
    this._sync = new PlaybackSync(
      this._store,
      this._overlay,
      this._bus,
      this._logger,
      {
        read:            () => this._readSyncState(),
        book:            (wEnd) => { this._rollingWindowEnd = wEnd; },
        translate:       (from, to, signal) => this._translateWindow(from, to, signal),
        setStatus:       (state, msg) => this._setStatus(state, msg),
        isOnWatchPage:   () => this._isOnWatchPage(),
        canTranslateNow: () => this._canTranslateNow(),
      }
    );

    this._init();
  }

  _init() {
    // Inject injected.js into page context
    const script = document.createElement('script');
    script.src = browser.runtime.getURL('src/injected.js');
    script.onload = () => script.remove();
    (document.head || document.documentElement).prepend(script);

    // Clear stale status immediately if not on a watch page
    if (!this._isOnWatchPage()) {
      this._setStatus('idle', 'Waiting for a video to play\u2026');
    }

    this._settings.load();

    this._wireEventBus();
    this._listenInjected();

    // Netflix is a SPA. The manifest for the next video fires BEFORE the URL changes,
    // so _handleTracks bails on the pre-fetch guard. When the URL finally updates we
    // re-check our manifest cache (keyed by movieId) to process the right one.
    //
    // We cannot rely solely on history.pushState/replaceState patching because Netflix
    // sometimes navigates without triggering those (no pushState log observed in traces).
    // URL polling at 200ms is used as a reliable fallback.
    const onNav = () => {
      const urlMovieId = this._getMovieIdFromUrl();
      const cachedIds  = Object.keys(this._manifestCache);
      this._logger.clog(`onNav url=${location.pathname} urlMovieId=${urlMovieId} currentMovieId=${this._currentMovieId} manifestCache=[${cachedIds}]`, this._stateSnapshot());
      if (!this._isOnWatchPage() || !urlMovieId) {
        browser.storage.local.remove('netflixLangStatus');
        if (this._currentMovieId) {
          this._currentMovieId = null;
          this._resetStateForNewVideo();
        }
        return;
      }
      if (String(urlMovieId) === String(this._currentMovieId)) return;
      const tracks = this._manifestCache[urlMovieId];
      if (tracks) {
        this._logger.clog(`Re-processing cached manifest after SPA navigation → movieId=${urlMovieId}`);
        this._handleTracks(urlMovieId, tracks);
      } else {
        this._logger.clog(`onNav — no cached manifest for urlMovieId=${urlMovieId}`);
      }
    };
    this._nav.start(onNav);

    // Note: window.__NST_LAST_MANIFEST__ is set by injected.js which runs in the page's
    // JS world (isolated from the content script world), so it is not readable here.
    // Manifests are captured via the nst_tracks DOM event and stored in this._manifestCache.
  }

  _wireEventBus() {
    this._bus.on('lang:changed', ({ reason }) => {
      this._queue.push(async () => {
        if (!this._isOnWatchPage() || !this._currentMovieId || !this._availableTracks.length) return;
        this._logger.clog(`lang:changed (${reason}) — re-applying mode`);
        const { mode, ttmlLang, dstNotLoaded } = this._trackResolver.determineMode(this._srcLang, this._settings.dstLang, this._availableTracks);
        this._session.cancel();
        const ok = await this._applyMode(this._availableTracks, mode, ttmlLang);
        if (!ok) return;

        this._overlay.ensure();

        const t = this._sync.videoEl?.currentTime ?? 0;
        this._nextWindowStart = t; this._rollingWindowEnd = 0;
        if (this._needsAiTranslation && this._settings.translationEnabled && this._canTranslateNow()) {
          const signal = this._session.start();
          this._initialTranslation(
            t,
            dstNotLoaded ? `"${this._trackResolver.langLabel(this._settings.dstLang, this._availableTracks)}" subtitle isn't loaded by Netflix yet \u2014 using AI translation instead` : null,
            signal
          );
        } else {
          this._setModeStatus(mode);
        }
      });
    });

    this._bus.on('playback:seeked', ({ time }) => {
      this._nextWindowStart = time; this._rollingWindowEnd = 0;
      if (this._needsAiTranslation && this._settings.translationEnabled && this._canTranslateNow()) {
        this._logger.clog(`playback:seeked → ${this._fmt(time)}, starting translation`);
        this._initialTranslation(time, null, this._session.start());
      } else {
        this._logger.clog(`playback:seeked → ${this._fmt(time)}, no translation (needsAi=${this._needsAiTranslation} enabled=${this._settings.translationEnabled})`);
      }
    });

    this._bus.on('playback:play', ({ time }) => {
      this._nextWindowStart = time;
      if (this._needsAiTranslation && this._settings.translationEnabled) {
        this._logger.clog(`playback:play at ${this._fmt(time)}, starting translation`);
        this._initialTranslation(time, null, this._session.start());
      } else {
        this._logger.clog(`playback:play at ${this._fmt(time)}, no translation (needsAi=${this._needsAiTranslation} enabled=${this._settings.translationEnabled})`);
        this._setModeStatus(this._currentMode);
      }
    });

    this._bus.on('playback:pause', () => {
      this._logger.clog('playback:pause — cancelling session');
      this._session.cancel();
      this._setModeStatus(this._currentMode);
    });

    this._bus.on('settings:translationEnabled', ({ enabled }) => {
      this._logger.clog(`translationEnabled → ${enabled}`);
    });
  }

  _listenInjected() {
    window.addEventListener('nst_tracks', (e) => {
      let payload;
      try { payload = JSON.parse(e.detail); } catch (_) { return; }
      // Cache by movieId — Netflix fires the next video's manifest before the URL changes,
      // so we must not let a later manifest overwrite an earlier one we still need.
      if (payload.movieId) {
        this._manifestCache[payload.movieId] = payload.tracks;
        const ids = Object.keys(this._manifestCache);
        if (ids.length > 5) delete this._manifestCache[ids[0]];
      }
      this._handleTracks(payload.movieId, payload.tracks);
    });

    window.addEventListener('nst_src_lang', (e) => {
      let payload;
      try { payload = JSON.parse(e.detail); } catch (_) { return; }
      const { lang } = payload;
      if (!lang || lang === this._srcLang) return;
      if (!this._isOnWatchPage()) return;
      this._logger.clog(`Src lang detected: ${this._srcLang} \u2192 ${lang}`);
      this._srcLang = lang;

      if (this._lastStatus?.state === 'done') {
        this._setStatus('done', `Using ${this._trackResolver.langLabel(this._srcLang, this._availableTracks)} as source`);
      }

      this._onLanguageChanged('srcLang');
    });
  }

  async _handleTracks(movieId, tracks) {
    if (!movieId || !tracks) return;
    const urlId = this._getMovieIdFromUrl();
    this._logger.clog(`handleTracks movieId=${movieId} urlId=${urlId} currentMovieId=${this._currentMovieId} onWatchPage=${this._isOnWatchPage()}`, this._stateSnapshot());

    if (!this._isOnWatchPage()) {
      this._logger.clog(`handleTracks ignored — not on watch page (url=${location.pathname})`);
      return;
    }

    // Ignore manifests for non-active movies (Netflix pre-fetch)
    if (urlId && String(movieId) !== String(urlId)) {
      this._logger.clog(`handleTracks ignored — pre-fetch guard (manifestId=${movieId} urlId=${urlId})`);
      return;
    }

    // Same movie: tracks may have been hydrated
    if (movieId === this._currentMovieId) {
      this._availableTracks = tracks;
      this._saveNetflixLangStatus(tracks);
      const { mode, ttmlLang } = this._trackResolver.determineMode(this._srcLang, this._settings.dstLang, this._availableTracks);
      if (mode !== this._currentMode || ttmlLang !== this._currentTtmlLang) {
        this._logger.clog(`Tracks hydrated \u2014 mode changed: ${this._currentMode} \u2192 ${mode}`);
        this._onLanguageChanged('hydration');
      }
      return;
    }

    this._currentMovieId = movieId;
    this._resetStateForNewVideo();
    this._availableTracks = tracks;
    this._saveNetflixLangStatus(tracks);

    this._logger.clog('Tracks received for movieId', movieId, '\u2014 langs:', tracks.map(t => t.language));
    this._setStatus('detected', `Found ${tracks.length} subtitle tracks`);

    this._queue.push(async () => {
      const { mode, ttmlLang, dstNotLoaded } = this._trackResolver.determineMode(this._srcLang, this._settings.dstLang, this._availableTracks);
      const ok = await this._applyMode(tracks, mode, ttmlLang);
      if (!ok) return;

      this._overlay.ensure();
      this._sync.start();

      const capturedMovieId = movieId;
      const startTime = await this._waitForPlaybackStart();
      if (this._currentMovieId !== capturedMovieId) return;
      if (!this._isOnWatchPage()) return;
      this._sync.videoEl = document.querySelector('video');
      this._nextWindowStart = startTime;

      if (this._needsAiTranslation && this._settings.translationEnabled) {
        const flashMsg = dstNotLoaded
          ? `"${this._trackResolver.langLabel(this._settings.dstLang, this._availableTracks)}" subtitle isn't loaded by Netflix yet \u2014 using AI translation instead`
          : 'AI translation active \u2014 uses AI tokens';
        const signal = this._session.start();
        this._initialTranslation(startTime, flashMsg, signal);
      } else {
        this._setModeStatus(mode);
      }
    });
  }

  _resetStateForNewVideo() {
    this._logger.clog(`resetStateForNewVideo (was currentMovieId=${this._currentMovieId})`, this._stateSnapshot());
    this._session.cancel();
    this._store.reset();
    this._nextWindowStart = 0; this._rollingWindowEnd = 0;
    this._currentMode = null; this._currentTtmlLang = null; this._needsAiTranslation = false;
    this._sync.stop();
    browser.storage.local.remove('netflixLangStatus');
  }

  _saveNetflixLangStatus(tracks) {
    const nativeAvailable = [];
    const needsSelection  = [];
    for (const track of tracks) {
      if (this._trackResolver.findTtmlUrl([track], track.language)) {
        nativeAvailable.push(track.language);
      } else {
        needsSelection.push(track.language);
      }
    }
    browser.storage.local.set({ netflixLangStatus: { nativeAvailable, needsSelection } });
  }

  async _applyMode(tracks, mode, ttmlLang) {
    this._logger.clog(`Applying mode=${mode} ttmlLang=${ttmlLang}`);
    const segments = await this._loader.load(tracks, ttmlLang, this._trackResolver);
    if (!segments) return false;

    this._store.load(segments);

    try {
      const res = await browser.runtime.sendMessage({ type: 'getCache', movieId: this._currentMovieId, dstLang: this._settings.dstLang });
      if (res?.ok && res.translations) {
        const count = this._store.applyTranslations(segments.map((_, i) => i), res.translations);
        if (count > 0) this._logger.clog(`Hydrated ${count} translations from cache`);
      }
    } catch (err) {
      this._logger.clog('Cache hydration failed:', err.message);
    }

    this._needsAiTranslation = (mode === 'ai');
    this._currentMode        = mode;
    this._currentTtmlLang    = ttmlLang;
    return true;
  }

  async _translateWindow(fromTime, toTime, signal) {
    if (!this._canTranslateNow()) return false;
    if (signal.aborted) return false;

    const keyCheck = await browser.runtime.sendMessage({ type: 'checkApiKey' });
    if (signal.aborted) return false;
    if (!keyCheck?.ok) {
      if (this._trackResolver.findTtmlUrl(this._availableTracks, this._settings.dstLang)) {
        this._onLanguageChanged('no-key-native-fallback');
      } else {
        const msg = 'No API key \u2014 open extension settings';
        this._setStatus('error', msg);
        if (this._settings.showNotice) this._overlay.showFlash(msg);
      }
      return false;
    }

    this._logger.clog(`Translating window ${this._fmt(fromTime)} \u2192 ${this._fmt(toTime)}`);
    const videoEl = this._sync.videoEl;
    const nowFmt = () => videoEl ? this._fmt(videoEl.currentTime) : this._fmt(fromTime);
    const srcLabel = this._trackResolver.langLabel(this._srcLang, this._availableTracks);

    const pending = this._store.pendingIndices(fromTime, toTime);

    if (pending.length === 0) {
      this._nextWindowStart = toTime;
      this._setStatus('done', `Up to ${this._fmt(toTime)} already translated (at ${nowFmt()})`);
      return true;
    }

    this._setStatus('translating', `Translating from ${srcLabel}\u2026 (at ${nowFmt()})`);

    let completed = 0;
    for (let b = 0; b < pending.length; b += BATCH_SIZE) {
      if (signal.aborted) return false;
      if (!this._canTranslateNow()) return false;

      const slice = pending.slice(b, b + BATCH_SIZE);
      const items = this._store.getItemsForIndices(slice);

      const requestId = `${this._currentMovieId}:${++this._aiRequestSeq}`;
      let response;
      try {
        this._logger.vlog('AI batch request', {
          movieId: this._currentMovieId,
          dstLang: this._settings.dstLang,
          requestId,
          indices: slice,
          count: items.length,
          first3: items.slice(0, 3),
        });
        response = await browser.runtime.sendMessage({
          type: 'translate', items, dstLang: this._settings.dstLang, movieId: this._currentMovieId, requestId,
        });
      } catch (err) {
        this._setStatus('error', 'Background error: ' + err.message);
        return false;
      }

      if (signal.aborted) return false;

      if (!response || !response.ok) {
        if (response?.error?.includes('No API key')) {
          this._setStatus('error', 'No API key \u2014 open extension settings');
          return false;
        }
        continue;
      }

      if (response.requestId !== requestId || response.movieId !== this._currentMovieId) {
        this._logger.clog('AI response ignored (stale)', { expect: requestId, got: response.requestId });
        continue;
      }

      this._logger.vlog('AI batch response', {
        requestId,
        count: response.count || Object.keys(response.translations || {}).length,
        first3: response.sample || [],
      });
      const map = response.translations || {};
      this._store.applyTranslations(slice, map);

      completed += slice.length;
      this._setStatus('translating', `Translating from ${srcLabel}\u2026 (at ${nowFmt()}) ${completed}/${pending.length}`);
    }

    if (signal.aborted) return false;
    this._nextWindowStart = Math.max(this._nextWindowStart, toTime);
    this._setStatus('done', `Translated up to ${this._fmt(toTime)} (at ${nowFmt()})`);
    return true;
  }

  async _initialTranslation(startTime, flashMsg, signal) {
    if (signal.aborted) return;
    if (!this._canTranslateNow()) {
      this._setModeStatus(this._currentMode);
      return;
    }

    // Reserve the rolling window slot synchronously (before any await) so the
    // tick cannot fire duplicate rolling windows while the key check is in-flight.
    const duration = this._sync.videoEl?.duration || Infinity;
    const windowEnd = Math.min(startTime + this._settings.windowMinutes * 60, duration);
    this._rollingWindowEnd = windowEnd;

    // Check API key before showing the "AI translation active" notice —
    // avoids a misleading flash when no key is configured.
    const keyCheck = await browser.runtime.sendMessage({ type: 'checkApiKey' });
    if (signal.aborted) return;
    if (!keyCheck?.ok) {
      // If the dst lang is now natively available (e.g. tracks hydrated since
      // _determineMode ran), switch to native mode instead of showing an error.
      if (this._trackResolver.findTtmlUrl(this._availableTracks, this._settings.dstLang)) {
        this._onLanguageChanged('no-key-native-fallback');
      } else {
        const msg = 'No API key \u2014 open extension settings';
        this._setStatus('error', msg);
        if (this._settings.showNotice) this._overlay.showFlash(msg);
      }
      return;
    }

    try {
      const msg = flashMsg || 'AI translation active \u2014 uses AI tokens';
      this._setStatus('ai_notice', msg);
      if (this._settings.showNotice) this._overlay.showFlash(msg);

      const stages = [startTime + 30, startTime + 120, windowEnd];
      let prev = startTime;
      for (const to of stages) {
        if (signal.aborted) return;
        const clampedTo = Math.min(to, windowEnd);
        if (clampedTo <= prev) continue;
        const ok = await this._translateWindow(prev, clampedTo, signal);
        if (!ok) break;
        prev = clampedTo;
        if (prev >= windowEnd) break;
      }
    } finally {
      // Only let the active session hand off to the tick's rolling window.
      // Aborted (cancelled) sessions must not reset rollingWindowEnd, as that
      // would undo what the newly-active session already set synchronously.
      if (!signal.aborted && this._nextWindowStart < windowEnd) {
        this._rollingWindowEnd = this._nextWindowStart;
      }
    }
  }

  _stateSnapshot() {
    const video = this._sync.videoEl || document.querySelector('video');
    return {
      url:              location.pathname,
      currentMovieId:   this._currentMovieId,
      currentMode:      this._currentMode,
      needsAiTranslation: this._needsAiTranslation,
      translationEnabled: this._settings.translationEnabled,
      srcLang:          this._srcLang,
      dstLang:          this._settings.dstLang,
      nextWindowStart:  this._nextWindowStart,
      rollingWindowEnd: this._rollingWindowEnd,
      sessionAborted:   this._session.signal?.aborted ?? null,
      lastStatus:       this._lastStatus,
      manifestCache:    Object.keys(this._manifestCache),
      tracks:           this._availableTracks.map(t => t.language),
      segments:         this._store.getOriginal().length,
      video: video ? {
        currentTime: +video.currentTime.toFixed(2),
        duration:    +video.duration?.toFixed(2),
        paused:      video.paused,
        ended:       video.ended,
        readyState:  video.readyState,
      } : null,
    };
  }

  _setStatus(state, message) {
    this._lastStatus = { state, message };
    browser.storage.local.set({ translationStatus: { state, message, ts: Date.now() } });
  }

  _setModeStatus(mode) {
    this._setStatus('done', mode === 'native' ? 'Using Netflix native subtitles'
      : mode === 'passthrough' ? 'Source and destination are the same language'
      : 'AI translation active');
  }

  _onLanguageChanged(reason) {
    if (!this._isOnWatchPage()) return;
    if (!this._availableTracks.length || !this._currentMovieId) return;
    this._logger.clog(`Language changed (${reason}), re-evaluating mode`);
    this._bus.emit('lang:changed', { reason });
  }

  _readSyncState() {
    return {
      needsAiTranslation: this._needsAiTranslation,
      translationEnabled: this._settings.translationEnabled,
      nextWindowStart:    this._nextWindowStart,
      rollingWindowEnd:   this._rollingWindowEnd,
      windowMinutes:      this._settings.windowMinutes,
      signal:             this._session.signal,
      showOriginalText:   this._settings.showOriginalText,
    };
  }

  _waitForPlaybackStart() {
    return new Promise(resolve => {
      const MAX_MS = 5000, INTERVAL = 150, began = Date.now();
      const check = () => {
        const video = document.querySelector('video');
        if (video && video.currentTime > 1) {
          this._logger.clog(`waitForPlaybackStart resolved at ${this._fmt(video.currentTime)}`);
          resolve(video.currentTime); return;
        }
        if (Date.now() - began >= MAX_MS) {
          const t = video ? video.currentTime : 0;
          this._logger.clog(`waitForPlaybackStart timed out, currentTime=${this._fmt(t)} hasVideo=${!!video}`);
          resolve(t); return;
        }
        setTimeout(check, INTERVAL);
      };
      check();
    });
  }

  _isOnWatchPage() { return location.pathname.startsWith('/watch'); }

  _isVideoPlaying() {
    const v = this._sync.videoEl;
    return !!(v && !v.paused && !v.ended && v.readyState >= 2);
  }

  _canTranslateNow() { return this._isOnWatchPage() && this._isVideoPlaying(); }

  _getMovieIdFromUrl() {
    const m = location.pathname.match(/\/watch\/(\d+)/);
    return m ? m[1] : null;
  }

  _fmt(s) {
    return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  }
}

new SubtitleController();
