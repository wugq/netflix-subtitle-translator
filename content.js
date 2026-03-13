// content.js — injects page-context script, receives subtitle URLs, fetches,
// parses TTML locally, translates a rolling time window progressively.
'use strict';

const LOG = (...a) => console.log('[SubtitleTranslator]', ...a);
const TTML_NS = 'http://www.w3.org/ns/ttml';

// How many seconds before window end to start translating the next window
const LOOKAHEAD_SECONDS = 60;
// Segments per OpenAI request
const BATCH_SIZE = 50;

// ---------------------------------------------------------------------------
// 1. Inject injected.js into page context
// ---------------------------------------------------------------------------
const script = document.createElement('script');
script.src = browser.runtime.getURL('injected.js');
script.onload = () => script.remove();
(document.head || document.documentElement).prepend(script);

// ---------------------------------------------------------------------------
// 2. State
// ---------------------------------------------------------------------------
let currentMovieId      = null;
let isSettingUp         = false;  // guard against duplicate nst_tracks processing
let isWindowTranslating = false;  // guard against concurrent window translations
let translationGen      = 0;      // increment on seek to cancel in-flight translations
let nextWindowStart     = 0;      // seconds — start of next untranslated window
let windowMinutes       = 5;      // configurable via popup
let originalSegments    = [];     // [{begin, end, text}] — always the original English
let overlaySegments     = [];     // [{begin, end, text}] — may be English or Chinese
let translated          = [];     // boolean[] parallel to overlaySegments
let overlayEl           = null;
let rafId               = null;
let videoEl             = null;
let seekedHandler       = null;  // tracked so we can remove it before re-adding

let subtitleFontSize    = 24;
let subtitleBottom      = 8;
let translationEnabled  = true;

// Load persisted settings
browser.storage.local.get(['subtitleFontSize', 'subtitleBottom', 'windowMinutes', 'translationEnabled']).then(r => {
  if (r.subtitleFontSize   != null) subtitleFontSize   = r.subtitleFontSize;
  if (r.subtitleBottom     != null) subtitleBottom     = r.subtitleBottom;
  if (r.windowMinutes      != null) windowMinutes      = r.windowMinutes;
  if (r.translationEnabled != null) translationEnabled = r.translationEnabled;
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
  applyOverlayStyle();
});

// ---------------------------------------------------------------------------
// 3. TTML parsing
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
  LOG(`tickRate: ${tickRate}`);

  const ps = doc.getElementsByTagNameNS(TTML_NS, 'p');
  LOG(`TTML parsed — ${ps.length} <p> elements found`);

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
// 4. Find English TTML URL
// ---------------------------------------------------------------------------
function findEnglishTtmlUrl(tracks) {
  const TTML_FORMATS = ['imsc1.1', 'dfxp-ls-sdh', 'simplesdh', 'nflx-cmisc', 'dfxp'];

  const candidates = tracks.filter(
    t =>
      t.language === 'en' ||
      t.language === 'en-US' ||
      (t.languageDescription || '').toLowerCase().includes('english')
  );
  if (candidates.length === 0) return null;

  function firstUrl(obj) {
    if (typeof obj === 'string' && obj.startsWith('https://')) return obj;
    if (obj && typeof obj === 'object') {
      for (const v of Object.values(obj)) {
        const found = firstUrl(v);
        if (found) return found;
      }
    }
    return null;
  }

  for (const track of candidates) {
    const dl = track.ttDownloadables;
    if (!dl) continue;
    LOG('ttDownloadables keys for', track.language, ':', Object.keys(dl));
    for (const fmt of TTML_FORMATS) {
      const entry = dl[fmt];
      if (!entry) continue;
      const url = firstUrl(entry.downloadUrls || entry.urls || entry);
      if (url) { LOG('Subtitle URL:', fmt, url); return url; }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 5. Window-based translation
// ---------------------------------------------------------------------------

// Translate segments in [fromTime, toTime) for a specific generation.
// Returns true if completed normally, false if cancelled by a newer seek.
async function translateWindow(fromTime, toTime, gen) {
  if (isWindowTranslating) return false;
  isWindowTranslating = true;

  LOG(`Translating window ${fmt(fromTime)} → ${fmt(toTime)}`);
  setStatus('translating', `Translating ${fmt(fromTime)}–${fmt(toTime)}…`);

  const pending = [];
  for (let i = 0; i < overlaySegments.length; i++) {
    if (!translated[i] &&
        overlaySegments[i].begin >= fromTime &&
        overlaySegments[i].begin < toTime) {
      pending.push(i);
    }
  }

  if (pending.length === 0) {
    LOG(`No untranslated segments in window, advancing`);
    nextWindowStart = toTime;
    isWindowTranslating = false;
    return true;
  }

  LOG(`${pending.length} segments to translate`);
  let completed = 0;

  for (let b = 0; b < pending.length; b += BATCH_SIZE) {
    // Check if a seek has made this translation stale
    if (gen !== translationGen) {
      LOG(`Window cancelled (gen ${gen} → ${translationGen})`);
      isWindowTranslating = false;
      return false;
    }

    const slice = pending.slice(b, b + BATCH_SIZE);
    const texts = slice.map(i => overlaySegments[i].text);

    let response;
    try {
      response = await browser.runtime.sendMessage({ type: 'translate', texts, movieId: currentMovieId });
    } catch (err) {
      LOG(`Batch sendMessage failed:`, err);
      setStatus('error', 'Background error: ' + err.message);
      isWindowTranslating = false;
      return false;
    }

    if (!response || !response.ok) {
      LOG(`Batch failed:`, response?.error);
      continue; // non-fatal — leave as English
    }

    response.translations.forEach((text, j) => {
      const idx = slice[j];
      overlaySegments[idx] = { ...overlaySegments[idx], text };
      translated[idx] = true;
    });

    completed += slice.length;
    setStatus('translating', `${fmt(fromTime)}–${fmt(toTime)}: ${completed}/${pending.length}`);
  }

  LOG(`Window done — ${completed}/${pending.length} translated`);
  nextWindowStart = toTime;
  isWindowTranslating = false;
  setStatus('done', `Translated up to ${fmt(toTime)}`);
  return true;
}

// Progressive initial load: 30s → 2 min → full window.
// Each stage awaits the previous so subtitles appear almost immediately.
// Exits early if cancelled by a newer seek.
async function initialTranslation(startTime) {
  const gen = ++translationGen;
  isWindowTranslating = false; // unlock so this call can enter translateWindow
  const windowEnd = startTime + windowMinutes * 60;

  const stages = [
    startTime + 30,   // Stage 1: first 30s — subtitles appear fast
    startTime + 120,  // Stage 2: up to 2 min — fill in more
    windowEnd,        // Stage 3: full configured window
  ];

  let prev = startTime;
  for (const to of stages) {
    const clampedTo = Math.min(to, windowEnd);
    if (clampedTo <= prev) continue;
    const ok = await translateWindow(prev, clampedTo, gen);
    if (!ok) return; // cancelled by a newer seek
    prev = clampedTo;
    if (prev >= windowEnd) break;
  }
}

function fmt(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// 6. Listen for timedtexttracks from injected.js
// ---------------------------------------------------------------------------
window.addEventListener('nst_tracks', async (e) => {
  let payload;
  try { payload = JSON.parse(e.detail); } catch (_) { return; }

  const { movieId, tracks } = payload;
  if (!movieId || movieId === currentMovieId || isSettingUp) return;
  currentMovieId = movieId;
  isSettingUp = true;

  LOG('Tracks received for movieId', movieId);
  setStatus('detected', `Found ${tracks.length} subtitle tracks`);

  const url = findEnglishTtmlUrl(tracks);
  if (!url) {
    LOG('No English TTML URL. Languages:', tracks.map(t => t.language));
    setStatus('error', 'No English TTML track found');
    isSettingUp = false;
    return;
  }

  let xml;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    xml = await res.text();
    LOG(`Fetched XML: ${xml.length} chars`);
  } catch (err) {
    LOG('Fetch failed:', err);
    setStatus('error', 'Fetch failed: ' + err.message);
    isSettingUp = false;
    return;
  }

  let segments;
  try {
    segments = parseTtml(xml);
    LOG(`Parsed ${segments.length} segments`);
  } catch (err) {
    LOG('TTML parse failed:', err);
    setStatus('error', 'TTML parse failed: ' + err.message);
    isSettingUp = false;
    return;
  }

  if (segments.length === 0) {
    setStatus('error', 'No subtitle segments found');
    isSettingUp = false;
    return;
  }

  // Set up state — all segments start as English
  originalSegments = segments.map(s => ({ ...s }));
  overlaySegments  = segments.map(s => ({ ...s }));
  translated       = new Array(segments.length).fill(false);

  ensureOverlay();

  isSettingUp = false;
  startSync();

  // Poll until video.currentTime > 1s so we catch Netflix's resume seek.
  // Only then do we know the actual starting position.
  // Capture movieId so a stale promise from a previous title is a no-op.
  const capturedMovieId = movieId;
  waitForPlaybackStart().then(startTime => {
    if (currentMovieId !== capturedMovieId) return; // navigated away
    videoEl = document.querySelector('video'); // refresh in case it wasn't ready
    LOG(`Starting translation from ${fmt(startTime)}`);
    nextWindowStart = startTime;
    if (translationEnabled) initialTranslation(startTime);
  });
});

// ---------------------------------------------------------------------------
// 7. Playback start detection
// ---------------------------------------------------------------------------

// Polls until video.currentTime settles at a non-trivial value (> 1s),
// meaning Netflix has finished seeking to the resume position.
// Falls back after 5s so we never hang forever.
function waitForPlaybackStart() {
  return new Promise(resolve => {
    const MAX_MS   = 5000;
    const INTERVAL = 150;
    const began    = Date.now();

    function check() {
      const video = document.querySelector('video');
      if (video && video.currentTime > 1) {
        LOG(`Playback position settled at ${fmt(video.currentTime)}`);
        resolve(video.currentTime);
        return;
      }
      if (Date.now() - began >= MAX_MS) {
        const t = video ? video.currentTime : 0;
        LOG(`Playback start timeout, using ${fmt(t)}`);
        resolve(t);
        return;
      }
      setTimeout(check, INTERVAL);
    }

    check();
  });
}

// ---------------------------------------------------------------------------
// 8. Overlay
// ---------------------------------------------------------------------------
function applyTranslationEnabled() {
  if (translationEnabled) {
    // Restart translation from current position; reuses already-translated segments
    if (videoEl) initialTranslation(videoEl.currentTime);
  } else {
    // Cancel any in-flight translation — tick loop will render originalSegments
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
    (fs || document.body).appendChild(overlayEl);
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

  // Remove any seeked listener from a previous movie before adding a new one
  if (seekedHandler) videoEl.removeEventListener('seeked', seekedHandler);
  seekedHandler = () => {
    const t = videoEl.currentTime;
    translationGen++;          // invalidates any in-flight translateWindow
    isWindowTranslating = false; // unlock immediately so initialTranslation can enter
    nextWindowStart = t;
    if (translationEnabled) {
      LOG(`Seeked to ${fmt(t)}, restarting translation (gen ${translationGen})`);
      initialTranslation(t);
    }
  };
  videoEl.addEventListener('seeked', seekedHandler);

  let lastText = null;

  function tick() {
    rafId = requestAnimationFrame(tick);
    const t = videoEl.currentTime;

    // Trigger next rolling window when LOOKAHEAD_SECONDS before current window ends
    if (!isWindowTranslating && translationEnabled && t >= nextWindowStart - LOOKAHEAD_SECONDS) {
      translateWindow(nextWindowStart, nextWindowStart + windowMinutes * 60, translationGen);
    }

    const segs = translationEnabled ? overlaySegments : originalSegments;
    const seg = findSegment(t, segs);
    const text = seg ? seg.text : '';
    if (text !== lastText) { lastText = text; renderSubtitle(text); }
  }

  tick();
  LOG('Subtitle sync started');
}

// ---------------------------------------------------------------------------
// 9. Status
// ---------------------------------------------------------------------------
function setStatus(state, message) {
  browser.storage.local.set({ translationStatus: { state, message, ts: Date.now() } });
}
