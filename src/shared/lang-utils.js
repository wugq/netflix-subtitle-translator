'use strict';

// Shared language-matching utility used by content script, popup, and background.
// Handles BCP 47 prefix matching: 'zh-Hans' matches 'zh', 'en-US' matches 'en', etc.
function langMatches(a, b) {
  if (!a || !b) return false;
  const la = a.toLowerCase(), lb = b.toLowerCase();
  return la === lb || la.startsWith(lb + '-') || lb.startsWith(la + '-');
}
