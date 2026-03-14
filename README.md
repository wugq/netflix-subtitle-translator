# Netflix Subtitle Translator

A Firefox browser extension that translates Netflix subtitles in real-time using OpenAI's GPT API. Translated subtitles are displayed in a custom overlay directly on the video player — no leaving Netflix, no switching tabs.

## Features

- **Real-time AI translation** using OpenAI GPT (gpt-4o-mini)
- **Smart mode detection** — uses Netflix's native subtitles when available, falls back to AI translation
- **Progressive buffering** — subtitles start appearing quickly while translation continues in the background
- **Translation caching** — subtitles are cached per movie/language pair so you don't re-translate on rewatch
- **Batch processing** — minimizes API calls by translating up to 50 subtitle segments per request
- **Customizable display** — adjust font size and vertical position from the popup
- **18 supported languages** — Chinese (Simplified & Traditional), Japanese, Korean, Spanish, French, German, Portuguese, Italian, Russian, Arabic, Hindi, Thai, Vietnamese, Indonesian, Dutch, Polish, Turkish

## How It Works

The extension intercepts Netflix's subtitle loading process at the browser level:

1. **`injected.js`** patches `JSON.parse` and `window.fetch` in Netflix's page context to capture subtitle manifest data and detect which language track is active
2. **`content.js`** fetches and parses the subtitle files (TTML/WebVTT), determines the translation mode, and renders translated text in a custom overlay synced to the video
3. **`background.js`** handles OpenAI API calls, batching, retry logic, and persistent caching

### Translation Modes

| Mode | When | API Used |
|---|---|---|
| Passthrough | Source = destination language | None |
| Native | Netflix has subtitles in your destination language | None |
| AI | No native subtitles available | OpenAI GPT |

When AI translation is needed, the extension prefers English as the source language (rather than the audio language) for better translation quality.

## Installation

### From Firefox Add-ons (AMO)

*Coming soon — submission in progress.*

### Manual Installation (Developer Mode)

1. Clone this repo
2. Run the build script:
   ```bash
   bash build.sh
   ```
3. In Firefox, go to `about:debugging` → **This Firefox** → **Load Temporary Add-on**
4. Select the generated `netflix-subtitle-translator.zip` or the `manifest.json` file

## Setup

1. Get an OpenAI API key from [platform.openai.com](https://platform.openai.com)
2. Click the extension icon and open **Settings**
3. Paste your API key and click **Save**
4. Open any Netflix video and turn on subtitles in the Netflix player
5. Select your destination language from the extension popup
6. Translation starts automatically

## Usage

Click the extension icon while watching Netflix to:

- **Toggle translation** on/off
- **Select destination language**
- **Adjust font size** and subtitle vertical position
- **View translation status** (buffering progress, current mode)

Advanced settings (lookahead window, debug logging) are available in the full options page.

## Privacy

- Your OpenAI API key is stored only in your local browser storage
- Subtitle text is sent only to Netflix's CDN (to fetch subtitle files) and OpenAI's API for translation
- No data is collected by this extension or its developer

### Network Requests

| Destination | Purpose |
|---|---|
| `*.nflxso.net`, `*.nflxvideo.net` | Fetch subtitle files from Netflix CDN |
| `api.openai.com` | Translate subtitles (only when AI mode is active) |

## Browser Support

- **Firefox** (primary)
- **Chrome** (secondary, manifest v2 with polyfill)

## Requirements

- Firefox or Chrome browser
- An OpenAI API key (usage costs apply based on OpenAI's pricing)

## License

MIT
