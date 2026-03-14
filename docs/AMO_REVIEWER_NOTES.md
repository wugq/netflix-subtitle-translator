# AMO Reviewer Notes

## Why the extension patches window.fetch and JSON.parse

The extension needs to intercept Netflix's internal subtitle manifest — a JSON response
that Netflix delivers via its own player API. This manifest contains the list of available
subtitle tracks and their download URLs for the currently playing title.

There is no standard browser API (such as a WebRequest response body reader) that allows
a content script to read the body of cross-origin XHR/fetch responses made by the page
itself. The only reliable way to access this data is to inject a script into the page
context (via web_accessible_resources) and patch the two global entry points through
which Netflix processes this response:

- **JSON.parse** — Netflix passes the raw subtitle manifest JSON through JSON.parse.
  Patching it lets the extension read the parsed track list (language codes and subtitle
  file URLs) before passing the data through unmodified to Netflix.

- **window.fetch** — Once the track URLs are known, patching fetch lets the extension
  detect which subtitle file Netflix actually loads (i.e. the user's active subtitle
  language), without making any additional network requests.

## What the extension does with this data

1. The subtitle track list (language codes + URLs) is dispatched as a CustomEvent to the
   content script. No network request is made.
2. When a subtitle URL is fetched by Netflix, the corresponding language code is
   dispatched as a CustomEvent. Again, no additional network request is made.
3. The content script uses the subtitle URLs to fetch the subtitle file (a plain-text
   TTML/WebVTT file from Netflix's CDN), extracts the cue text, and sends it to the
   OpenAI API for translation using the API key the user provided in settings.

## What the extension does NOT do

- It does not read, transmit, or store any user credentials, cookies, or session tokens.
- It does not exfiltrate any Netflix account or payment information.
- It does not modify any Netflix API response — both JSON.parse and fetch return exactly
  what they would have returned without the patch.
- It does not make any network requests other than to Netflix's own CDN (to fetch the
  subtitle file) and to api.openai.com (to translate the text).
- The OpenAI API key is stored exclusively in browser.storage.local and is never sent
  anywhere except api.openai.com.

## Summary of network requests made by the extension

| Destination          | Purpose                                 | Triggered by         |
|----------------------|-----------------------------------------|----------------------|
| Netflix CDN (*.nflxso.net, *.nflxvideo.net) | Download subtitle file  | User plays a video   |
| api.openai.com       | Translate subtitle text                 | User-configured      |

All other network activity on netflix.com is performed by Netflix's own player, not by
this extension.
