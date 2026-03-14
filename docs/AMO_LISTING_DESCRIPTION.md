Netflix Subtitle Translator uses OpenAI GPT to translate Netflix subtitles into your preferred language in real time — without leaving the Netflix player.

**How it works**

The extension intercepts the subtitle track playing in the Netflix player, sends the text to OpenAI's API for translation, and displays the result in a clean overlay on top of the video. Translation is buffered progressively to minimise API calls. If your chosen language is already natively available on Netflix, no AI translation is used and no API calls are made.

**Supported languages (18)**

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

- Real-time GPT-powered translation with progressive buffering
- Customisable subtitle font size and vertical position
- Adjustable translation look-ahead window (how far ahead subtitles are pre-translated)
- Pause and resume translation at any time from the popup
- On-screen AI notice indicator (can be hidden)
- Optional console and verbose debug logging for troubleshooting

**Requirements**

An OpenAI API key is required. Enter it once in the extension settings — it is stored locally in your browser and is never shared with anyone other than OpenAI.

**Privacy**

Subtitle text is sent to the OpenAI API solely for translation. No data is collected or stored by the extension developer.
