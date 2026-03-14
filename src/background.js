// background.js — handles translation requests from content script
'use strict';

const APP_NAME = 'Netflix Subtitle Translator';
let consoleLogging = false;  // minimal key events → browser console
let verboseLogging = false;  // detailed trace → options page log buffer
const LOG_KEY = 'nstLogBuffer';
const MAX_LOG_ITEMS = 500;

function formatLogArgs(args) {
  return args.map(a => {
    if (typeof a === 'string') return a;
    try { return JSON.stringify(a); } catch (_) { return String(a); }
  }).join(' ');
}

async function appendLog(source, message) {
  if (!verboseLogging) return;
  const line = `${new Date().toISOString()} [${source}] ${message}`;
  const r = await browser.storage.local.get(LOG_KEY);
  const arr = Array.isArray(r[LOG_KEY]) ? r[LOG_KEY] : [];
  arr.push(line.length > 2000 ? line.slice(0, 2000) + '…' : line);
  if (arr.length > MAX_LOG_ITEMS) arr.splice(0, arr.length - MAX_LOG_ITEMS);
  await browser.storage.local.set({ [LOG_KEY]: arr });
}

// CLOG: minimal console log for key events
const CLOG = (...a) => { if (consoleLogging) console.log(`[${APP_NAME}]`, ...a); };
// VLOG: verbose → memory buffer only (shown in options page, not in console)
const VLOG = (...a) => {
  if (!verboseLogging) return;
  appendLog('background', formatLogArgs(a));
};

browser.storage.local.get(['consoleLogging', 'verboseLogging']).then(r => {
  consoleLogging = r.consoleLogging || false;
  verboseLogging = r.verboseLogging || false;
});
browser.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if ('consoleLogging' in changes) consoleLogging = changes.consoleLogging.newValue;
  if ('verboseLogging' in changes) verboseLogging = changes.verboseLogging.newValue;
});

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------
async function getApiKey() {
  const r = await browser.storage.local.get('openaiApiKey');
  return r.openaiApiKey || null;
}

// ---------------------------------------------------------------------------
// Language name lookup (for the AI system prompt)
// ---------------------------------------------------------------------------
const LANG_NAMES = {
  'zh-hans': 'Simplified Chinese',
  'zh-hant': 'Traditional Chinese',
  'ja':      'Japanese',
  'ko':      'Korean',
  'es':      'Spanish',
  'fr':      'French',
  'de':      'German',
  'pt':      'Portuguese',
  'it':      'Italian',
  'ru':      'Russian',
  'ar':      'Arabic',
  'hi':      'Hindi',
  'th':      'Thai',
  'vi':      'Vietnamese',
  'id':      'Indonesian',
  'nl':      'Dutch',
  'pl':      'Polish',
  'tr':      'Turkish',
};

function langName(code) {
  if (!code) return 'the target language';
  const lower = code.toLowerCase();
  for (const [prefix, name] of Object.entries(LANG_NAMES)) {
    if (lower === prefix || lower.startsWith(prefix + '-')) return name;
  }
  return code;
}

// ---------------------------------------------------------------------------
// OpenAI batch translation
// ---------------------------------------------------------------------------
async function callOpenAI(apiKey, keyed, dstLang) {
  const targetLang = langName(dstLang);
  const systemPrompt =
    `You are a subtitle translator. Translate each subtitle line to ${targetLang}.\n` +
    'Rules:\n' +
    '- Preserve \\n line breaks exactly as they appear.\n' +
    '- Keep the same keys (IDs) as input.\n' +
    '- Output ONLY valid JSON: {"translations": {"id1": "...", "id2": "...", ...}} using the same keys as input.\n' +
    '- Every input key MUST have a corresponding output key. Never skip or merge entries.';

  const keyedEntries = Object.entries(keyed);
  VLOG(`OpenAI request: ${keyedEntries.length} segments → ${targetLang}`, keyedEntries.slice(0, 3));

  const requestBody = {
    model: 'gpt-4o-mini',
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: JSON.stringify(keyed) },
    ],
  };

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(requestBody),
  });

  const responseText = await res.text();

  if (!res.ok) {
    CLOG('OpenAI error', res.status, responseText.slice(0, 200));
    throw new Error(`OpenAI ${res.status}: ${responseText}`);
  }

  const data = JSON.parse(responseText);
  const content = data.choices?.[0]?.message?.content;
  VLOG('OpenAI response', res.status, (content || '').slice(0, 200));

  if (!content) throw new Error('Empty OpenAI response');
  const parsed = JSON.parse(content);
  const map = parsed.translations;
  if (!map || typeof map !== 'object') throw new Error('Missing translations object');

  return map;
}

async function translateItems(apiKey, items, dstLang) {
  // Build key → text map so GPT cannot reorder entries
  const keyed = {};
  items.forEach(item => { keyed[item.key] = item.text; });

  let map = await callOpenAI(apiKey, keyed, dstLang);
  const keys = Object.keys(map);
  VLOG(`Received ${keys.length} keys. Sample:`, keys.slice(0, 3).map(k => ({ id: k, text: map[k] })));

  // Retry once for missing keys (smaller payload)
  const missingKeys = items.map(i => i.key).filter(key => !(key in map));
  if (missingKeys.length) {
    CLOG(`Missing ${missingKeys.length} translation keys, retrying`);
    const retryKeyed = {};
    for (const key of missingKeys) retryKeyed[key] = keyed[key];
    try {
      const retryMap = await callOpenAI(apiKey, retryKeyed, dstLang);
      Object.assign(map, retryMap);
      VLOG(`After retry, have ${Object.keys(map).length} keys total`);
    } catch (err) {
      CLOG('Retry failed:', err.message);
    }
  }

  // Fill any remaining missing ids with original text to keep alignment stable
  for (const item of items) {
    if (!(item.key in map)) map[item.key] = item.text;
  }

  return map;
}

// ---------------------------------------------------------------------------
// Translation Cache (Persistent)
// ---------------------------------------------------------------------------
const CACHE_KEY = 'nstTranslationCache';
let translationCache = {}; // movieId -> { key: text }

// Load cache from storage on startup
browser.storage.local.get(CACHE_KEY).then(r => {
  if (r[CACHE_KEY]) translationCache = r[CACHE_KEY];
  CLOG('Cache loaded, movies:', Object.keys(translationCache).length);
});

async function saveCache() {
  try {
    // Keep only the last 10 movies to prevent storage bloat
    const movieIds = Object.keys(translationCache);
    if (movieIds.length > 10) {
      const toRemove = movieIds.slice(0, movieIds.length - 10);
      toRemove.forEach(id => delete translationCache[id]);
    }
    await browser.storage.local.set({ [CACHE_KEY]: translationCache });
  } catch (err) {
    CLOG('Cache save error:', err.message);
  }
}

function getCachedTranslations(movieId) {
  return translationCache[movieId] || null;
}

function updateCache(movieId, translations) {
  if (!movieId || !translations) return;
  if (!translationCache[movieId]) translationCache[movieId] = {};
  Object.assign(translationCache[movieId], translations);
  saveCache();
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------
browser.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'checkApiKey') {
    return (async () => {
      const apiKey = await getApiKey();
      return { ok: !!apiKey };
    })();
  }

  if (msg.type === 'getCache') {
    return Promise.resolve({ ok: true, translations: getCachedTranslations(msg.movieId) });
  }

  if (msg.type === 'log') {
    appendLog(msg.source || 'content', msg.message || '');
    return;
  }

  if (msg.type !== 'translate') return;

  return (async () => {
    try {
      const { movieId, items, dstLang, requestId } = msg;
      VLOG('Translate request — movieId:', movieId, 'count:', items?.length, 'requestId:', requestId);

      const apiKey = await getApiKey();
      if (!apiKey) {
        CLOG('No API key configured');
        return { ok: false, error: 'No API key — open extension settings' };
      }

      if (!Array.isArray(items) || items.length === 0) {
        return { ok: false, error: 'No items provided' };
      }

      // 1. Check cache first
      const movieCache = translationCache[movieId] || {};
      const results = {};
      const pending = [];

      for (const item of items) {
        if (movieCache[item.key]) {
          results[item.key] = movieCache[item.key];
        } else {
          pending.push(item);
        }
      }

      // 2. Translate only what's missing
      if (pending.length > 0) {
        try {
          const newTranslations = await translateItems(apiKey, pending, dstLang);
          Object.assign(results, newTranslations);
          // Update cache with new results
          updateCache(movieId, newTranslations);
        } catch (err) {
          CLOG('Translation error:', err.message);
          // If translation fails, we still return what we got from cache
          if (Object.keys(results).length === 0) {
            return { ok: false, error: 'Translation error: ' + err.message };
          }
        }
      }

      const keys = Object.keys(results);
      VLOG(`Done — returning ${keys.length} translations (${items.length - pending.length} from cache)`);
      
      return {
        ok: true,
        translations: results,
        count: keys.length,
        sample: keys.slice(0, 3).map(k => results[k]),
        requestId,
        movieId,
      };

    } catch (err) {
      CLOG('Unhandled error in message handler:', err.message);
      return { ok: false, error: 'Unexpected error: ' + err.message, requestId: msg.requestId, movieId: msg.movieId };
    }
  })();
});

