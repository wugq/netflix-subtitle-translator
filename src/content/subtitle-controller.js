'use strict';

const BATCH_SIZE = 50;

class SubtitleController {
  constructor() {
    this._logger  = new Logger();
    this._bus     = new EventBus();
    this._queue   = new SerialQueue();
    this._session = new TranslationSession();
    this._store   = new SegmentStore();
    this._overlay = new SubtitleOverlay();

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
    this._manifestCacheOrder = [];
    this._persistedManifestIds = new Set();

    this._currentMovieId       = null;
    this._urlIdMissingManifest = false; // true when URL is a Netflix alias (no manifest for urlId)
    this._srcLang              = 'en';
    this._availableTracks     = [];
    this._currentMode         = null;
    this._currentTtmlLang     = null;
    this._needsAiTranslation  = false;

    this._nextWindowStart = 0;
    this._rollingWindowEnd = 0;
    this._aiRequestSeq    = 0;

    this._lastStatus = null;
    this._compatWatchdog = null;

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
    const script = document.createElement('script');
    script.src = browser.runtime.getURL('src/injected.js');
    script.onload = () => script.remove();
    (document.head || document.documentElement).prepend(script);

    if (!this._isOnWatchPage()) {
      this._setStatus('idle', 'Waiting for a video to play\u2026');
    } else {
      this._startCompatWatchdog();
    }

    this._settings.load();
    this._loadPersistentManifestCache();

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
      const routeMovieId = this._getRouteMovieId();
      this._urlIdMissingManifest = false;
      const cachedIds  = Object.keys(this._manifestCache);
      this._logger.vlog(`onNav url=${location.pathname} routeMovieId=${routeMovieId} currentMovieId=${this._currentMovieId} manifestCache=[${cachedIds}]`);
      if (!this._isOnWatchPage() || !routeMovieId) {
        this._clearCompatWatchdog();
        browser.storage.local.remove('netflixLangStatus');
        if (this._currentMovieId) {
          this._currentMovieId = null;
          this._resetStateForNewVideo();
        }
        return;
      }
      if (String(routeMovieId) === String(this._currentMovieId)) return;
      const tracks = this._manifestCache[routeMovieId];
      if (tracks) {
        this._clearCompatWatchdog();
        const src = this._persistedManifestIds.has(String(routeMovieId)) ? 'persistent storage' : 'live session';
        this._logger.vlog(`Re-processing cached manifest (${src}) after SPA navigation → movieId=${routeMovieId}`);
        this._handleTracks(routeMovieId, tracks);
      } else {
        this._logger.vlog(`onNav — no cached manifest for routeMovieId=${routeMovieId}`);
        this._startCompatWatchdog();
        // Ask injected.js to re-dispatch nst_tracks from its own in-memory map.
        // This handles repeat navigation where Netflix never re-fetches (and thus
        // never re-parses) the manifest, so JSON.parse intercept won't fire again.
        window.dispatchEvent(new CustomEvent('nst_request_tracks', {
          detail: JSON.stringify({ movieId: routeMovieId }),
        }));
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
        this._logger.clog(`playback:seeked → ${fmtTime(time)}, starting translation`);
        this._initialTranslation(time, null, this._session.start());
      } else {
        this._logger.clog(`playback:seeked → ${fmtTime(time)}, no translation (needsAi=${this._needsAiTranslation} enabled=${this._settings.translationEnabled})`);
      }
    });

    this._bus.on('playback:play', ({ time }) => {
      this._nextWindowStart = time;
      if (this._needsAiTranslation && this._settings.translationEnabled) {
        this._logger.clog(`playback:play at ${fmtTime(time)}, starting translation`);
        this._initialTranslation(time, null, this._session.start());
      } else {
        this._logger.clog(`playback:play at ${fmtTime(time)}, no translation (needsAi=${this._needsAiTranslation} enabled=${this._settings.translationEnabled})`);
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
      this._clearCompatWatchdog();
      let payload;
      try { payload = JSON.parse(e.detail); } catch (_) {
        this._logger.vlog('nst_tracks received but JSON.parse failed');
        return;
      }
      this._logger.vlog(`nst_tracks received movieId=${payload.movieId} trackCount=${payload.tracks?.length ?? 'null'} url=${location.pathname}`);
      // Cache by movieId — Netflix fires the next video's manifest before the URL changes,
      // so we must not let a later manifest overwrite an earlier one we still need.
      if (payload.movieId) {
        this._rememberManifest(payload.movieId, payload.tracks);
        this._saveManifestCache();
      }
      this._handleTracks(payload.movieId, payload.tracks);
    });

    // injected.js sends this when nst_request_tracks found no manifest for a movieId.
    // It means the URL's movieId is a Netflix alias — relax the pre-fetch guard once
    // so the canonical manifest (which will arrive via nst_tracks) can be accepted.
    window.addEventListener('nst_no_tracks', (e) => {
      let payload;
      try { payload = JSON.parse(e.detail); } catch (_) { return; }
      if (String(payload.movieId) === this._getRouteMovieId()) {
        this._logger.vlog(`nst_no_tracks for urlId=${payload.movieId} — pre-fetch guard relaxed (URL alias)`);
        this._urlIdMissingManifest = true;
      }
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
    if (!movieId || !tracks) {
      this._logger.vlog(`handleTracks ignored — missing movieId or tracks (movieId=${movieId} tracks=${tracks?.length ?? 'null'})`);
      return;
    }
    const urlId = this._getRouteMovieId();
    this._logger.vlog(`handleTracks movieId=${movieId} urlId=${urlId} currentMovieId=${this._currentMovieId} onWatchPage=${this._isOnWatchPage()}`);

    if (!this._isOnWatchPage()) {
      this._logger.vlog(`handleTracks ignored — not on watch page (url=${location.pathname})`);
      return;
    }

    // Ignore manifests for non-active movies (Netflix pre-fetch).
    // Exception: if injected.js signalled it has no manifest for urlId, this is a
    // Netflix alias URL — accept the first incoming manifest as the real video.
    if (urlId && String(movieId) !== String(urlId)) {
      if (!this._urlIdMissingManifest) {
        this._logger.vlog(`handleTracks ignored — pre-fetch guard (manifestId=${movieId} urlId=${urlId})`);
        return;
      }
      this._urlIdMissingManifest = false; // consumed — only relax once per navigation
      this._logger.vlog(`handleTracks — URL alias accepted: movieId=${movieId} for urlId=${urlId}`);
    }

    // Same movie: tracks may have been hydrated.
    // Always compare as strings — movieId from nst_tracks (JSON number) vs
    // routeMovieId from regex capture (string) would fail strict equality.
    if (String(movieId) === this._currentMovieId) {
      this._availableTracks = tracks;
      this._saveNetflixLangStatus(tracks);
      const { mode, ttmlLang } = this._trackResolver.determineMode(this._srcLang, this._settings.dstLang, this._availableTracks);
      if (mode !== this._currentMode || ttmlLang !== this._currentTtmlLang) {
        this._logger.clog(`Tracks hydrated \u2014 mode changed: ${this._currentMode} \u2192 ${mode}`);
        this._onLanguageChanged('hydration');
      }
      return;
    }

    this._currentMovieId = String(movieId);
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

      const capturedMovieId = this._currentMovieId; // capture string form; movieId from nst_tracks is a JSON number
      const startTime = await this._waitForPlaybackStart();
      if (this._currentMovieId !== capturedMovieId) return;
      if (!this._isOnWatchPage()) return;
      this._sync.videoEl = document.querySelector('video');
      // Use Math.max to preserve a later seek position set by playback:seeked
      // while _waitForPlaybackStart was in flight.
      this._nextWindowStart = Math.max(this._nextWindowStart, startTime);

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

  async _loadPersistentManifestCache() {
    try {
      const res = await browser.storage.local.get('nstManifestCache');
      const saved = res?.nstManifestCache;
      if (saved && typeof saved === 'object') {
        const ids = Object.keys(saved);
        for (const id of ids) {
          if (!this._manifestCache[id]) {
            this._manifestCache[id] = saved[id];
            this._manifestCacheOrder.push(String(id));
            this._persistedManifestIds.add(id);
          }
        }
        if (ids.length > 0) {
          this._logger.vlog(`Loaded ${ids.length} manifests from persistent storage: [${ids}]`);
        }
      }
    } catch (err) {
      this._logger.vlog(`Failed to load persistent manifest cache: ${err.message}`);
    }
  }

  _saveManifestCache() {
    try {
      // Persist up to 50 most-recent manifests so re-navigation to previously-watched
      // videos works even after content script reload or in-memory cache eviction.
      const keep = this._manifestCacheOrder.slice(-50);
      const toSave = {};
      for (const id of keep) toSave[id] = this._manifestCache[id];
      browser.storage.local.set({ nstManifestCache: toSave });
    } catch (err) {
      this._logger.vlog('Failed to save manifest cache: ' + err.message);
    }
  }

  _resetStateForNewVideo() {
    this._logger.vlog(`resetStateForNewVideo (was currentMovieId=${this._currentMovieId})`);
    this._session.cancel();
    this._store.reset();
    this._nextWindowStart = 0; this._rollingWindowEnd = 0;
    this._currentMode = null; this._currentTtmlLang = null; this._needsAiTranslation = false;
    this._sync.stop();
    this._overlay.destroy();
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

    this._logger.clog(`Translating window ${fmtTime(fromTime)} \u2192 ${fmtTime(toTime)}`);
    const videoEl = this._sync.videoEl;
    const nowFmt = () => videoEl ? fmtTime(videoEl.currentTime) : fmtTime(fromTime);
    const srcLabel = this._trackResolver.langLabel(this._srcLang, this._availableTracks);

    const pending = this._store.pendingIndices(fromTime, toTime);

    if (pending.length === 0) {
      this._nextWindowStart = toTime;
      this._setStatus('done', `Up to ${fmtTime(toTime)} already translated (at ${nowFmt()})`);
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
        this._logger.clog('AI batch failed, skipping slice', { requestId, error: response?.error });
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
    this._setStatus('done', `Translated up to ${fmtTime(toTime)} (at ${nowFmt()})`);
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

  _startCompatWatchdog() {
    this._clearCompatWatchdog();
    this._compatWatchdog = setTimeout(() => {
      this._compatWatchdog = null;
      browser.storage.local.set({ nstCompatWarning: true });
    }, 15000);
  }

  _clearCompatWatchdog() {
    if (this._compatWatchdog) {
      clearTimeout(this._compatWatchdog);
      this._compatWatchdog = null;
    }
    browser.storage.local.remove('nstCompatWarning');
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
      const video = document.querySelector('video');
      if (video && !video.paused) {
        this._logger.clog(`waitForPlaybackStart resolved immediately at ${fmtTime(video.currentTime)}`);
        resolve(video.currentTime);
        return;
      }

      const done = (v) => {
        cleanup();
        const t = v ? v.currentTime : 0;
        this._logger.clog(`waitForPlaybackStart resolved at ${fmtTime(t)}`);
        resolve(t);
      };

      const onPlay = (e) => done(e.target);

      const cleanup = () => {
        clearTimeout(fallback);
        document.removeEventListener('play',    onPlay, true);
        document.removeEventListener('playing', onPlay, true);
      };

      document.addEventListener('play',    onPlay, true);
      document.addEventListener('playing', onPlay, true);

      // Fallback in case playback never starts (e.g. user keeps video paused).
      const fallback = setTimeout(() => done(document.querySelector('video')), 10000);
    });
  }

  _isOnWatchPage() { return !!this._getRouteMovieId(); }

  _isVideoPlaying() {
    const v = this._sync.videoEl;
    return !!(v && !v.paused && !v.ended && v.readyState >= 2);
  }

  _canTranslateNow() { return this._isOnWatchPage() && this._isVideoPlaying(); }

  _getRouteMovieId() {
    const m = location.pathname.match(/\/watch\/(\d+)/);
    return m ? m[1] : null;
  }

  _rememberManifest(movieId, tracks) {
    const id = String(movieId);
    this._manifestCache[id] = tracks;
    this._persistedManifestIds.delete(id); // now a live entry

    this._manifestCacheOrder = this._manifestCacheOrder.filter(existingId => existingId !== id);
    this._manifestCacheOrder.push(id);

    while (this._manifestCacheOrder.length > 50) {
      const evictedId = this._manifestCacheOrder.shift();
      delete this._manifestCache[evictedId];
      this._persistedManifestIds.delete(evictedId);
    }
  }

}

new SubtitleController();
