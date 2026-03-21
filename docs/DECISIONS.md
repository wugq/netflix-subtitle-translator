# Design Decisions & Gotchas

This document records non-obvious decisions, constraints, and bugs fixed during development. Read this before touching the areas mentioned.

---

## `manifest.json` must keep its exact name (Firefox constraint)

Firefox `about:debugging` requires the manifest file to be named exactly `manifest.json` when loading a temporary add-on from the source directory. Do not rename it (e.g. to `manifest.firefox.json`) — it will break dev-mode installation. The Chrome manifest uses `manifest.chrome.json` because Chrome loads an unpacked folder, so the build script copies it to `dist/chrome/manifest.json` at build time.

---

## movieId must always be stored and compared as String

**Rule:** Always `String(movieId)` when storing in `_currentMovieId` or comparing movie IDs.

**Why:** `movieId` from `nst_tracks` (via `JSON.parse`) is a JavaScript `number`. `routeMovieId` from the URL regex capture group is a `string`. Strict equality (`===`) fails across the number/string boundary — `82620606 === "82620606"` is `false` — causing silent mismatches that break dedup guards and pre-fetch detection.

---

## Never match `?jbv=` query param as a watch page

**Rule:** `_getRouteMovieId()` must only match `/watch/(\d+)` in `location.pathname`. Never add `?jbv=` support.

**Why:** When the user hovers over a movie tile on the Netflix browse page, the URL becomes `/browse?jbv=MOVIE_ID`. Treating this as a watch page causes false positives in `allowRecentHint`, dedup guards, and subtitle detection logic. The `nst_request_tracks` re-dispatch mechanism already handles timing gaps without needing `?jbv=` support.

---

## Alias URL handling (`nst_no_tracks` protocol)

**Problem:** Netflix browse UI sometimes links to alias movie IDs (e.g. `/watch/81696955`) that internally redirect to a canonical ID (e.g. `/watch/82620606`). The manifest fires for the canonical ID (`82620606`) before the URL updates to reflect it, triggering the pre-fetch guard.

**Solution:** The `nst_no_tracks` protocol:
1. When `onNav` fires and no cached manifest exists for `routeMovieId`, content script sends `nst_request_tracks` to `injected.js`
2. If `injected.js` has no manifest for that `movieId`, it responds with `nst_no_tracks`
3. Content script sets `_urlIdMissingManifest = true`, relaxing the pre-fetch guard exactly once
4. The next incoming `nst_tracks` (the canonical manifest) is accepted

---

## `_lastStatus` must always be set via `_setStatus()`

**Why:** An earlier version of the code referenced an undeclared `lastStatus` variable (original `content.js` line 773). Fixed by tracking `this._lastStatus` inside `_setStatus()`. If status tracking logic is touched, ensure `this._lastStatus` is always assigned there before it is read anywhere (e.g. in the `nst_src_lang` handler).

---

## Chrome MV3: `browser.runtime.onMessage` must return `true` synchronously

**Rule:** If the message handler returns a Promise, it must return `true` synchronously and call `sendResponse` when the promise resolves.

**Why:** Chrome MV3 closes the message port after the listener returns. Returning a Promise does not keep it open. See `src/background/main.js`.

---

## Two isolated JS worlds: `injected.js` vs content script

`injected.js` runs in the **Netflix page JS world** — it can access and patch `window.JSON.parse` and `window.fetch`. The content script runs in an **isolated world** and cannot read `window.__NST_LAST_MANIFEST__` or any other page-world globals. Communication between them is via `window.dispatchEvent` / `window.addEventListener` with `CustomEvent`.

---

## `PlaybackSync` uses `stateCallbacks` to avoid circular dependency

`PlaybackSync` needs to read state from `SubtitleController` and trigger actions on it (e.g. `translate`, `setStatus`). Rather than passing a reference to `SubtitleController` (circular), it receives a `stateCallbacks` object with narrow function references at construction time.

---

## Checking AI provider model lists and pricing

| Provider | Pricing URL |
|---|---|
| OpenAI | `https://developers.openai.com/api/docs/pricing` (also available as `.md` for plain text) |
| xAI | `https://docs.x.ai/developers/models` |

**Note:** When fetching OpenAI pricing programmatically, the cached input column can be misread as the output price. Always cross-check output prices manually — output is always more expensive than input.

---

## `temperature` is not sent in translation API requests

`temperature: 0` was removed from the OpenAI-compatible request body. Reasoning models (e.g. xAI's `grok-*-reasoning` variants, OpenAI's o-series) reject requests that include a `temperature` parameter and return an API error. For subtitle translation the omission has no practical effect — translation is a deterministic lookup task and model defaults produce consistent output regardless.

---

## Translation log is opt-in and gated by `transLogEnabled`

`TranslationService._appendTranslationLog()` reads `transLogEnabled` from storage before writing. The feature is off by default to avoid accumulating data users did not ask for. The flag is toggled via a checkbox in the options page Translation Log section. Log entries are capped at 200 to avoid filling storage.

---

## Class-based refactor rationale

The original `src/content.js` was 1028 lines with 40+ free state variables and 4 inline IIFEs. It was split into class-per-file under `src/content/` for maintainability. `SubtitleController` is the main orchestrator; all other classes are injected or constructed by it.
