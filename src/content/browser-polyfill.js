if (typeof browser === 'undefined') {
  var browser = new Proxy(chrome, {
    get(target, prop) {
      const area = target[prop];
      if (!area || typeof area !== 'object') return area;
      return new Proxy(area, {
        get(target, prop) {
          const func = target[prop];
          if (typeof func !== 'function') return func;
          // Don't promisify listener methods or synchronous methods
          if (prop === 'addListener' || prop === 'removeListener' || prop === 'hasListener' ||
              prop === 'getURL' || prop === 'getManifest') {
            return func.bind(target);
          }
          return (...args) => new Promise((resolve, reject) => {
            func.call(target, ...args, (result) => {
              if (chrome.runtime.lastError) {
                const msg = chrome.runtime.lastError.message || '';
                // Service worker killed or extension reloaded — not a fatal error,
                // resolve with undefined so callers' ?. guards handle it gracefully.
                if (msg.includes('message port closed') ||
                    msg.includes('receiving end does not exist')) {
                  resolve(undefined);
                } else {
                  reject(new Error(msg));
                }
              } else {
                resolve(result);
              }
            });
          });
        }
      });
    }
  });
}
