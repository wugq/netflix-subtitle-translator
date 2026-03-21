# Netflix Subtitle Translator

A browser extension for Firefox and Chrome that translates Netflix subtitles in real-time using AI. Translated subtitles are displayed in a custom overlay directly on the video player — no leaving Netflix, no switching tabs.

## Features

- **Real-time AI translation** — works with OpenAI and xAI; choose from multiple models with descriptions and indicative pricing shown in settings
- **Smart mode detection** — uses Netflix's native subtitles when available, falls back to AI translation
- **Progressive buffering** — subtitles start appearing quickly while translation continues in the background
- **Translation caching** — subtitles are cached per movie/language pair so you don't re-translate on rewatch
- **Batch processing** — minimizes API calls by translating up to 50 subtitle segments per request
- **Dual subtitles** — optionally show the original source text below the translation for comparison
- **Customizable display** — adjust font size, vertical position, and subtitle style (Classic, Shadow, Yellow)
- **Language availability indicators** — the popup shows which destination languages Netflix has natively (●), which need selecting in Netflix first (○), and which require AI (✦)
- **19 supported languages** — English, Chinese (Simplified & Traditional), Japanese, Korean, Spanish, French, German, Portuguese, Italian, Russian, Arabic, Hindi, Thai, Vietnamese, Indonesian, Dutch, Polish, Turkish

## How It Works

The extension intercepts Netflix's subtitle loading process at the browser level:

1. **`injected.js`** patches `JSON.parse` and `window.fetch` in Netflix's page context to capture subtitle manifest data and detect which language track is active
2. **`src/content/`** fetches and parses the subtitle files (TTML format), determines the translation mode, and renders translated text in a custom overlay synced to the video playback position
3. **`src/background/`** handles AI API calls, batching, and persistent caching

### Translation Modes

| Mode | When | API Used |
|---|---|---|
| Passthrough | Source = destination language | None |
| Native | Netflix has subtitles in your destination language | None |
| AI | No native subtitles available | OpenAI or xAI |

When AI translation is needed, the extension prefers English as the source language (rather than the audio language) for better translation quality.

## Installation

### From Firefox Add-ons (AMO)

Install from [Firefox Add-ons (AMO)](https://addons.mozilla.org/en-US/firefox/addon/netflix-subtitle-translator/).

### Manual Installation (Developer Mode)

1. Clone this repo
2. Run the build script:
   ```bash
   bash build.sh
   ```
3. In Firefox, go to `about:debugging` → **This Firefox** → **Load Temporary Add-on**
4. Select the generated `netflix-subtitle-translator.zip` or the `manifest.json` file

## Supported AI Providers

| Provider | Models |
|---|---|
| OpenAI | gpt-4.1-nano, gpt-5-nano, gpt-5-mini, gpt-5.4-nano, gpt-4o-mini, gpt-4.1-mini, gpt-4.1 |
| xAI | grok-4-1-fast-non-reasoning, grok-4.20-non-reasoning |

Model descriptions and indicative pricing are shown in the settings page. Prices change over time — always check the provider's official pricing page before use.

## Setup

1. Get an API key from your chosen provider
2. Click the extension icon and open **Settings**
3. Select your provider, choose a model, paste your API key, and click **Save**
4. Open any Netflix video and turn on subtitles in the Netflix player
5. Select your destination language from the extension popup
6. Translation starts automatically

## Usage

Click the extension icon while watching Netflix to:

- **Toggle translation** on/off
- **Select destination language** — indicators show Netflix availability at a glance
- **Show original text when translating** — displays source-language text below the translation
- **Adjust font size** and subtitle vertical position
- **Choose subtitle style** — Classic (dark background), Shadow, or Yellow
- **View translation status** — shows buffering progress and current mode

Advanced settings (lookahead window, clear cache, debug logging) are available in the full options page.

## Privacy

- Your API key is stored only in your local browser storage
- Subtitle text is sent only to Netflix's CDN (to fetch subtitle files) and your configured AI provider for translation
- No data is collected by this extension or its developer

### Network Requests

| Destination | Purpose |
|---|---|
| `*.nflxso.net`, `*.nflxvideo.net` | Fetch subtitle files from Netflix CDN |
| Your configured AI provider | Translate subtitles (only when AI mode is active) |

## Browser Support

- **Firefox** (primary, MV2)
- **Chrome** (MV3, via separate manifest)

## Requirements

- Firefox or Chrome browser
- An API key from your chosen provider (usage costs vary by provider)

## For Developers

- [Code Style](docs/CODE_STYLE.md) — comment rules, file organisation
- [Architecture](docs/ARCHITECTURE.md) — execution contexts, class map, data flow, SPA navigation handling
- [Design Decisions](docs/DECISIONS.md) — known gotchas, non-obvious constraints, historical bug fixes

## License

MIT
