// content.js — injects page-context script, receives subtitle URLs, fetches,
// parses TTML locally, determines translation mode, and renders a custom overlay.
'use strict';

if (typeof browser === 'undefined') {
  var browser = chrome;
}

const APP_NAME = 'Netflix Subtitle Translator';
let consoleLogging = false;  // minimal key events → browser console
let verboseLogging = false;  // detailed trace → options page log buffer

function formatLogArgs(args) {
  return args.map(a => {
    if (typeof a === 'string') return a;
    try { return JSON.stringify(a); } catch (_) { return String(a); }
  }).join(' ');
}

function logToMemory(message) {
  if (!verboseLogging) return;
  try {
    browser.runtime.sendMessage({ type: 'log', source: 'content', message });
  } catch (_) {}
}

// CLOG: minimal console log for key events
const CLOG = (...a) => { if (consoleLogging) console.log(`[${APP_NAME}]`, ...a); };
// VLOG: verbose log → memory buffer only (shown in options page, not in console)
const VLOG = (...a) => {
  if (!verboseLogging) return;
  logToMemory(formatLogArgs(a));
};

// ---------------------------------------------------------------------------
// Primitives: EventBus, SerialQueue, TranslationSession, SegmentStore
// ---------------------------------------------------------------------------

const EventBus = (() => {
  const listeners = Object.create(null);
  return {
    on(event, fn)  { (listeners[event] || (listeners[event] = [])).push(fn); },
    off(event, fn) { if (listeners[event]) listeners[event] = listeners[event].filter(f => f !== fn); },
    emit(event, payload) {
      const fns = listeners[event];
      if (fns) for (const fn of fns.slice()) try { fn(payload); } catch (e) { console.error('[NST]', e); }
    },
  };
})();

const SerialQueue = (() => {
  let running = false, pending = null;
  async function drain() {
    while (pending) {
      const { fn } = pending; pending = null;
      try { await fn(); } catch (e) { console.error('[NST SerialQueue]', e); }
    }
    running = false;
  }
  return {
    push(fn) {
      pending = { fn };
      if (!running) { running = true; drain(); }
    },
    get isRunning() { return running; },
  };
})();

const TranslationSession = (() => {
  let current = null;
  return {
    start()  { if (current) current.abort(); current = new AbortController(); return current.signal; },
    cancel() { if (current) { current.abort(); current = null; } },
    get signal() { return current ? current.signal : null; },
  };
})();

const SegmentStore = (() => {
  let _orig = [], _overlay = [], _done = [];
  return {
    load(segs)   { _orig = segs.map(s=>({...s})); _overlay = segs.map(s=>({...s})); _done = new Array(segs.length).fill(false); },
    reset()      { _orig = []; _overlay = []; _done = []; },
    getOverlay() { return _overlay; },
    getOriginal(){ return _orig; },
    pendingIndices(from, to) {
      return _overlay.reduce((a, s, i) => (!_done[i] && s.end > from && s.begin < to) ? [...a, i] : a, []);
    },
    applyTranslations(indices, map) {
      let n = 0;
      for (const i of indices) {
        const key = _orig[i]?.key || _overlay[i]?.key || `idx-${i}`;
        if (typeof map[key] === 'string') { _overlay[i] = {..._overlay[i], text: map[key]}; _done[i] = true; n++; }
      }
      return n;
    },
    getItemsForIndices(indices) {
      return indices.map(i => ({ key: _orig[i]?.key || _overlay[i]?.key || `idx-${i}`, text: _orig[i]?.text || _overlay[i]?.text }));
    },
  };
})();

// ---------------------------------------------------------------------------
// EventBus wiring (one-time setup — handlers defined later in the file but
// registered here so the wiring is co-located with the bus declaration)
// ---------------------------------------------------------------------------
EventBus.on('lang:changed', ({ reason }) => {
  SerialQueue.push(async () => {
    if (!isOnWatchPage() || !currentMovieId || !availableTracks.length) return;
    const { mode, ttmlLang, dstNotLoaded } = determineMode();
    TranslationSession.cancel();
    const ok = await applyMode(availableTracks, mode, ttmlLang);
    if (!ok) return;

    ensureOverlay();
    
    // No recheck needed — if another lang:changed arrived during applyMode(),
    // SerialQueue already has it pending and drain() will run it next.
    const t = videoEl?.currentTime ?? 0;
    nextWindowStart = t; rollingWindowEnd = 0;
    if (needsAiTranslation && translationEnabled && canTranslateNow()) {
      const signal = TranslationSession.start();
      initialTranslation(t, dstNotLoaded ? `"${langLabel(dstLang)}" subtitle isn't loaded by Netflix yet — using AI translation instead` : null, signal);
    } else {
      setModeStatus(mode);
    }
  });
});

EventBus.on('playback:seeked', ({ time }) => {
  if (needsAiTranslation && translationEnabled && canTranslateNow())
    initialTranslation(time, null, TranslationSession.start());
});
EventBus.on('playback:play', ({ time }) => {
  if (needsAiTranslation && translationEnabled)
    initialTranslation(time, null, TranslationSession.start());
  else setStatus('done', 'Playback resumed');
});
EventBus.on('playback:pause', () => { TranslationSession.cancel(); setStatus('done', 'Translation paused — playback paused'); });
EventBus.on('settings:translationEnabled', ({ enabled }) => { translationEnabled = enabled; applyTranslationEnabled(); });
EventBus.on('settings:style', () => applyOverlayStyle());

const TTML_NS = 'http://www.w3.org/ns/ttml';
const TTML_PARAM_NS = 'http://www.w3.org/ns/ttml#parameter';

const LOOKAHEAD_SECONDS = 60;
const BATCH_SIZE        = 50;

// ---------------------------------------------------------------------------
// 1. Inject injected.js into page context
// ---------------------------------------------------------------------------
const script = document.createElement('script');
script.src = browser.runtime.getURL('src/injected.js');
script.onload = () => script.remove();
(document.head || document.documentElement).prepend(script);

// ---------------------------------------------------------------------------
// 2. State
// ---------------------------------------------------------------------------
let currentMovieId      = null;
let nextWindowStart     = 0;
let rollingWindowEnd    = 0;
let windowMinutes       = 5;
let overlayEl           = null;
let fullscreenHandler   = null;
let rafId               = null;
let videoEl             = null;
let seekedHandler       = null;
let playHandler         = null;
let pauseHandler        = null;
let lastRenderedText    = null;
let lastVerboseLogTime  = -1;
let aiRequestSeq        = 0;
let lastWatchPageState  = null;  // tracks page-state to avoid redundant status writes

// Language state
let srcLang            = 'en';       // detected from Netflix player (fetch interception)
let dstLang            = 'zh-Hans';  // user's chosen destination language
let availableTracks    = [];         // all tracks from the manifest
let currentMode        = null;       // 'passthrough' | 'native' | 'ai'
let currentTtmlLang    = null;       // which language's TTML is currently loaded
let needsAiTranslation = false;      // false for passthrough / native modes

// Display settings
let subtitleFontSize   = 24;
let subtitleBottom     = 8;
let translationEnabled = true;
let showAiNotice       = true;

// Clear stale status immediately if not on a watch page
if (!isOnWatchPage()) {
  setStatus('idle', 'Waiting for a video to play…');
}

// Load persisted settings
browser.storage.local.get([
  'subtitleFontSize', 'subtitleBottom', 'windowMinutes', 'translationEnabled', 'dstLang',
  'showAiNotice', 'consoleLogging', 'verboseLogging',
]).then(r => {
  if (r.subtitleFontSize   != null) subtitleFontSize   = r.subtitleFontSize;
  if (r.subtitleBottom     != null) subtitleBottom     = r.subtitleBottom;
  if (r.windowMinutes      != null) windowMinutes      = r.windowMinutes;
  if (r.translationEnabled != null) translationEnabled = r.translationEnabled;
  if (r.dstLang            != null) dstLang            = r.dstLang;
  if (r.showAiNotice       != null) showAiNotice       = r.showAiNotice;
  if (r.consoleLogging     != null) consoleLogging     = r.consoleLogging;
  if (r.verboseLogging     != null) verboseLogging     = r.verboseLogging;
  applyOverlayStyle();
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  let styleChanged = false;
  if ('subtitleFontSize' in changes) { subtitleFontSize = changes.subtitleFontSize.newValue; styleChanged = true; }
  if ('subtitleBottom'   in changes) { subtitleBottom   = changes.subtitleBottom.newValue;   styleChanged = true; }
  if ('windowMinutes'      in changes) windowMinutes    = changes.windowMinutes.newValue;
  if ('translationEnabled' in changes) {
    translationEnabled = changes.translationEnabled.newValue;
    EventBus.emit('settings:translationEnabled', { enabled: translationEnabled });
  }
  if ('dstLang' in changes) {
    dstLang = changes.dstLang.newValue;
    onLanguageChanged('dstLang');
  }
  if ('showAiNotice'   in changes) showAiNotice   = changes.showAiNotice.newValue;
  if ('consoleLogging' in changes) consoleLogging = changes.consoleLogging.newValue;
  if ('verboseLogging' in changes) verboseLogging = changes.verboseLogging.newValue;
  if (styleChanged) EventBus.emit('settings:style');
});

// ---------------------------------------------------------------------------
// 3. Language utilities
// ---------------------------------------------------------------------------

// Loose BCP-47 match: 'en' matches 'en-US', 'zh-Hans' matches 'zh-Hans-SG'
// Netflix always uses standard BCP-47 codes in track.language.
function langMatches(a, b) {
  if (!a || !b) return false;
  const la = a.toLowerCase(), lb = b.toLowerCase();
  return la === lb || la.startsWith(lb + '-') || lb.startsWith(la + '-');
}

// Return the human-readable label for a language code using Netflix's own
// languageDescription from the track list, falling back to the code itself.
function langLabel(code) {
  const track = availableTracks.find(t => langMatches(t.language, code));
  return track?.languageDescription || code;
}

// Find TTML URL for a given language code from the track list.
// Tries formats in priority order.
function findTtmlUrl(tracks, langCode) {
  const FORMATS = ['imsc1.1', 'dfxp-ls-sdh', 'simplesdh', 'nflx-cmisc', 'dfxp'];
  const candidates = tracks.filter(t => langMatches(t.language, langCode));
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

// Determine translation mode from current srcLang / dstLang / availableTracks.
//   passthrough — src == dst, show source TTML directly, no AI
//   native      — dst has a downloadable TTML in Netflix, use it directly, no AI
//   ai          — use AI; prefer English as input, fall back to srcLang
// Note: a track may exist in the manifest but have no downloadable TTML URL
// (Netflix lists it as an option but serves no file). We check for an actual
// URL to avoid entering native mode and then failing silently.
function determineMode() {
  if (langMatches(srcLang, dstLang)) {
    return { mode: 'passthrough', ttmlLang: srcLang };
  }
  if (findTtmlUrl(availableTracks, dstLang)) {
    return { mode: 'native', ttmlLang: dstLang };
  }
  // Track exists in Netflix's list but subtitle file isn't loaded yet
  const dstListed = availableTracks.some(t => langMatches(t.language, dstLang));
  const ttmlLang  = findTtmlUrl(availableTracks, 'en') ? 'en' : srcLang;
  return { mode: 'ai', ttmlLang, dstNotLoaded: dstListed };
}

// ---------------------------------------------------------------------------
// 4. TTML parsing
// ---------------------------------------------------------------------------
function parseTtmlTime(t, params) {
  if (!t) return 0;
  const tickRate = params?.tickRate || 10000000;
  const frameRate = params?.frameRate || 30;

  // clock-time: hh:mm:ss.ms or hh:mm:ss:ff
  const m = t.match(/^(\d+):(\d+):(\d+(?:\.\d+)?)$/);
  if (m) return +m[1] * 3600 + +m[2] * 60 + +m[3];
  
  const m2 = t.match(/^(\d+):(\d+(?:\.\d+)?)$/);
  if (m2) return +m2[1] * 60 + +m2[2];
  
  const m3 = t.match(/^(\d+):(\d+):(\d+):(\d+)$/);
  if (m3) return +m3[1] * 3600 + +m3[2] * 60 + +m3[3] + (+m3[4] / frameRate);

  // offset-time: value+unit
  const unit = t.match(/^(\d+(?:\.\d+)?)(h|m|s|ms|f|t)$/);
  if (unit) {
    const v = parseFloat(unit[1]);
    const u = unit[2];
    if (u === 'h')  return v * 3600;
    if (u === 'm')  return v * 60;
    if (u === 's')  return v;
    if (u === 'ms') return v / 1000;
    if (u === 'f')  return v / frameRate;
    if (u === 't')  return v / tickRate;
  }

  // Pure digits: assume ticks if no unit, or just float
  return parseFloat(t) / tickRate;
}

function nodeToText(node) {
  let out = '';
  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      out += child.nodeValue;
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      if (child.localName === 'br') out += '\n';
      else out += nodeToText(child);
    }
  }
  return out;
}

function parseTtml(xmlString) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlString, 'application/xml');
  const err = doc.querySelector('parsererror');
  if (err) throw new Error('XML parse error: ' + err.textContent.slice(0, 100));

  const tt = doc.getElementsByTagNameNS(TTML_NS, 'tt')[0];
  const ttp = (ns, name) => tt?.getAttributeNS(ns, name) || tt?.getAttribute(`ttp:${name}`) || tt?.getAttribute(name);

  const tickRate = parseInt(ttp(TTML_PARAM_NS, 'tickRate') || '10000000', 10);
  const frameRate = parseFloat(ttp(TTML_PARAM_NS, 'frameRate') || '30');
  const frameRateMultiplierRaw = ttp(TTML_PARAM_NS, 'frameRateMultiplier') || '';
  
  let frameRateMultiplier = 1;
  if (frameRateMultiplierRaw) {
    const parts = frameRateMultiplierRaw.trim().split(/\s+/).map(Number);
    if (parts.length === 2 && parts[0] && parts[1]) frameRateMultiplier = parts[0] / parts[1];
  }

  const params = {
    tickRate,
    frameRate: frameRate * frameRateMultiplier,
    timeBase: ttp(TTML_PARAM_NS, 'timeBase') || 'media',
  };

  // ttp:presentationTimeOffset — some Netflix assets use this to shift the zero-point.
  // It should be subtracted from all absolute times.
  const presentationTimeOffset = parseTtmlTime(ttp(TTML_PARAM_NS, 'presentationTimeOffset') || '0', params);

  // Accumulate begin offset from ancestor elements.
  // In TTML, times on <p> are relative to the parent container's begin time.
  function getAbsoluteOffset(el) {
    let offset = 0;
    let curr = el.parentElement;
    while (curr && curr !== tt) {
      const b = curr.getAttribute('begin');
      if (b) offset += parseTtmlTime(b, params);
      curr = curr.parentElement;
    }
    return offset;
  }

  VLOG('TTML timing params', { ...params, presentationTimeOffset });

  const ps = doc.getElementsByTagNameNS(TTML_NS, 'p');
  const segments = [];
  let pIndex = 0;

  for (const p of ps) {
    const text = nodeToText(p).trim();
    if (!text) continue;

    const beginAttr = p.getAttribute('begin');
    const endAttr   = p.getAttribute('end');
    const durAttr   = p.getAttribute('dur');
    if (!beginAttr && !endAttr && !durAttr) continue;

    const containerOffset = getAbsoluteOffset(p);
    let begin = beginAttr ? parseTtmlTime(beginAttr, params) + containerOffset : containerOffset;
    let end   = endAttr   ? parseTtmlTime(endAttr,   params) + containerOffset : null;

    if (end === null && durAttr) {
      end = begin + parseTtmlTime(durAttr, params);
    }

    if (begin === null || end === null) continue;

    // Apply global presentation offset
    begin -= presentationTimeOffset;
    end   -= presentationTimeOffset;

    const idAttr = p.getAttribute('xml:id') || p.getAttribute('id');
    const key = `${idAttr || 'p' + pIndex}|${beginAttr || ''}|${endAttr || ''}|${durAttr || ''}`;

    segments.push({ id: idAttr || null, key, begin, end, text });
    pIndex++;
  }

  segments.sort((a, b) => a.begin - b.begin);
  return segments;
}

// ---------------------------------------------------------------------------
// 4.5. Playback / page state helpers
// ---------------------------------------------------------------------------
function getMovieIdFromUrl() {
  const m = location.pathname.match(/\/watch\/(\d+)/);
  return m ? m[1] : null;
}

function isOnWatchPage() {
  return location.pathname.startsWith('/watch');
}

function isVideoPlaying() {
  return !!(videoEl && !videoEl.paused && !videoEl.ended && videoEl.readyState >= 2);
}

function canTranslateNow() {
  return isOnWatchPage() && isVideoPlaying();
}

function resetStateForNewVideo() {
  TranslationSession.cancel();
  SegmentStore.reset();
  nextWindowStart = 0; rollingWindowEnd = 0;
  currentMode = null; currentTtmlLang = null; needsAiTranslation = false;
  lastRenderedText = null; lastWatchPageState = null;
  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  if (videoEl) {
    if (seekedHandler) videoEl.removeEventListener('seeked', seekedHandler);
    if (playHandler)   videoEl.removeEventListener('play',   playHandler);
    if (pauseHandler)  videoEl.removeEventListener('pause',  pauseHandler);
  }
  seekedHandler = playHandler = pauseHandler = null;
  videoEl = null;
}

// ---------------------------------------------------------------------------
// 5. Fetch and parse TTML for a given language, return segments or null
// ---------------------------------------------------------------------------
async function fetchSegments(tracks, langCode) {
  const url = findTtmlUrl(tracks, langCode);
  if (!url) {
    setStatus('error', `No subtitle track for "${langCode}"`);
    return null;
  }
  let xml;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    xml = await res.text();
  } catch (err) {
    setStatus('error', 'Fetch failed: ' + err.message);
    return null;
  }
  try {
    const segs = parseTtml(xml);
    if (!segs.length) { setStatus('error', 'No subtitle segments found'); return null; }
    return segs;
  } catch (err) {
    setStatus('error', 'TTML parse failed: ' + err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// 6. Window-based AI translation
// ---------------------------------------------------------------------------
async function translateWindow(fromTime, toTime, signal) {
  if (!canTranslateNow()) return false;
  if (signal.aborted) return false;

  const keyCheck = await browser.runtime.sendMessage({ type: 'checkApiKey' });
  if (signal.aborted) return false;
  if (!keyCheck?.ok) {
    setStatus('error', 'No API key — open extension settings');
    return false;
  }

  CLOG(`Translating window ${fmt(fromTime)} → ${fmt(toTime)}`);
  const nowFmt = () => videoEl ? fmt(videoEl.currentTime) : fmt(fromTime);
  setStatus('translating', `Translating… (at ${nowFmt()})`);

  const pending = SegmentStore.pendingIndices(fromTime, toTime);

  if (pending.length === 0) {
    nextWindowStart = toTime;
    return true;
  }

  let completed = 0;
  for (let b = 0; b < pending.length; b += BATCH_SIZE) {
    if (signal.aborted) return false;
    if (!canTranslateNow()) return false;

    const slice = pending.slice(b, b + BATCH_SIZE);
    const items = SegmentStore.getItemsForIndices(slice);

    const requestId = `${currentMovieId}:${++aiRequestSeq}`;
    let response;
    try {
      VLOG('AI batch request', {
        movieId: currentMovieId,
        dstLang,
        requestId,
        indices: slice,
        count: items.length,
        first3: items.slice(0, 3),
      });
      response = await browser.runtime.sendMessage({
        type: 'translate', items, dstLang, movieId: currentMovieId, requestId,
      });
    } catch (err) {
      setStatus('error', 'Background error: ' + err.message);
      return false;
    }

    if (signal.aborted) return false;

    if (!response || !response.ok) {
      if (response?.error?.includes('No API key')) {
        setStatus('error', 'No API key — open extension settings');
        return false;
      }
      continue; // non-fatal — leave segment as source text
    }

    if (response.requestId !== requestId || response.movieId !== currentMovieId) {
      CLOG('AI response ignored (stale)', { expect: requestId, got: response.requestId });
      continue;
    }

    VLOG('AI batch response', {
      requestId,
      count: response.count || Object.keys(response.translations || {}).length,
      first3: response.sample || [],
    });
    const map = response.translations || {};
    SegmentStore.applyTranslations(slice, map);

    completed += slice.length;
    setStatus('translating', `Translating… (at ${nowFmt()}) ${completed}/${pending.length}`);
  }

  if (signal.aborted) return false;
  // Monotonic update — prevent stale concurrent calls from jumping backwards
  nextWindowStart = Math.max(nextWindowStart, toTime);
  setStatus('done', `Translated up to ${fmt(toTime)} (at ${nowFmt()})`);
  return true;
}

// Progressive 3-stage translation: 30s → 2min → full window.
// flashMsg: optional on-screen message to show when AI starts (respects showAiNotice setting).
async function initialTranslation(startTime, flashMsg, signal) {
  if (signal.aborted) return;
  if (!canTranslateNow()) {
    setStatus('done', 'Translation paused — playback not active');
    return;
  }
  const duration = videoEl?.duration || Infinity;
  const windowEnd = Math.min(startTime + windowMinutes * 60, duration);

  // Prevent tick() from interjecting while this progressive chain is running
  rollingWindowEnd = windowEnd;

  const msg = flashMsg || 'AI translation active — uses API tokens';
  setStatus('ai_notice', msg);
  if (showAiNotice) showFlashMessage(msg);

  const stages = [startTime + 30, startTime + 120, windowEnd];
  let prev = startTime;
  for (const to of stages) {
    if (signal.aborted) return;
    const clampedTo = Math.min(to, windowEnd);
    if (clampedTo <= prev) continue;
    const ok = await translateWindow(prev, clampedTo, signal);
    if (!ok) return;
    prev = clampedTo;
    if (prev >= windowEnd) break;
  }
}

function fmt(s) {
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// 7. Apply a new mode: fetch the right TTML and reset segment state
// ---------------------------------------------------------------------------
async function applyMode(tracks, mode, ttmlLang) {
  CLOG(`Applying mode=${mode} ttmlLang=${ttmlLang}`);
  const segments = await fetchSegments(tracks, ttmlLang);
  if (!segments) return false;

  SegmentStore.load(segments);

  // Hydrate from background cache
  try {
    const res = await browser.runtime.sendMessage({ type: 'getCache', movieId: currentMovieId });
    if (res?.ok && res.translations) {
      const count = SegmentStore.applyTranslations(
        segments.map((_, i) => i),
        res.translations
      );
      if (count > 0) CLOG(`Hydrated ${count} translations from cache`);
    }
  } catch (err) {
    CLOG('Cache hydration failed:', err.message);
  }

  needsAiTranslation = (mode === 'ai');
  currentMode        = mode;
  currentTtmlLang    = ttmlLang;
  return true;
}

// ---------------------------------------------------------------------------
// 8. Status helpers
// ---------------------------------------------------------------------------
function setModeStatus(mode) {
  setStatus('done', mode === 'native' ? 'Using Netflix native subtitles'
    : mode === 'passthrough' ? 'Source and destination are the same language'
    : 'Translation paused');
}

// ---------------------------------------------------------------------------
// 9. Listen for timedtexttracks from injected.js
// ---------------------------------------------------------------------------
window.addEventListener('nst_tracks', async (e) => {
  let payload;
  try { payload = JSON.parse(e.detail); } catch (_) { return; }

  const { movieId, tracks } = payload;
  if (!movieId) return;
  if (!isOnWatchPage()) return;

  // CRITICAL: Netflix often pre-fetches the manifest for the NEXT episode
  // several minutes before the current one ends. We must ignore it.
  const urlId = getMovieIdFromUrl();
  if (urlId && String(movieId) !== String(urlId)) {
    VLOG('Ignoring manifest for non-active movie (pre-fetch)', { manifestId: movieId, urlId });
    return;
  }

  // Same movie: tracks may have been hydrated (e.g. user selected a subtitle
  // in Netflix's player, which populates ttDownloadables for that track).
  // Re-evaluate mode — if we now have a native URL we didn't have before, switch.
  if (movieId === currentMovieId) {
    availableTracks = tracks;
    const { mode, ttmlLang } = determineMode();
    if (mode !== currentMode || ttmlLang !== currentTtmlLang) {
      CLOG(`Tracks hydrated — mode changed: ${currentMode} → ${mode}`);
      onLanguageChanged('hydration');
    }
    return;
  }

  currentMovieId  = movieId;
  resetStateForNewVideo();
  availableTracks = tracks;

  CLOG('Tracks received for movieId', movieId, '— langs:', tracks.map(t => t.language));
  setStatus('detected', `Found ${tracks.length} subtitle tracks`);

  SerialQueue.push(async () => {
    const { mode, ttmlLang, dstNotLoaded } = determineMode();
    const ok = await applyMode(tracks, mode, ttmlLang);
    if (!ok) return;

    ensureOverlay();
    startSync();

    const capturedMovieId = movieId;
    const startTime = await waitForPlaybackStart();
    if (currentMovieId !== capturedMovieId) return;
    if (!isOnWatchPage()) return;
    videoEl = document.querySelector('video');
    nextWindowStart = startTime;

    if (needsAiTranslation && translationEnabled) {
      const flashMsg = dstNotLoaded
        ? `"${langLabel(dstLang)}" subtitle isn't loaded by Netflix yet — using AI translation instead`
        : 'AI translation active — uses API tokens';
      const signal = TranslationSession.start();
      initialTranslation(startTime, flashMsg, signal);
    } else {
      setModeStatus(mode);
    }
  });
});

// ---------------------------------------------------------------------------
// 10. Listen for source language detection from injected.js
// ---------------------------------------------------------------------------
window.addEventListener('nst_src_lang', (e) => {
  let payload;
  try { payload = JSON.parse(e.detail); } catch (_) { return; }
  const { lang } = payload;
  if (!lang || lang === srcLang) return;
  if (!isOnWatchPage()) return;
  CLOG(`Src lang detected: ${srcLang} → ${lang}`);
  srcLang = lang;
  onLanguageChanged('srcLang');
});

// Re-evaluate and reload subtitles when src or dst language changes
function onLanguageChanged(reason) {
  if (!isOnWatchPage()) return;
  if (!availableTracks.length || !currentMovieId) return;
  CLOG(`Language changed (${reason}), re-evaluating mode`);
  EventBus.emit('lang:changed', { reason });
}

// ---------------------------------------------------------------------------
// 11. Playback start detection
// ---------------------------------------------------------------------------
function waitForPlaybackStart() {
  return new Promise(resolve => {
    const MAX_MS = 5000, INTERVAL = 150, began = Date.now();
    function check() {
      const video = document.querySelector('video');
      if (video && video.currentTime > 1) { resolve(video.currentTime); return; }
      if (Date.now() - began >= MAX_MS) { resolve(video ? video.currentTime : 0); return; }
      setTimeout(check, INTERVAL);
    }
    check();
  });
}

// ---------------------------------------------------------------------------
// 12. On-screen flash message
// ---------------------------------------------------------------------------
let flashTimeout = null;

function showFlashMessage(msg) {
  let el = document.getElementById('nst-flash');
  if (!el) {
    el = document.createElement('div');
    el.id = 'nst-flash';
    el.style.cssText = `
      position: fixed;
      top: 10%;
      left: 50%;
      transform: translateX(-50%);
      z-index: 2147483647;
      background: rgba(0,0,0,0.82);
      color: #ffcc80;
      font-family: 'Netflix Sans', Arial, sans-serif;
      font-size: 14px;
      font-weight: 500;
      padding: 8px 18px;
      border-radius: 6px;
      pointer-events: none;
      text-align: center;
      max-width: 70vw;
      transition: opacity 0.4s;
    `;
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.style.opacity = '1';

  clearTimeout(flashTimeout);
  flashTimeout = setTimeout(() => {
    el.style.opacity = '0';
  }, 4000);
}

// ---------------------------------------------------------------------------
// 13. Overlay
// ---------------------------------------------------------------------------
function hideNetflixSubtitles() {
  if (document.getElementById('nst-hide-style')) return;
  const el = document.createElement('style');
  el.id = 'nst-hide-style';
  el.textContent = '.player-timedtext { visibility: hidden !important; }';
  document.head.appendChild(el);
}

function applyOverlayStyle() {
  if (!overlayEl) return;
  overlayEl.style.bottom = subtitleBottom + '%';
  const inner = overlayEl.querySelector('div');
  if (inner) inner.style.fontSize = subtitleFontSize + 'px';
}

function ensureOverlay() {
  if (overlayEl) return;  // listener attached only once — the null check is the guard
  hideNetflixSubtitles();

  overlayEl = document.createElement('div');
  overlayEl.id = 'nst-overlay';
  overlayEl.style.cssText = `
    position: fixed;
    left: 50%;
    transform: translateX(-50%);
    z-index: 2147483647;
    pointer-events: none;
    text-align: center;
    max-width: 80vw;
  `;
  applyOverlayStyle();
  document.body.appendChild(overlayEl);

  fullscreenHandler = () => {
    const target = document.fullscreenElement || document.body;
    target.appendChild(overlayEl);
    const flash = document.getElementById('nst-flash');
    if (flash) target.appendChild(flash);
  };
  document.addEventListener('fullscreenchange', fullscreenHandler);
}

function renderSubtitle(text) {
  if (!overlayEl) return;
  if (!text) { overlayEl.innerHTML = ''; return; }
  const lines = text.split('\n').map(l => {
    const s = document.createElement('span');
    s.textContent = l;
    return s.outerHTML;
  });
  overlayEl.innerHTML = `<div style="
    display:inline-block;background:rgba(0,0,0,0.75);color:#fff;
    font-size:${subtitleFontSize}px;font-family:'Netflix Sans',Arial,sans-serif;
    font-weight:500;line-height:1.5;padding:4px 12px 6px;
    border-radius:3px;white-space:pre-wrap;
  ">${lines.join('<br>')}</div>`;
}

// Return all segments overlapping current time (to support overlapping text)
function findSegments(time, segs) {
  if (!segs.length) return [];
  // Binary search to find start index (last segment that begins at or before 'time')
  let lo = 0, hi = segs.length - 1, startIdx = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (segs[mid].begin <= time) { startIdx = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  
  const results = [];
  // Scan backwards from startIdx for any segments that haven't ended yet.
  for (let i = startIdx; i >= 0; i--) {
    const s = segs[i];
    if (s.begin <= time && s.end > time) {
      results.push(s);
    }
    // Optimization: Netflix subtitles rarely exceed 20s. 60s is a very safe limit.
    if (time - s.begin > 60) break; 
  }
  // Sort by begin time to maintain reading order
  return results.sort((a, b) => a.begin - b.begin);
}

function startSync() {
  if (!videoEl) videoEl = document.querySelector('video');
  if (!videoEl) { setTimeout(startSync, 1000); return; }
  if (rafId) cancelAnimationFrame(rafId);

  if (seekedHandler) videoEl.removeEventListener('seeked', seekedHandler);
  if (playHandler) videoEl.removeEventListener('play', playHandler);
  if (pauseHandler) videoEl.removeEventListener('pause', pauseHandler);

  seekedHandler = () => {
    const t = videoEl.currentTime;
    CLOG(`Seeked to ${fmt(t)}`);
    
    // Stop any ongoing translation work immediately
    TranslationSession.cancel();
    
    // Reset window state to force a re-translation if needed
    nextWindowStart = t;
    rollingWindowEnd = 0;
    
    EventBus.emit('playback:seeked', { time: t });
  };
  playHandler = () => {
    if (!isOnWatchPage()) return;
    nextWindowStart = videoEl.currentTime;
    EventBus.emit('playback:play', { time: videoEl.currentTime });
  };
  pauseHandler = () => {
    if (!isOnWatchPage()) return;
    EventBus.emit('playback:pause', {});
  };

  videoEl.addEventListener('seeked', seekedHandler);
  videoEl.addEventListener('play', playHandler);
  videoEl.addEventListener('pause', pauseHandler);

  function tick() {
    rafId = requestAnimationFrame(tick);
    if (!isOnWatchPage()) {
      if (lastRenderedText !== null) {
        lastRenderedText = null;
        renderSubtitle('');
      }
      if (lastWatchPageState !== false) {
        lastWatchPageState = false;
        setStatus('idle', 'Waiting for a video to play…');
      }
      return;
    }
    if (lastWatchPageState !== true) lastWatchPageState = true;

    const t = videoEl.currentTime;

    // Lookahead: trigger next rolling window before the current one is exhausted
    if (needsAiTranslation && translationEnabled && canTranslateNow() &&
        t >= nextWindowStart - LOOKAHEAD_SECONDS &&
        nextWindowStart >= rollingWindowEnd) {
      const duration = videoEl.duration || Infinity;
      const wEnd = Math.min(nextWindowStart + windowMinutes * 60, duration);
      
      if (wEnd > nextWindowStart) {
        rollingWindowEnd = wEnd;
        const signal = TranslationSession.signal;
        if (signal && !signal.aborted) {
          translateWindow(nextWindowStart, wEnd, signal)
            .catch(() => { rollingWindowEnd = 0; });
        }
      }
    }

    // When AI is disabled, fall back to original (source-language) segments
    const segs = (needsAiTranslation && !translationEnabled) ? SegmentStore.getOriginal() : SegmentStore.getOverlay();
    const activeSegs = findSegments(t, segs);
    const text = activeSegs.map(s => s.text).join('\n');
    
    if (verboseLogging && t - lastVerboseLogTime >= 30) {
      lastVerboseLogTime = t;
      VLOG('Playback timing', {
        currentTime: t,
        playbackRate: videoEl.playbackRate,
        activeCount: activeSegs.length,
        firstSegText: activeSegs[0]?.text ?? null,
        nextWindowStart,
        rollingWindowEnd,
      });
    }
    if (text !== lastRenderedText) { lastRenderedText = text; renderSubtitle(text); }
  }

  tick();
  CLOG('Subtitle sync started');
}

// ---------------------------------------------------------------------------
// 14. Status
// ---------------------------------------------------------------------------
function setStatus(state, message) {
  browser.storage.local.set({ translationStatus: { state, message, ts: Date.now() } });
}
