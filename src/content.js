// content.js — injects page-context script, receives subtitle URLs, fetches,
// parses TTML locally, determines translation mode, and renders a custom overlay.
'use strict';

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
let isSettingUp         = false;
let isWindowTranslating = false;
let translationGen      = 0;
let nextWindowStart     = 0;
let windowMinutes       = 5;
let originalSegments    = [];   // source-language segments (used when AI disabled)
let overlaySegments     = [];   // displayed segments (translated or native/passthrough)
let translated          = [];   // boolean[] — which overlaySegments have been AI-translated
let overlayEl           = null;
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
    applyTranslationEnabled();
  }
  if ('dstLang' in changes) {
    dstLang = changes.dstLang.newValue;
    onLanguageChanged('dstLang');
  }
  if ('showAiNotice'   in changes) showAiNotice   = changes.showAiNotice.newValue;
  if ('consoleLogging' in changes) consoleLogging = changes.consoleLogging.newValue;
  if ('verboseLogging' in changes) verboseLogging = changes.verboseLogging.newValue;
  if (styleChanged) applyOverlayStyle();
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

  const m = t.match(/^(\d+):(\d+):(\d+(?:\.\d+)?)$/);
  if (m) return +m[1] * 3600 + +m[2] * 60 + +m[3];
  const m2 = t.match(/^(\d+):(\d+(?:\.\d+)?)$/);
  if (m2) return +m2[1] * 60 + +m2[2];
  const m3 = t.match(/^(\d+):(\d+):(\d+):(\d+)$/);
  if (m3) return +m3[1] * 3600 + +m3[2] * 60 + +m3[3] + (+m3[4] / frameRate);

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
  const tickRate = parseInt(
    tt?.getAttributeNS(TTML_PARAM_NS, 'tickRate') || tt?.getAttribute('tickRate') || '10000000', 10
  );
  const frameRate = parseFloat(
    tt?.getAttributeNS(TTML_PARAM_NS, 'frameRate') || tt?.getAttribute('frameRate') || '30'
  );
  const frameRateMultiplierRaw =
    tt?.getAttributeNS(TTML_PARAM_NS, 'frameRateMultiplier') ||
    tt?.getAttribute('frameRateMultiplier') ||
    '';
  let frameRateMultiplier = 1;
  if (frameRateMultiplierRaw) {
    const parts = frameRateMultiplierRaw.trim().split(/\s+/).map(Number);
    if (parts.length === 2 && parts[0] && parts[1]) {
      frameRateMultiplier = parts[0] / parts[1];
    }
  }
  const timeBase =
    tt?.getAttributeNS(TTML_PARAM_NS, 'timeBase') ||
    tt?.getAttribute('timeBase') ||
    'media';
  const params = {
    tickRate,
    frameRate: frameRate * frameRateMultiplier,
    timeBase,
  };

  // ttp:presentationTimeOffset — subtract from all times so they align with videoEl.currentTime
  const presentationTimeOffset = parseTtmlTime(
    tt?.getAttributeNS(TTML_PARAM_NS, 'presentationTimeOffset') ||
    tt?.getAttribute('ttp:presentationTimeOffset') ||
    '0',
    params
  );

  // Accumulate begin offset from ancestor <div> / <body> elements (TTML times are relative)
  function getParentOffset(el) {
    let offset = 0;
    let parent = el.parentElement;
    while (parent && parent !== tt) {
      const b = parent.getAttribute('begin');
      if (b) offset += parseTtmlTime(b, params);
      parent = parent.parentElement;
    }
    return offset;
  }

  VLOG('TTML timing params', {
    tickRate,
    frameRate,
    frameRateMultiplier: frameRateMultiplierRaw || '1 1',
    effectiveFrameRate: params.frameRate,
    timeBase: params.timeBase,
    presentationTimeOffset,
  });

  const ps = doc.getElementsByTagNameNS(TTML_NS, 'p');
  const segments = [];
  let missingEndCount = 0;
  let pIndex = 0;
  for (const p of ps) {
    const text = nodeToText(p).trim();
    if (!text) continue;
    const idAttr = p.getAttribute('xml:id') || p.getAttribute('id');
    const beginAttr = p.getAttribute('begin');
    const endAttr   = p.getAttribute('end');
    const durAttr   = p.getAttribute('dur');
    const key = `${idAttr || 'p' + pIndex}|${beginAttr || ''}|${endAttr || ''}|${durAttr || ''}`;

    const parentOffset = getParentOffset(p);
    let begin = beginAttr != null ? parseTtmlTime(beginAttr, params) + parentOffset - presentationTimeOffset : null;
    let end   = endAttr   != null ? parseTtmlTime(endAttr,   params) + parentOffset - presentationTimeOffset : null;

    if (end == null && durAttr) {
      const dur = parseTtmlTime(durAttr, params);
      end = (begin ?? 0) + dur;
      missingEndCount++;
    } else if (begin == null && durAttr && end != null) {
      const dur = parseTtmlTime(durAttr, params);
      begin = end - dur;
      missingEndCount++;
    }

    if (begin == null || end == null) continue;

    segments.push({ id: idAttr || null, key, begin, end, text });
    pIndex++;
  }
  if (missingEndCount) {
    VLOG('TTML segments with dur used for end/begin', { count: missingEndCount });
  }
  if (segments.length) {
    VLOG('TTML segment sample', segments.slice(0, 3).map(s => ({ begin: s.begin, end: s.end, text: s.text })));
  }
  segments.sort((a, b) => a.begin - b.begin);
  return segments;
}

// ---------------------------------------------------------------------------
// 4.5. Playback / page state helpers
// ---------------------------------------------------------------------------
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
  translationGen++;
  isWindowTranslating = false;
  nextWindowStart = 0;
  originalSegments = [];
  overlaySegments = [];
  translated = [];
  currentMode = null;
  currentTtmlLang = null;
  needsAiTranslation = false;
  lastRenderedText = null;
  lastWatchPageState = null;

  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;
  if (seekedHandler && videoEl) videoEl.removeEventListener('seeked', seekedHandler);
  seekedHandler = null;
  if (playHandler && videoEl) videoEl.removeEventListener('play', playHandler);
  if (pauseHandler && videoEl) videoEl.removeEventListener('pause', pauseHandler);
  playHandler = null;
  pauseHandler = null;
  videoEl = null;
  if (overlayEl) overlayEl.innerHTML = '';
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
async function translateWindow(fromTime, toTime, gen) {
  if (!canTranslateNow()) return false;
  if (isWindowTranslating) return false;
  isWindowTranslating = true;

  const keyCheck = await browser.runtime.sendMessage({ type: 'checkApiKey' });
  if (!keyCheck?.ok) {
    setStatus('error', 'No API key — open extension settings');
    isWindowTranslating = false;
    return false;
  }

  CLOG(`Translating window ${fmt(fromTime)} → ${fmt(toTime)}`);
  const nowFmt = () => videoEl ? fmt(videoEl.currentTime) : fmt(fromTime);
  setStatus('translating', `Translating… (at ${nowFmt()})`);

  const pending = [];
  for (let i = 0; i < overlaySegments.length; i++) {
    if (!translated[i] &&
        overlaySegments[i].begin >= fromTime &&
        overlaySegments[i].begin < toTime) {
      pending.push(i);
    }
  }

  if (pending.length === 0) {
    nextWindowStart = toTime;
    isWindowTranslating = false;
    return true;
  }

  let completed = 0;
  for (let b = 0; b < pending.length; b += BATCH_SIZE) {
    // Check gen FIRST — if stale, a newer translateWindow already owns isWindowTranslating
    if (gen !== translationGen) {
      return false;
    }
    if (!canTranslateNow()) {
      isWindowTranslating = false;
      return false;
    }

    const slice = pending.slice(b, b + BATCH_SIZE);
    const items = slice.map(i => ({
      key: originalSegments[i]?.key || overlaySegments[i].key || `idx-${i}`,
      text: originalSegments[i]?.text || overlaySegments[i].text,
    }));

    const requestId = `${currentMovieId}:${translationGen}:${++aiRequestSeq}`;
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
      isWindowTranslating = false;
      return false;
    }

    if (!response || !response.ok) {
      if (response?.error?.includes('No API key')) {
        setStatus('error', 'No API key — open extension settings');
        isWindowTranslating = false;
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
    for (const idx of slice) {
      const segKey = originalSegments[idx]?.key || overlaySegments[idx].key || `idx-${idx}`;
      const text = map[segKey];
      if (typeof text === 'string') {
        overlaySegments[idx] = { ...overlaySegments[idx], text };
        translated[idx] = true;
      }
    }

    completed += slice.length;
    setStatus('translating', `Translating… (at ${nowFmt()}) ${completed}/${pending.length}`);
  }

  nextWindowStart = toTime;
  isWindowTranslating = false;
  setStatus('done', `Translated up to ${fmt(toTime)} (at ${nowFmt()})`);
  return true;
}

// Progressive 3-stage translation: 30s → 2min → full window.
// flashMsg: optional on-screen message to show when AI starts (respects showAiNotice setting).
async function initialTranslation(startTime, flashMsg) {
  if (!canTranslateNow()) {
    setStatus('done', 'Translation paused — playback not active');
    return;
  }
  const gen = ++translationGen;
  isWindowTranslating = false;
  const windowEnd = startTime + windowMinutes * 60;

  const msg = flashMsg || 'AI translation active — uses API tokens';
  setStatus('ai_notice', msg);
  if (showAiNotice) showFlashMessage(msg);

  const stages = [startTime + 30, startTime + 120, windowEnd];
  let prev = startTime;
  for (const to of stages) {
    const clampedTo = Math.min(to, windowEnd);
    if (clampedTo <= prev) continue;
    const ok = await translateWindow(prev, clampedTo, gen);
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

  originalSegments   = segments.map(s => ({ ...s }));
  overlaySegments    = segments.map(s => ({ ...s }));
  translated         = new Array(segments.length).fill(false);
  needsAiTranslation = (mode === 'ai');
  currentMode        = mode;
  currentTtmlLang    = ttmlLang;
  return true;
}

// ---------------------------------------------------------------------------
// 8. Listen for timedtexttracks from injected.js
// ---------------------------------------------------------------------------
window.addEventListener('nst_tracks', async (e) => {
  let payload;
  try { payload = JSON.parse(e.detail); } catch (_) { return; }

  const { movieId, tracks } = payload;
  if (!movieId) return;
  if (!isOnWatchPage()) {
    setStatus('idle', 'Not playing a video');
    return;
  }

  // Same movie: tracks may have been hydrated (e.g. user selected a subtitle
  // in Netflix's player, which populates ttDownloadables for that track).
  // Re-evaluate mode — if we now have a native URL we didn't have before, switch.
  if (movieId === currentMovieId) {
    if (isSettingUp) return;
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
  isSettingUp     = true;
  availableTracks = tracks;

  CLOG('Tracks received for movieId', movieId, '— langs:', tracks.map(t => t.language));
  setStatus('detected', `Found ${tracks.length} subtitle tracks`);

  const { mode, ttmlLang, dstNotLoaded } = determineMode();
  const ok = await applyMode(tracks, mode, ttmlLang);
  if (!ok) { isSettingUp = false; return; }

  ensureOverlay();
  isSettingUp = false;
  startSync();

  const capturedMovieId = movieId;
  waitForPlaybackStart().then(startTime => {
    if (currentMovieId !== capturedMovieId) return;
    if (!isOnWatchPage()) return;
    videoEl = document.querySelector('video');
    nextWindowStart = startTime;

    if (needsAiTranslation && translationEnabled) {
      const flashMsg = dstNotLoaded
        ? `"${langLabel(dstLang)}" subtitle isn't loaded by Netflix yet — using AI translation instead`
        : 'AI translation active — uses API tokens';
      initialTranslation(startTime, flashMsg);
    } else {
      const label = mode === 'native'
        ? 'Using Netflix native subtitles'
        : mode === 'passthrough'
          ? 'Source and destination are the same language'
          : 'Translation paused';
      setStatus('done', label);
    }
  });
});

// ---------------------------------------------------------------------------
// 9. Listen for source language detection from injected.js
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
function onLanguageChanged(which) {
  if (!isOnWatchPage()) return;
  if (!availableTracks.length || !currentMovieId || isSettingUp) return;
  CLOG(`Language changed (${which}), re-evaluating mode`);

  translationGen++;
  isWindowTranslating = false;
  isSettingUp = true;

  const { mode, ttmlLang, dstNotLoaded } = determineMode();
  applyMode(availableTracks, mode, ttmlLang).then(ok => {
    isSettingUp = false;
    if (!ok) return;

    // dstLang may have changed while we were fetching — re-evaluate if so
    const { mode: reMode, ttmlLang: reTtmlLang } = determineMode();
    if (reMode !== currentMode || reTtmlLang !== currentTtmlLang) {
      onLanguageChanged('recheck');
      return;
    }

    const t = videoEl ? videoEl.currentTime : 0;
    nextWindowStart = t;

    if (needsAiTranslation && translationEnabled) {
      const flashMsg = dstNotLoaded
        ? `"${langLabel(dstLang)}" subtitle isn't loaded by Netflix yet — using AI translation instead`
        : 'AI translation active — uses API tokens';
      initialTranslation(t, flashMsg);
    } else {
      const label = mode === 'native'
        ? 'Using Netflix native subtitles'
        : mode === 'passthrough'
          ? 'Source and destination are the same language'
          : 'Translation paused';
      setStatus('done', label);
    }
  });
}

// ---------------------------------------------------------------------------
// 10. Playback start detection
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
// 11. On-screen flash message
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
// 12. Overlay
// ---------------------------------------------------------------------------
function applyTranslationEnabled() {
  if (translationEnabled && needsAiTranslation && canTranslateNow()) {
    if (videoEl) initialTranslation(videoEl.currentTime);
  } else {
    translationGen++;
    isWindowTranslating = false;
  }
}

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
  if (overlayEl) return;
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

  document.addEventListener('fullscreenchange', () => {
    const fs = document.fullscreenElement;
    const target = fs || document.body;
    target.appendChild(overlayEl);
    const flash = document.getElementById('nst-flash');
    if (flash) target.appendChild(flash);
  });
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

// Binary search — O(log n) at 60fps
function findSegment(time, segs) {
  let lo = 0, hi = segs.length - 1, result = null;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (segs[mid].begin <= time) { result = segs[mid]; lo = mid + 1; }
    else hi = mid - 1;
  }
  return result && time < result.end ? result : null;
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
    translationGen++;
    isWindowTranslating = false;
    nextWindowStart = t;
    if (needsAiTranslation && translationEnabled && canTranslateNow()) {
      CLOG(`Seeked to ${fmt(t)}, restarting translation`);
      initialTranslation(t);
    }
  };
  videoEl.addEventListener('seeked', seekedHandler);

  playHandler = () => {
    if (!isOnWatchPage()) return;
    const t = videoEl.currentTime;
    nextWindowStart = t;
    if (needsAiTranslation && translationEnabled) {
      CLOG(`Playback resumed at ${fmt(t)}, restarting translation`);
      initialTranslation(t);
    } else {
      setStatus('done', 'Playback resumed');
    }
  };
  pauseHandler = () => {
    if (!isOnWatchPage()) return;
    translationGen++;
    isWindowTranslating = false;
    setStatus('done', 'Translation paused — playback paused');
  };
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
        setStatus('idle', 'Not playing a video');
      }
      return;
    }
    if (lastWatchPageState !== true) lastWatchPageState = true;

    const t = videoEl.currentTime;

    // Lookahead: trigger next rolling window before the current one is exhausted
    if (needsAiTranslation && !isWindowTranslating && translationEnabled && canTranslateNow() &&
        t >= nextWindowStart - LOOKAHEAD_SECONDS) {
      translateWindow(nextWindowStart, nextWindowStart + windowMinutes * 60, translationGen);
    }

    // When AI is disabled, fall back to original (source-language) segments
    const segs = (needsAiTranslation && !translationEnabled) ? originalSegments : overlaySegments;
    const seg  = findSegment(t, segs);
    const text = seg ? seg.text : '';
    if (verboseLogging && t - lastVerboseLogTime >= 30) {
      lastVerboseLogTime = t;
      VLOG('Playback timing', {
        currentTime: t,
        playbackRate: videoEl.playbackRate,
        segBegin: seg?.begin ?? null,
        segEnd: seg?.end ?? null,
        segText: seg?.text ?? null,
      });
    }
    if (text !== lastRenderedText) { lastRenderedText = text; renderSubtitle(text); }
  }

  tick();
  CLOG('Subtitle sync started');
}

// ---------------------------------------------------------------------------
// 13. Status
// ---------------------------------------------------------------------------
function setStatus(state, message) {
  browser.storage.local.set({ translationStatus: { state, message, ts: Date.now() } });
}
