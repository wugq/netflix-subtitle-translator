Netflix Subtitle Translator uses AI to translate Netflix subtitles into your preferred language in real time — without leaving the Netflix player. Supports OpenAI (GPT) and xAI (Grok) as translation providers.

**How it works**

The extension intercepts the subtitle track playing in the Netflix player, sends the text to your chosen AI provider for translation, and displays the result in a clean overlay on top of the video. Translation is buffered progressively to minimise API calls. If your chosen language is already natively available on Netflix, no AI translation is used and no API calls are made.

**Supported languages (19)**

- English
- Simplified Chinese (简体中文)
- Traditional Chinese (繁體中文)
- Japanese (日本語)
- Korean (한국어)
- Spanish (Español)
- French (Français)
- German (Deutsch)
- Portuguese (Português)
- Italian (Italiano)
- Russian (Русский)
- Arabic (العربية)
- Hindi (हिन्दी)
- Thai (ภาษาไทย)
- Vietnamese (Tiếng Việt)
- Indonesian (Bahasa Indonesia)
- Dutch (Nederlands)
- Polish (Polski)
- Turkish (Türkçe)

**Features**

- Real-time AI translation with progressive buffering — subtitles appear quickly while more are translated in the background
- Choose your AI provider: OpenAI (gpt-4o-mini) or xAI (grok-3-mini)
- Dual subtitles — optionally show the original source text below the translation
- Subtitle style presets — Classic (dark background), Shadow, or Yellow
- Language availability indicators — the popup shows which languages Netflix has natively (●), which need selecting in Netflix first (○), and which require AI (✦)
- Customisable font size, vertical position, and translation look-ahead window
- Pause and resume translation at any time from the popup
- On-screen notice when AI translation starts (can be disabled)
- Translation cache — subtitles are saved locally so you never re-translate the same content

**Requirements**

An API key from OpenAI or xAI is required. Enter it once in the extension settings — it is stored locally in your browser and never shared with anyone other than your chosen provider.

**Privacy**

Subtitle text is sent to your configured AI provider solely for translation. No data is collected or stored by the extension developer.
