'use strict';

class NavigationWatcher {
  constructor(logger) {
    this._logger = logger;
    this._intervalId = null;
  }

  start(onNav) {
    if (this._intervalId !== null) return; // guard against double-start

    window.addEventListener('popstate', () => setTimeout(onNav, 50));
    const wrap = (name, orig) => (...args) => {
      const result = orig.apply(history, args);
      this._logger.vlog(`${name} → ${args[2] ?? '(no url)'}`);
      setTimeout(onNav, 50);
      return result;
    };
    history.pushState    = wrap('pushState',    history.pushState);
    history.replaceState = wrap('replaceState', history.replaceState);

    let _lastUrl = location.href;
    this._intervalId = setInterval(() => {
      if (location.href !== _lastUrl) {
        this._logger.vlog(`URL poll detected change: ${_lastUrl} → ${location.href}`);
        _lastUrl = location.href;
        onNav();
      }
    }, 200);
  }
}
