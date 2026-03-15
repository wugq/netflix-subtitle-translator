'use strict';

class TranslationService {
  constructor(cache, logger) {
    this._cache = cache;
    this._logger = logger;
    this._langNames = {
      'en':      'English',
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
  }

  handleMessage(msg) {
    if (msg.type === 'checkApiKey') {
      return this._checkApiKey();
    }
    if (msg.type === 'getCache') {
      return Promise.resolve({ ok: true, translations: this._cache.get(msg.movieId, msg.dstLang) });
    }
    if (msg.type === 'log') {
      this._logger.appendLog(msg.source || 'content', msg.message || '');
      return;
    }
    if (msg.type === 'translate') {
      return this._translate(msg);
    }
  }

  async _checkApiKey() {
    const config = await this._getConfig();
    return { ok: !!config.apiKey };
  }

  async _getConfig() {
    const r = await browser.storage.local.get(['openaiApiKey', 'aiModel', 'aiBaseUrl']);
    return {
      apiKey:  r.openaiApiKey || '',
      model:   r.aiModel || 'gpt-4o-mini',
      baseUrl: (r.aiBaseUrl || '').trim().replace(/\/$/, '') || 'https://api.openai.com/v1',
    };
  }

  async _translate(msg) {
    try {
      const { movieId, items, dstLang, requestId } = msg;
      this._logger.vlog('Translate request — movieId:', movieId, 'dstLang:', dstLang, 'count:', items?.length, 'requestId:', requestId);

      const config = await this._getConfig();
      if (!config.apiKey) {
        this._logger.clog('No API key configured');
        return { ok: false, error: 'No API key — open extension settings' };
      }

      if (!Array.isArray(items) || items.length === 0) {
        return { ok: false, error: 'No items provided' };
      }

      const langCache = this._cache.get(movieId, dstLang) || {};
      const results = {};
      const pending = [];

      for (const item of items) {
        if (langCache[item.key]) {
          results[item.key] = langCache[item.key];
        } else {
          pending.push(item);
        }
      }

      if (pending.length > 0) {
        try {
          const newTranslations = await this._translateItems(config, pending, dstLang);
          Object.assign(results, newTranslations);
          this._cache.update(movieId, dstLang, newTranslations);
        } catch (err) {
          this._logger.clog('Translation error:', err.message);
          if (Object.keys(results).length === 0) {
            return { ok: false, error: 'Translation error: ' + err.message };
          }
        }
      }

      const keys = Object.keys(results);
      this._logger.vlog(`Done — returning ${keys.length} translations (${items.length - pending.length} from cache)`);

      return {
        ok: true,
        translations: results,
        count: keys.length,
        sample: keys.slice(0, 3).map(k => results[k]),
        requestId,
        movieId,
      };
    } catch (err) {
      this._logger.clog('Unhandled error in message handler:', err.message);
      return { ok: false, error: 'Unexpected error: ' + err.message, requestId: msg.requestId, movieId: msg.movieId };
    }
  }

  async _callOpenAI(config, keyed, dstLang) {
    const targetLang = this.langName(dstLang);
    const systemPrompt =
      `You are a subtitle translator. Translate each subtitle line to ${targetLang}.\n` +
      'Rules:\n' +
      '- Preserve \\n line breaks exactly as they appear.\n' +
      '- Keep the same keys (IDs) as input.\n' +
      '- Output ONLY valid JSON: {"translations": {"id1": "...", "id2": "...", ...}} using the same keys as input.\n' +
      '- Every input key MUST have a corresponding output key. Never skip or merge entries.';

    const keyedEntries = Object.entries(keyed);
    this._logger.vlog(`OpenAI request: ${keyedEntries.length} segments \u2192 ${targetLang}`, keyedEntries.slice(0, 3));

    const requestBody = {
      model: config.model,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: JSON.stringify(keyed) },
      ],
    };

    const res = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(requestBody),
    });

    const responseText = await res.text();

    if (!res.ok) {
      this._logger.clog('OpenAI error', res.status, responseText.slice(0, 200));
      throw new Error(`OpenAI ${res.status}: ${responseText}`);
    }

    const data = JSON.parse(responseText);
    const content = data.choices?.[0]?.message?.content;
    this._logger.vlog('OpenAI response', res.status, (content || '').slice(0, 200));

    if (!content) throw new Error('Empty OpenAI response');
    const parsed = JSON.parse(content);
    const map = parsed.translations;
    if (!map || typeof map !== 'object') throw new Error('Missing translations object');

    return map;
  }

  async _translateItems(config, items, dstLang) {
    const keyed = {};
    items.forEach(item => { keyed[item.key] = item.text; });

    let map = await this._callOpenAI(config, keyed, dstLang);
    const keys = Object.keys(map);
    this._logger.vlog(`Received ${keys.length} keys. Sample:`, keys.slice(0, 3).map(k => ({ id: k, text: map[k] })));

    const missingKeys = items.map(i => i.key).filter(key => !(key in map));
    if (missingKeys.length) {
      this._logger.clog(`Missing ${missingKeys.length} translation keys, retrying`);
      const retryKeyed = {};
      for (const key of missingKeys) retryKeyed[key] = keyed[key];
      try {
        const retryMap = await this._callOpenAI(config, retryKeyed, dstLang);
        Object.assign(map, retryMap);
        this._logger.vlog(`After retry, have ${Object.keys(map).length} keys total`);
      } catch (err) {
        this._logger.clog('Retry failed:', err.message);
      }
    }

    for (const item of items) {
      if (!(item.key in map)) map[item.key] = item.text;
    }

    return map;
  }

  langName(code) {
    if (!code) return 'the target language';
    const lower = code.toLowerCase();
    for (const [prefix, name] of Object.entries(this._langNames)) {
      if (lower === prefix || lower.startsWith(prefix + '-')) return name;
    }
    return code;
  }
}
