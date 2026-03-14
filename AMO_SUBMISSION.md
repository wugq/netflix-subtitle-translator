# Firefox AMO Submission Guide

## Prerequisites
- `netflix-subtitle-translator.zip` built via `bash build.sh`
- `icons/icon128.png` for the store listing icon
- A privacy policy (required — extension sends subtitle data and API key to OpenAI)

---

## Steps

### 1. Create a Mozilla Account
Sign up at https://addons.mozilla.org if you don't have one.

### 2. Go to the Developer Hub
https://addons.mozilla.org/developers → click **"Submit a New Add-on"**.

### 3. Choose Distribution
- **On this site (AMO)** — publicly listed, requires Mozilla review
- **On your own** — self-hosted, still needs Mozilla signing but no AMO listing

### 4. Upload the ZIP
Upload `netflix-subtitle-translator.zip`. An automatic validator runs and flags any issues.

### 5. Source Code Submission
Not required for this extension — source code upload is only needed when using minifiers or bundlers (Webpack, Rollup, etc.). This extension's JS is unminified, so skip this step.

### 6. Fill Out Listing Details
| Field | Value |
|---|---|
| Name | Netflix Subtitle Translator |
| Summary | Translates Netflix subtitles to your preferred language using OpenAI GPT. |
| Description | Translates Netflix subtitles to your preferred language using OpenAI GPT. Supports 18 languages including Chinese, Japanese, Korean, Spanish, French, German, and more. |
| Categories | Up to 2 (e.g. Productivity, Accessibility) |
| Store icon | `icons/icon128.png` |
| License | Choose your preferred license |
| Privacy policy | Required — see note below |

### 7. Privacy Policy (Required)
The extension sends subtitle text and the user's OpenAI API key to OpenAI's API. Your privacy policy must disclose:
- What data is collected (subtitle text, API key)
- Where it is sent (OpenAI API only)
- That the API key is stored locally in the browser and never sent anywhere except OpenAI
- That no data is stored or shared by the extension developer

### 8. Submit for Review
Click **"Submit Version"**. Mozilla staff reviews the extension for policy compliance.
- Review timeline: a few days to a few weeks
- You will receive an email when approved or if feedback is needed

---

## After Approval
- The extension becomes publicly listed on AMO
- For future updates, go to the Developer Hub → your extension → **"Upload New Version"**
- Re-run `bash build.sh` to produce a fresh ZIP before each update

---

## Useful Links
- Developer Hub: https://addons.mozilla.org/developers
- Add-on Policies: https://extensionworkshop.com/documentation/publish/add-on-policies/
- Submission Guide: https://extensionworkshop.com/documentation/publish/submitting-an-add-on/
- Source Code Requirements: https://extensionworkshop.com/documentation/publish/source-code-submission/
