# Architecture

## Overview

A browser extension (Chrome MV3 / Firefox) that intercepts Netflix subtitle manifests and optionally translates them using an AI API (OpenAI-compatible). It has three execution contexts that communicate via DOM events and `browser.runtime.sendMessage`.

```
┌─────────────────────────────────────────────────────┐
│  Netflix page context (injected.js)                 │
│  - Patches JSON.parse to capture timedtexttracks    │
│  - Patches fetch to detect active subtitle language │
│  - Dispatches DOM events: nst_tracks, nst_src_lang, │
│    nst_no_tracks                                    │
└────────────────────┬────────────────────────────────┘
                     │ DOM CustomEvents
┌────────────────────▼────────────────────────────────┐
│  Content script (src/content/)                      │
│  Entry: SubtitleController (main orchestrator)      │
│  - Receives nst_tracks / nst_src_lang events        │
│  - Manages subtitle overlay, playback sync          │
│  - Sends translate / checkApiKey to background      │
└────────────────────┬────────────────────────────────┘
                     │ browser.runtime.sendMessage
┌────────────────────▼────────────────────────────────┐
│  Background service worker (src/background/)        │
│  Entry: main.js                                     │
│  - TranslationService: calls AI API                 │
│  - TranslationCache: in-memory + storage cache      │
│  - Logger: forwards logs to content script          │
└─────────────────────────────────────────────────────┘
```

## Content-side class map (`src/content/`)

| Class | File | Responsibility |
|---|---|---|
| `SubtitleController` | `subtitle-controller.js` | Main orchestrator. Owns all state, wires everything together. |
| `PlaybackSync` | `playback-sync.js` | Watches video element events (play/pause/seek/tick), emits EventBus events, drives rolling translation window. Uses `stateCallbacks` to avoid circular dep with SubtitleController. |
| `SubtitleOverlay` | `subtitle-overlay.js` | DOM overlay that renders translated subtitle text over the Netflix player. |
| `SegmentStore` | `segment-store.js` | Stores parsed subtitle segments; tracks which are translated; returns pending indices for a time window. |
| `TtmlLoader` | `ttml-loader.js` | Fetches and parses TTML subtitle files from Netflix CDN URLs. |
| `TtmlParser` | `ttml-parser.js` | Parses TTML XML into segment objects `{ start, end, text }`. |
| `TrackResolver` | `track-resolver.js` | Given available tracks + src/dst lang, determines the translation mode and which TTML URL to load. |
| `TranslationSession` | `translation-session.js` | Manages an AbortSignal-based cancellation token for in-flight translation requests. |
| `SettingsManager` | `settings-manager.js` | Reads/writes `browser.storage` settings; invokes callbacks on change. |
| `NavigationWatcher` | `navigation-watcher.js` | Detects Netflix SPA navigation via history API patching + 200ms URL polling. |
| `EventBus` | `event-bus.js` | Simple in-process pub/sub for decoupled signalling between classes. |
| `SerialQueue` | `serial-queue.js` | Ensures async operations (e.g. mode changes) run one at a time. |
| `Logger` | `logger.js` | Namespaced logger with verbose mode toggle. |

## Background class map (`src/background/`)

| Class | File | Responsibility |
|---|---|---|
| `TranslationService` | `translation-service.js` | Handles `translate` / `checkApiKey` messages; calls OpenAI-compatible API. When translation logging is enabled, appends each API call result to `nstTranslationLog` in storage. |
| `TranslationCache` | `translation-cache.js` | LRU in-memory cache + `browser.storage` persistence for translations. |
| `Logger` | `logger.js` | Appends verbose log entries to `browser.storage.local` (`nstLogBuffer`) for inspection via the options page. |

**Non-class background files:**

| File | Role |
|---|---|
| `service-worker.js` | MV3 bundle entry point — uses `importScripts` to load all background files in order. |
| `context-menu.js` | Manages the right-click context menu (toggle translation, show original, destination language). Not a class — module-level functions and event listeners. |
| `main.js` | Wires up `browser.runtime.onMessage` and `browser.storage.onChanged` using the classes above. |

## Translation modes

`TrackResolver.determineMode()` returns one of three modes:

| Mode | Meaning |
|---|---|
| `native` | Netflix has a TTML file for the dst lang — load it directly, no AI needed. |
| `ai` | No native dst lang track — must AI-translate from src lang. |
| `passthrough` | src and dst lang are the same — show native subtitles as-is. |

## Data flow for a new video

1. `injected.js` intercepts `JSON.parse` → captures `timedtexttracks` → dispatches `nst_tracks`
2. `SubtitleController._listenInjected()` receives `nst_tracks` → caches manifest by `movieId`
3. `_handleTracks()` validates (pre-fetch guard, alias URL guard) → calls `_applyMode()`
4. `_applyMode()` → `TtmlLoader.load()` fetches TTML → `SegmentStore.load()` stores segments
5. `PlaybackSync.start()` begins watching the video element
6. On play/seek: `_initialTranslation()` → batched `translate` messages to background
7. Background `TranslationService` calls AI API → returns translations
8. `SegmentStore.applyTranslations()` fills in translated text → `SubtitleOverlay` renders it

## SPA navigation

Netflix is a SPA. Key timing problem: **the manifest for the next video fires before the URL changes.**

- `SubtitleController` caches all manifests by `movieId` in `this._manifestCache`
- `NavigationWatcher` fires `onNav` when URL changes
- `onNav` looks up the new `routeMovieId` in `this._manifestCache` and re-processes it
- If not cached: sends `nst_request_tracks` to `injected.js` to re-dispatch from its own map
- Manifest cache is also persisted to `browser.storage.local` (up to 50 entries) so re-navigation after reload works
