// Runs in the page's MAIN world at document_start: records console output and uncaught errors.
(() => {
  if (window.__browserHandLog) return;
  const L = [];
  Object.defineProperty(window, '__browserHandLog', { value: L, enumerable: false });
  const fmt = (a) => {
    try {
      if (typeof a === 'string') return a;
      if (a instanceof Error) return a.stack || String(a);
      const j = JSON.stringify(a);
      return j === undefined ? String(a) : j.slice(0, 500);
    } catch { return String(a); }
  };
  const push = (l, args) => {
    try {
      L.push({ l, t: Date.now(), m: args.map(fmt).join(' ').slice(0, 2000) });
      if (L.length > 300) L.shift();
    } catch {}
  };
  for (const lvl of ['log', 'info', 'warn', 'error', 'debug']) {
    const orig = console[lvl];
    console[lvl] = function (...a) { push(lvl, a); return orig.apply(this, a); };
  }
  addEventListener('error', (e) => push('uncaught', [`${e.message} @ ${e.filename}:${e.lineno}`]));
  addEventListener('unhandledrejection', (e) => push('unhandled', [e.reason && e.reason.stack || String(e.reason)]));
})();
