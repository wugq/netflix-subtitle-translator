// Chrome compatibility polyfill (Handles Promise vs Callback mismatch)
if (typeof browser === 'undefined') {
  var browser = new Proxy(chrome, {
    get(target, prop) {
      const area = target[prop];
      if (!area || typeof area !== 'object') return area;
      return new Proxy(area, {
        get(target, prop) {
          const func = target[prop];
          if (typeof func !== 'function') return func;
          // Don't promisify listener methods
          if (prop === 'addListener' || prop === 'removeListener' || prop === 'hasListener') {
            return func.bind(target);
          }
          return (...args) => new Promise((resolve, reject) => {
            func.call(target, ...args, (result) => {
              if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
              else resolve(result);
            });
          });
        }
      });
    }
  });
}
