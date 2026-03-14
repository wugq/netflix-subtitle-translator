// content.js — injects page-context script, receives subtitle URLs, fetches,
// parses TTML locally, determines translation mode, and renders a custom overlay.
'use strict';

const APP_NAME = 'Netflix Subtitle Translator';
let debugLogging = false;
const LOG = (...a) => { if (debugLogging) console.log(`[${APP_NAME}]`, ...a); };
const TTML_NS = 'http://www.w3.org/ns/ttml';

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
  'subtitleFontSize', 'subtitleBottom', 'windowMinutes', 'translationEnabled', 'dstLang', 'showAiNotice', 'debugLogging',
]).then(r => {
  if (r.subtitleFontSize   != null) subtitleFontSize   = r.subtitleFontSize;
  if (r.subtitleBottom     != null) subtitleBottom     = r.subtitleBottom;
  if (r.windowMinutes      != null) windowMinutes      = r.windowMinutes;
  if (r.translationEnabled != null) translationEnabled = r.translationEnabled;
  if (r.dstLang            != null) dstLang            = r.dstLang;
  if (r.showAiNotice       != null) showAiNotice       = r.showAiNotice;
  if (r.debugLogging       != null) debugLogging       = r.debugLogging;
  applyOverlayStyle();
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if ('subtitleFontSize'   in changes) subtitleFontSize = changes.subtitleFontSize.newValue;
  if ('subtitleBottom'     in changes) subtitleBottom   = changes.subtitleBottom.newValue;
  if ('windowMinutes'      in changes) windowMinutes    = changes.windowMinutes.newValue;
  if ('translationEnabled' in changes) {
    translationEnabled = changes.translationEnabled.newValue;
    applyTranslationEnabled();
  }
  if ('dstLang' in changes) {
    dstLang = changes.dstLang.newValue;
    onLanguageChanged('dstLang');
  }
  if ('showAiNotice'  in changes) showAiNotice  = changes.showAiNotice.newValue;
  if ('debugLogging'  in changes) debugLogging  = changes.debugLogging.newValue;
  applyOverlayStyle();
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
function parseTtmlTime(t, tickRate) {
  if (!t) return 0;
  const m = t.match(/^(\d+):(\d+):(\d+(?:\.\d+)?)$/);
  if (m) return +m[1] * 3600 + +m[2] * 60 + +m[3];
  const m2 = t.match(/^(\d+):(\d+(?:\.\d+)?)$/);
  if (m2) return +m2[1] * 60 + +m2[2];
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
    tt?.getAttributeNS('http://www.w3.org/ns/ttml#parameter', 'tickRate') || '10000000', 10
  );

  const ps = doc.getElementsByTagNameNS(TTML_NS, 'p');
  const segments = [];
  for (const p of ps) {
    const text = nodeToText(p).trim();
    if (!text) continue;
    segments.push({
      begin: parseTtmlTime(p.getAttribute('begin'), tickRate),
      end:   parseTtmlTime(p.getAttribute('end'),   tickRate),
      text,
    });
  }
  segments.sort((a, b) => a.begin - b.begin);
  return segments;
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
  if (isWindowTranslating) return false;
  isWindowTranslating = true;

  const keyCheck = await browser.runtime.sendMessage({ type: 'checkApiKey' });
  if (!keyCheck?.ok) {
    setStatus('error', 'No API key — open extension settings');
    isWindowTranslating = false;
    return false;
  }

  LOG(`Translating window ${fmt(fromTime)} → ${fmt(toTime)}`);
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
    if (gen !== translationGen) {
      isWindowTranslating = false;
      return false;
    }

    const slice = pending.slice(b, b + BATCH_SIZE);
    const texts = slice.map(i => overlaySegments[i].text);

    let response;
    try {
      response = await browser.runtime.sendMessage({
        type: 'translate', texts, dstLang, movieId: currentMovieId,
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

    response.translations.forEach((text, j) => {
      const idx = slice[j];
      overlaySegments[idx] = { ...overlaySegments[idx], text };
      translated[idx] = true;
    });

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
  LOG(`Applying mode=${mode} ttmlLang=${ttmlLang}`);
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

  // Same movie: tracks may have been hydrated (e.g. user selected a subtitle
  // in Netflix's player, which populates ttDownloadables for that track).
  // Re-evaluate mode — if we now have a native URL we didn't have before, switch.
  if (movieId === currentMovieId) {
    if (isSettingUp) return;
    availableTracks = tracks;
    const { mode, ttmlLang } = determineMode();
    if (mode !== currentMode || ttmlLang !== currentTtmlLang) {
      LOG(`Tracks hydrated — mode changed: ${currentMode} → ${mode}`);
      onLanguageChanged('hydration');
    }
    return;
  }

  currentMovieId  = movieId;
  isSettingUp     = true;
  availableTracks = tracks;

  LOG('Tracks received for movieId', movieId, '— available langs:', tracks.map(t => t.language));
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
  LOG(`Src lang detected: ${srcLang} → ${lang}`);
  srcLang = lang;
  onLanguageChanged('srcLang');
});

// Re-evaluate and reload subtitles when src or dst language changes
function onLanguageChanged(which) {
  if (!availableTracks.length || !currentMovieId || isSettingUp) return;
  LOG(`Language changed (${which}), re-evaluating mode`);

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
  if (translationEnabled && needsAiTranslation) {
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
  seekedHandler = () => {
    const t = videoEl.currentTime;
    translationGen++;
    isWindowTranslating = false;
    nextWindowStart = t;
    if (needsAiTranslation && translationEnabled) {
      LOG(`Seeked to ${fmt(t)}, restarting translation`);
      initialTranslation(t);
    }
  };
  videoEl.addEventListener('seeked', seekedHandler);

  let lastText = null;

  function tick() {
    rafId = requestAnimationFrame(tick);
    const t = videoEl.currentTime;

    // Lookahead: trigger next rolling window before the current one is exhausted
    if (needsAiTranslation && !isWindowTranslating && translationEnabled &&
        t >= nextWindowStart - LOOKAHEAD_SECONDS) {
      translateWindow(nextWindowStart, nextWindowStart + windowMinutes * 60, translationGen);
    }

    // When AI is disabled, fall back to original (source-language) segments
    const segs = (needsAiTranslation && !translationEnabled) ? originalSegments : overlaySegments;
    const seg  = findSegment(t, segs);
    const text = seg ? seg.text : '';
    if (text !== lastText) { lastText = text; renderSubtitle(text); }
  }

  tick();
  LOG('Subtitle sync started');
}

// ---------------------------------------------------------------------------
// 13. Status
// ---------------------------------------------------------------------------
function setStatus(state, message) {
  browser.storage.local.set({ translationStatus: { state, message, ts: Date.now() } });
}
