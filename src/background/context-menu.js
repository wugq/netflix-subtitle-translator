'use strict';

const LANGUAGES = [
  { value: 'en',      label: 'English' },
  { value: 'zh-Hans', label: 'Simplified Chinese' },
  { value: 'zh-Hant', label: 'Traditional Chinese' },
  { value: 'ja',      label: 'Japanese' },
  { value: 'ko',      label: 'Korean' },
  { value: 'es',      label: 'Spanish' },
  { value: 'fr',      label: 'French' },
  { value: 'de',      label: 'German' },
  { value: 'pt',      label: 'Portuguese' },
  { value: 'it',      label: 'Italian' },
  { value: 'ru',      label: 'Russian' },
  { value: 'ar',      label: 'Arabic' },
  { value: 'hi',      label: 'Hindi' },
  { value: 'th',      label: 'Thai' },
  { value: 'vi',      label: 'Vietnamese' },
  { value: 'id',      label: 'Indonesian' },
  { value: 'nl',      label: 'Dutch' },
  { value: 'pl',      label: 'Polish' },
  { value: 'tr',      label: 'Turkish' },
];

const LANG_PREFIX = 'lang-';

async function createMenus() {
  await browser.contextMenus.removeAll();

  browser.contextMenus.create({
    id: 'toggle-translation',
    title: 'Translation enabled',
    type: 'checkbox',
    checked: true,
    contexts: ['all'],
    documentUrlPatterns: ['*://www.netflix.com/*'],
  });

  browser.contextMenus.create({
    id: 'show-original',
    title: 'Show original text',
    type: 'checkbox',
    checked: false,
    contexts: ['all'],
    documentUrlPatterns: ['*://www.netflix.com/*'],
  });

  browser.contextMenus.create({
    id: 'lang-parent',
    title: 'Destination language',
    contexts: ['all'],
    documentUrlPatterns: ['*://www.netflix.com/*'],
  });

  for (const lang of LANGUAGES) {
    browser.contextMenus.create({
      id: LANG_PREFIX + lang.value,
      parentId: 'lang-parent',
      title: lang.label,
      type: 'radio',
      checked: lang.value === 'en',
      contexts: ['all'],
      documentUrlPatterns: ['*://www.netflix.com/*'],
    });
  }
}

function langMatches(a, b) {
  if (!a || !b) return false;
  const la = a.toLowerCase(), lb = b.toLowerCase();
  return la === lb || la.startsWith(lb + '-') || lb.startsWith(la + '-');
}

function langIndicator(value, langStatus) {
  if (!langStatus) return '✦';
  const { nativeAvailable = [], needsSelection = [] } = langStatus;
  if (nativeAvailable.some(l => langMatches(l, value))) return '●';
  if (needsSelection.some(l => langMatches(l, value)))  return '○';
  return '✦';
}

async function syncMenuState() {
  const r = await browser.storage.local.get(['translationEnabled', 'showOriginalText', 'dstLang', 'netflixLangStatus']);
  browser.contextMenus.update('toggle-translation', { checked: r.translationEnabled !== false });
  browser.contextMenus.update('show-original',      { checked: !!r.showOriginalText });
  const activeLang  = r.dstLang || 'en';
  const langStatus  = r.netflixLangStatus || null;
  for (const lang of LANGUAGES) {
    const indicator = langIndicator(lang.value, langStatus);
    browser.contextMenus.update(LANG_PREFIX + lang.value, {
      checked: lang.value === activeLang,
      title: `${indicator} ${lang.label}`,
    });
  }
}

browser.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === 'toggle-translation') {
    browser.storage.local.set({ translationEnabled: info.checked });
  } else if (info.menuItemId === 'show-original') {
    browser.storage.local.set({ showOriginalText: info.checked });
  } else if (info.menuItemId.startsWith(LANG_PREFIX)) {
    browser.storage.local.set({ dstLang: info.menuItemId.slice(LANG_PREFIX.length) });
  }
});

// Firefox: sync state just before the menu renders
if (browser.contextMenus.onShown) {
  browser.contextMenus.onShown.addListener((_info, _tab) => {
    syncMenuState()
      .then(() => browser.contextMenus.refresh())
      .catch(() => {});
  });
}

// Chrome: sync state on every relevant storage change so checkboxes stay accurate
browser.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (!('translationEnabled' in changes) && !('showOriginalText' in changes) && !('dstLang' in changes) && !('netflixLangStatus' in changes)) return;
  syncMenuState().catch(() => {});
});

// Create menus on install/update only (avoids duplicate-ID errors on MV3 service worker revival)
browser.runtime.onInstalled.addListener(() => {
  createMenus().catch(() => {});
});
