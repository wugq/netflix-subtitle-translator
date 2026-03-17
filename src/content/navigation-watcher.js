'use strict';

class NavigationWatcher {
  constructor(logger) {
    this._logger = logger;
  }

  start(onNav) {
    window.addEventListener('popstate', () => setTimeout(onNav, 50));
    const wrap = (name, orig) => (...args) => {
      const result = orig.apply(history, args);
      this._logger.clog(`${name} → ${args[2] ?? '(no url)'}`);
      setTimeout(onNav, 50);
      return result;
    };
    history.pushState    = wrap('pushState',    history.pushState);
    history.replaceState = wrap('replaceState', history.replaceState);

    let _lastUrl = location.href;
    setInterval(() => {
      if (location.href !== _lastUrl) {
        this._logger.clog(`URL poll detected change: ${_lastUrl} → ${location.href}`);
        _lastUrl = location.href;
        onNav();
      }
    }, 200);
  }
}
