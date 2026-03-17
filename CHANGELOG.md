# Changelog

## 1.3

**New features**

- **Chrome MV3 support** — extension now works on Chrome via a separate MV3 manifest and service worker

**Bug fixes**

- Fixed rolling window firing duplicate translation requests on playback start
- Fixed cancelled sessions interfering with the active session's window state
- Fixed browser polyfill incorrectly promisifying `getURL`/`getManifest`, and now resolves gracefully on closed port errors instead of rejecting
- Fixed `onMessage` handler for Chrome MV3 async responses
- Show flash notice and error status when no API key is configured
- Fall back to native subtitles when API key is missing but Netflix provides the destination language natively
- Added consecutive duplicate deduplication in the background logger

---

## 1.2

**New features**

- **Dual subtitles** — new popup toggle "Show original text when translating" displays the source-language text in smaller text below the translation, making it easy to compare or verify accuracy
- **Subtitle style presets** — choose between Classic (dark background), Shadow, and Yellow styles from the popup
- **AI provider and model selection** — switch between OpenAI and xAI (Grok) and pick your preferred model from the options page
- **Cache persistence** — translated subtitles are saved and restored across sessions so you never re-translate the same content; a clear cache button is available in the options page
- **Netflix language indicators** — the destination language dropdown now shows which languages are natively available on Netflix (●), which need to be selected in Netflix first (○), and which will use AI (✦)
- **Not on Netflix notice** — the popup now shows a clear message when the active tab is not Netflix

**Improvements**

- Subtitle no longer jumps up when the progress bar appears unless it would actually overlap
- Popup UI and status messages improved for clarity
- xAI host permission fixed so Grok translation works correctly
- Verbose logging removed from production builds

**Bug fixes**

- Fixed subtitle display state not resetting correctly when leaving a watch page
- Fixed font size changes not applying to the original-language text in dual subtitle mode

---

## 1.1

**New features**

- Modular source code rewrite for improved stability and maintainability
- AI translation session cancels cleanly on pause, seek, and language change
- Rolling translation window with lookahead — subtitles ahead of playback are pre-translated automatically
- Source language auto-detected from the active Netflix track
- Language change (source or destination) restarts translation from the current position
- Verbose logging toggle in advanced settings

**Bug fixes**

- Fixed subtitle ordering when multiple segments share the same start time
- Fixed misleading "translating" status when segments were already cached
- Fixed destination language race condition on rapid changes

---

## 1.0

- Initial release — AI-powered subtitle translation for Netflix using OpenAI
- Supports 18 destination languages including Chinese, Japanese, Korean, Spanish, French, German, and more
- Configurable font size, position, and translation window
- Pause/resume translation toggle in popup
