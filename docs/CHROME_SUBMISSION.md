# Chrome Web Store Submission Guide

## Prerequisites
- `dist/chrome/` directory built via `bash build.sh`
- `icons/icon128.png` for the store listing icon
- A privacy policy URL (required — extension sends subtitle data to OpenAI/xAI)

---

## Single Purpose Statement

> Chrome requires every extension to have a single purpose that is narrow and easy to understand.

**This extension has one purpose: translate Netflix subtitles.**

It intercepts the subtitle track playing in the Netflix player, sends the text to a user-configured AI provider (OpenAI or xAI), and displays the translated subtitles as an overlay on the video. Every feature in the extension — dual subtitles, style presets, language selection, translation cache, right-click menu — directly supports that one purpose.

**What this extension does not do:**
- It does not work on any site other than netflix.com
- It does not modify Netflix's player, UI, or any responses
- It does not collect, store, or transmit any data beyond what is needed for translation
- It has no social, analytics, ad-blocking, or unrelated functionality

---

## Steps

### 1. Create a Google Account / Developer Account
Register at https://chrome.google.com/webstore/devconsole. A one-time $5 developer registration fee applies.

### 2. Package the Extension
Run `bash build.sh` to produce the Chrome build in `dist/chrome/`. Zip the contents of that directory (not the directory itself):
```
cd dist/chrome && zip -r ../../netflix-subtitle-translator-chrome.zip .
```

### 3. Upload the ZIP
In the Chrome Web Store Developer Dashboard, click **"New Item"** and upload the ZIP.

### 4. Fill Out Listing Details

| Field | Value |
|---|---|
| Name | Netflix Subtitle Translator |
| Summary (132 chars max) | Translates Netflix subtitles in real time using AI. Supports OpenAI and xAI. Works on Netflix only. |
| Category | Productivity |
| Language | English |
| Store icon | `icons/icon128.png` (128×128 PNG) |
| Screenshots | At least 1 screenshot (1280×800 or 640×400) |
| Privacy policy URL | Required — see note below |

### 5. Single Purpose Justification (Developer Notes field)
Paste the following into the "Notes for reviewer" or equivalent field:

> This extension has a single purpose: translate Netflix subtitles into the user's preferred language using a user-supplied AI API key. All features (dual subtitles, style options, language picker, translation cache, context menu) are in direct service of subtitle translation on netflix.com only. The extension does not operate on any other website and performs no unrelated functions.

### 6. Privacy Policy (Required)
The extension sends subtitle text and the user's API key to OpenAI or xAI. Your privacy policy must disclose:
- What data is sent: subtitle cue text, user's own API key
- Where it is sent: api.openai.com or api.x.ai only, based on user configuration
- That the API key is stored locally in `chrome.storage.local` and never sent anywhere except the user's chosen provider
- That the extension developer collects no data

### 7. Permissions Justification
The Chrome Web Store has **separate justification fields for named permissions** and a **single combined field for all host permissions**.

**Named permissions** (one field each):

| Permission | Justification |
|---|---|
| `storage` | Saves user settings (API key, language, style) and translation cache locally |
| `tabs` | Detects when the user navigates to or away from a Netflix watch page |
| `contextMenus` | Adds a right-click menu on Netflix to toggle translation and switch language without opening the popup |

**Host permissions** (one combined text field for all URL patterns):

> This extension operates exclusively on netflix.com to translate subtitles. It requires access to Netflix's CDN domains (nflxso.net, nflxvideo.net, nflxext.com) to fetch subtitle files served from those hosts. It requires access to api.openai.com and api.x.ai to send subtitle text for translation using the API key the user provides. No requests are made to any other host.

### 8. Submit for Review
Click **"Submit for Review"**. Google's automated systems and human reviewers will check for policy compliance.
- Review timeline: a few business days, sometimes longer
- You will receive an email when approved or if changes are requested

---

## After Approval
- The extension becomes publicly listed on the Chrome Web Store
- For future updates, go to the Developer Dashboard → your extension → **"Upload New Package"**
- Re-run `bash build.sh` and re-zip before each update

---

## Useful Links
- Developer Dashboard: https://chrome.google.com/webstore/devconsole
- Program Policies: https://developer.chrome.com/docs/webstore/program-policies/
- Single Purpose Policy: https://developer.chrome.com/docs/webstore/program-policies/quality-guidelines/
- Permission Guidance: https://developer.chrome.com/docs/webstore/permission-warnings/
