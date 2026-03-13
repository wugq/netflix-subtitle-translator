// content.js — injects page-context script, receives subtitle URLs, fetches,
// parses TTML locally, sends only text array to background for translation.
'use strict';

const LOG = (...a) => console.log('[SubtitleTranslator]', ...a);
const TTML_NS = 'http://www.w3.org/ns/ttml';

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
let currentMovieId = null;
let isTranslating = false;
let overlaySegments = [];
let overlayEl = null;
let rafId = null;

// ---------------------------------------------------------------------------
// 3. TTML parsing (runs in content script — DOMParser works here for sure)
// ---------------------------------------------------------------------------
function parseTtmlTime(t, tickRate) {
  if (!t) return 0;
  // HH:MM:SS.mmm
  const m = t.match(/^(\d+):(\d+):(\d+(?:\.\d+)?)$/);
  if (m) return +m[1] * 3600 + +m[2] * 60 + +m[3];
  // MM:SS.mmm
  const m2 = t.match(/^(\d+):(\d+(?:\.\d+)?)$/);
  if (m2) return +m2[1] * 60 + +m2[2];
  // Raw tick integer (Netflix uses ttp:tickRate, typically 10000000)
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

  // Read tickRate from <tt ttp:tickRate="..."> — Netflix typically uses 10000000
  const tt = doc.getElementsByTagNameNS(TTML_NS, 'tt')[0];
  const tickRate = parseInt(tt?.getAttributeNS('http://www.w3.org/ns/ttml#parameter', 'tickRate') || '10000000', 10);
  LOG(`tickRate: ${tickRate}`);

  const ps = doc.getElementsByTagNameNS(TTML_NS, 'p');
  LOG(`TTML parsed — ${ps.length} <p> elements found`);

  const segments = [];
  for (const p of ps) {
    const text = nodeToText(p).trim();
    if (!text) continue;
    segments.push({
      begin: parseTtmlTime(p.getAttribute('begin'), tickRate),
      end:   parseTtmlTime(p.getAttribute('end'), tickRate),
      text,
    });
  }
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
    LOG('ttDownloadables keys for track', track.language, ':', Object.keys(dl));
    for (const fmt of TTML_FORMATS) {
      const entry = dl[fmt];
      if (!entry) continue;
      const url = firstUrl(entry.downloadUrls || entry.urls || entry);
      if (url) {
        LOG('Found subtitle URL under format', fmt, ':', url);
        return url;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 5. Listen for timedtexttracks from injected.js
// ---------------------------------------------------------------------------
window.addEventListener('nst_tracks', async (e) => {
  let payload;
  try { payload = JSON.parse(e.detail); } catch (_) { return; }

  const { movieId, tracks } = payload;
  if (!movieId || movieId === currentMovieId || isTranslating) return;
  currentMovieId = movieId;
  isTranslating = true;

  LOG('Received tracks for movieId', movieId, '—', tracks.length, 'tracks');
  setStatus('detected', `Found ${tracks.length} subtitle tracks`);

  // Find URL
  const url = findEnglishTtmlUrl(tracks);
  if (!url) {
    LOG('No English TTML URL found. Languages:', tracks.map(t => t.language));
    setStatus('error', 'No English TTML subtitle track found');
    isTranslating = false;
    return;
  }

  // Fetch XML
  let xml;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    xml = await res.text();
    LOG(`Fetched XML: ${xml.length} chars`);
  } catch (err) {
    LOG('Fetch failed:', err);
    setStatus('error', 'Fetch failed: ' + err.message);
    isTranslating = false;
    return;
  }

  // Parse TTML here in content script
  let segments;
  try {
    segments = parseTtml(xml);
    LOG(`Parsed ${segments.length} segments. First:`, segments[0]);
  } catch (err) {
    LOG('TTML parse failed:', err);
    setStatus('error', 'TTML parse failed: ' + err.message);
    isTranslating = false;
    return;
  }

  if (segments.length === 0) {
    LOG('No segments found in TTML');
    setStatus('error', 'No subtitle segments found');
    isTranslating = false;
    return;
  }

  // Translate in batches — first batch shows immediately, rest fill in progressively
  const BATCH_SIZE = 50;
  const texts = segments.map(s => s.text);
  LOG(`${texts.length} segments, translating in batches of ${BATCH_SIZE}`);

  // Pre-fill overlay with original English so timing is ready
  overlaySegments = segments.map(s => ({ ...s }));
  ensureOverlay();
  startSync();

  const batches = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    batches.push({ offset: i, texts: texts.slice(i, i + BATCH_SIZE) });
  }

  let completed = 0;
  for (const { offset, texts: batchTexts } of batches) {
    setStatus('translating', `Translating segments ${offset + 1}–${offset + batchTexts.length} of ${texts.length}…`);
    LOG(`Sending batch offset=${offset} size=${batchTexts.length}`);

    let response;
    try {
      response = await browser.runtime.sendMessage({ type: 'translate', texts: batchTexts, movieId });
    } catch (err) {
      LOG(`Batch offset=${offset} sendMessage failed:`, err);
      setStatus('error', 'Background error: ' + err.message);
      break;
    }

    if (!response || !response.ok) {
      LOG(`Batch offset=${offset} failed:`, response?.error);
      // Non-fatal — keep going with remaining batches, this batch stays English
      continue;
    }

    if (response.translations.length !== batchTexts.length) {
      LOG(`Batch offset=${offset} count mismatch: sent ${batchTexts.length}, got ${response.translations.length} — skipping`);
      continue;
    }

    // Merge this batch's translations into overlaySegments
    response.translations.forEach((text, i) => {
      overlaySegments[offset + i] = { ...overlaySegments[offset + i], text };
    });

    completed += batchTexts.length;
    LOG(`Batch done. ${completed}/${texts.length} translated. First of batch:`, response.translations[0]);
    setStatus('done', `Translated ${completed} of ${texts.length} segments`);
  }

  LOG(`All batches complete. ${completed}/${texts.length} translated.`);
  setStatus('done', `Done — ${completed} of ${texts.length} segments translated`);
  isTranslating = false;
});

// ---------------------------------------------------------------------------
// 6. Overlay
// ---------------------------------------------------------------------------
function hideNetflixSubtitles() {
  const style = document.getElementById('nst-hide-style');
  if (style) return;
  const el = document.createElement('style');
  el.id = 'nst-hide-style';
  el.textContent = '.player-timedtext { visibility: hidden !important; }';
  document.head.appendChild(el);
  LOG('Netflix original subtitles hidden');
}

function ensureOverlay() {
  if (overlayEl) return;
  hideNetflixSubtitles();

  overlayEl = document.createElement('div');
  overlayEl.id = 'nst-overlay';
  overlayEl.style.cssText = `
    position: fixed;
    bottom: 8%;
    left: 50%;
    transform: translateX(-50%);
    z-index: 2147483647;
    pointer-events: none;
    text-align: center;
    max-width: 80vw;
  `;
  document.body.appendChild(overlayEl);

  document.addEventListener('fullscreenchange', () => {
    const fs = document.fullscreenElement;
    if (fs && overlayEl) {
      fs.appendChild(overlayEl);
      overlayEl.style.position = 'absolute';
    } else if (overlayEl) {
      document.body.appendChild(overlayEl);
      overlayEl.style.position = 'fixed';
    }
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
    font-size:1.4vw;font-family:'Netflix Sans',Arial,sans-serif;
    font-weight:500;line-height:1.5;padding:4px 12px 6px;
    border-radius:3px;white-space:pre-wrap;
  ">${lines.join('<br>')}</div>`;
}

// Binary search — O(log n) instead of O(n) linear scan at 60fps
function findSegment(time) {
  const segs = overlaySegments;
  let lo = 0, hi = segs.length - 1, result = null;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (segs[mid].begin <= time) { result = segs[mid]; lo = mid + 1; }
    else hi = mid - 1;
  }
  return result && time < result.end ? result : null;
}

function startSync() {
  const video = document.querySelector('video');
  if (!video) { setTimeout(startSync, 1000); return; }
  if (rafId) cancelAnimationFrame(rafId);
  let lastText = null;
  function tick() {
    rafId = requestAnimationFrame(tick);
    const seg = findSegment(video.currentTime);
    const text = seg ? seg.text : '';
    if (text !== lastText) { lastText = text; renderSubtitle(text); }
  }
  tick();
  LOG('Subtitle sync started');
}

// ---------------------------------------------------------------------------
// 7. Status
// ---------------------------------------------------------------------------
function setStatus(state, message) {
  browser.storage.local.set({ translationStatus: { state, message, ts: Date.now() } });
}
