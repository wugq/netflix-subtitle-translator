// background.js — handles translation requests from content script
'use strict';

const APP_NAME = 'Netflix Subtitle Translator';
let debugLogging = false;
const LOG = (...a) => { if (debugLogging) console.log(`[${APP_NAME}]`, ...a); };

browser.storage.local.get('debugLogging').then(r => { debugLogging = r.debugLogging || false; });
browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && 'debugLogging' in changes) debugLogging = changes.debugLogging.newValue;
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
async function translateTexts(apiKey, texts, dstLang) {
  const targetLang = langName(dstLang);
  const systemPrompt =
    `You are a subtitle translator. Translate each numbered subtitle line to ${targetLang}.\n` +
    'Rules:\n' +
    '- Preserve \\n line breaks exactly as they appear.\n' +
    '- Keep the same number (N) on each output line.\n' +
    '- Output ONLY valid JSON: {"translations": {"0": "...", "1": "...", ...}} using the same numeric keys as input.\n' +
    '- Every input key MUST have a corresponding output key. Never skip or merge entries.';

  // Build numbered object so GPT cannot skip or merge entries
  const numbered = {};
  texts.forEach((t, i) => { numbered[i] = t; });

  LOG('--- OpenAI REQUEST ---');
  LOG(`Sending ${texts.length} segments to ${targetLang}. First 3:`, texts.slice(0, 3));

  const requestBody = {
    model: 'gpt-4o-mini',
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: JSON.stringify(numbered) },
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
  LOG('--- OpenAI RESPONSE ---');
  LOG('Status:', res.status);

  if (!res.ok) {
    LOG('Error body:', responseText);
    throw new Error(`OpenAI ${res.status}: ${responseText}`);
  }

  const data = JSON.parse(responseText);
  const content = data.choices?.[0]?.message?.content;
  LOG('OpenAI response content (first 500 chars):', (content || '').slice(0, 500));

  if (!content) throw new Error('Empty OpenAI response');
  const parsed = JSON.parse(content);
  const map = parsed.translations;
  if (!map || typeof map !== 'object') throw new Error('Missing translations object');

  // Reconstruct ordered array from numbered keys
  const result = texts.map((_, i) => map[i] ?? map[String(i)] ?? texts[i]);
  LOG(`Received ${Object.keys(map).length} keys, built ${result.length} translations. First 3:`, result.slice(0, 3));
  return result;
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

  if (msg.type !== 'translate') return;

  return (async () => {
    try {
      LOG('Message received — movieId:', msg.movieId, 'dstLang:', msg.dstLang, 'texts count:', msg.texts?.length);

      const apiKey = await getApiKey();
      if (!apiKey) {
        LOG('No API key configured');
        return { ok: false, error: 'No API key — open extension settings' };
      }

      const texts = msg.texts;
      if (!Array.isArray(texts) || texts.length === 0) {
        return { ok: false, error: 'No texts provided' };
      }

      let translations;
      try {
        translations = await translateTexts(apiKey, texts, msg.dstLang);
      } catch (err) {
        LOG('translateTexts threw:', err);
        return { ok: false, error: 'Translation error: ' + err.message };
      }

      LOG(`Done — returning ${translations.length} translations`);
      return { ok: true, translations };

    } catch (err) {
      LOG('Unhandled error in message handler:', err);
      return { ok: false, error: 'Unexpected error: ' + err.message };
    }
  })();
});

LOG('Background ready.');
