# Privacy Policy

**Netflix Subtitle Translator**
Last updated: March 20, 2026

---

## Overview

Netflix Subtitle Translator is a browser extension that translates Netflix subtitles into your preferred language using an AI provider of your choice (OpenAI or xAI). This policy explains exactly what data the extension handles, where it goes, and what the developer does (and does not) collect.

---

## Data the Extension Handles

### Subtitle text
When translation is active, the extension reads subtitle cue text from the Netflix subtitle track currently playing. This text is sent to the AI provider you have configured (OpenAI or xAI) solely to obtain a translation. It is not sent anywhere else and is not stored by the developer.

### Your API key
You supply your own API key from OpenAI or xAI in the extension's settings page. This key is:
- Stored locally in your browser using `browser.storage.local` / `chrome.storage.local`
- Sent only to the API endpoint of your chosen provider (`api.openai.com` or `api.x.ai`) as part of translation requests
- Never transmitted to the extension developer or any other party

### Translation cache
Translated subtitles are cached locally in `browser.storage.local` / `chrome.storage.local` so the same content is not re-translated. This data stays on your device and is never uploaded anywhere. You can clear the cache at any time from the extension's options page.

### Extension settings
Your preferences (language selection, font size, style preset, etc.) are stored locally in `browser.storage.local` / `chrome.storage.local`. They are not synced, shared, or transmitted.

---

## Data the Developer Does Not Collect

The extension developer (wugq.dev) does not collect, receive, store, or have access to any of the following:

- Subtitle text or translations
- Your API key
- Your Netflix account information, credentials, or viewing history
- Any usage analytics, telemetry, or crash reports
- Any personally identifiable information

---

## Third-Party Services

Translation requests are sent directly from your browser to the AI provider you configure. The extension developer is not a party to those requests. Please review the privacy policies of your chosen provider:

- **OpenAI:** https://openai.com/policies/privacy-policy
- **xAI:** https://x.ai/legal/privacy-policy

---

## Permissions

The extension requests the following browser permissions:

| Permission | Purpose |
|---|---|
| `storage` | Save settings, API key, and translation cache locally on your device |
| `tabs` | Detect navigation to and from Netflix watch pages |
| `contextMenus` | Add a right-click menu on Netflix for quick access to translation controls |
| `*://www.netflix.com/*` | Operate on Netflix pages only |
| `*://*.nflxvideo.net/*`, `*://*.nflxso.net/*`, `*://*.nflxext.com/*` | Fetch subtitle files from Netflix's content delivery network |
| `https://api.openai.com/*` | Send subtitle text to OpenAI for translation (only if OpenAI is selected) |
| `https://api.x.ai/*` | Send subtitle text to xAI for translation (only if xAI is selected) |

The extension does not request access to your browsing history, bookmarks, clipboard, camera, microphone, or any other sensitive browser capability.

---

## Contact

If you have questions about this privacy policy, please open an issue on the project's GitHub repository.
