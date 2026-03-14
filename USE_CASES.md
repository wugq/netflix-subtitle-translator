# Netflix Subtitle Translator — Requirements

This document defines the intended behavior of the extension. Both developers and AI assistants should treat it as the source of truth when making changes.

---

## Platform

- Netflix only.

---

## Subtitle Display

- When the addon is active, Netflix's native subtitle container is always hidden.
- All subtitles are rendered in our custom overlay container.
- The user can adjust the overlay's font size and vertical position.

---

## Translation

- AI translation is used to convert subtitles to the destination language.
- The user selects the **source language** from Netflix's native player.
- The user selects the **destination language** from our addon.
- When AI translation is needed, always use the **English** subtitle track as the input to the AI service, as it produces better results. If English is not available, fall back to the user's selected source language.
- If source and destination language are the same, do not translate — display the source text as-is in our container.
- If the destination language is natively available in Netflix's player, do not use AI translation — use Netflix's own subtitle for that language and display it in our container. The user's source language selection is preserved.
- The user can enable or disable translation at any time. When disabled, the source language text (from Netflix) is shown in our container without translation.
- If no API key is configured, no AI requests are sent. The popup status area must reflect this state.

---

## Translation Buffer (UX)

- On load, translation starts immediately with a small initial chunk (first few seconds) so subtitles appear quickly.
- The translated buffer grows progressively up to a configured window size.
- Once the buffer is full (translated content covers the lookahead window), no further AI requests are sent until the buffer is consumed.
- This limits unnecessary API usage.

---

## Key Events

The following events must trigger appropriate subtitle and translation state updates:

| Event | Expected behavior |
|-------|-------------------|
| Player load | Begin subtitle interception and start translation buffer |
| User seeks | Cancel in-flight translation; restart buffer from new position |
| User changes source language | Reset and restart translation from current position |
| User changes destination language | Reset and restart translation from current position |
| User pauses/resumes translation | Stop or resume AI requests; overlay switches between translated and source text |

---

## Maintenance

When changing logic that affects any rule above, update this document in the same commit.
