// Independent of the module graph: a failed bootstrap dependency must still
// leave a visible way to retry. Never treat later media/worker errors as startup.
(() => {
  const app = document.getElementById('app');
  const fallback = document.getElementById('startup-fallback');
  if (!app || !fallback) return;
  let finished = false;
  const timer = setTimeout(fail, 15000);
  function release() {
    app.removeAttribute('data-initializing');
    app.removeAttribute('aria-busy');
    app.removeAttribute('inert');
  }
  function fail() {
    if (finished) return;
    clearTimeout(timer);
    release();
    app.hidden = true;
    fallback.hidden = false;
  }
  function ready() {
    finished = true;
    clearTimeout(timer);
    release();
    app.hidden = false;
    fallback.hidden = true;
    cleanup();
  }
  function error(event) {
    // Vite moves the built entry into <head> and drops its custom attributes.
    // Resolve at error time: in development the marked entry follows this guard
    // in the document, and the first module in <head> is Vite's own client.
    const entry = document.querySelector('script[data-startup-entry]')
      ?? document.querySelector('script[type="module"][src]');
    if (event.target === entry) fail();
  }
  function cleanup() {
    clearTimeout(timer);
    window.removeEventListener('error', error, true);
    window.removeEventListener('voidplayer:startup-failed', fail);
    window.removeEventListener('voidplayer:startup-ready', ready);
    window.removeEventListener('pagehide', cleanup);
  }
  window.addEventListener('error', error, true);
  window.addEventListener('voidplayer:startup-failed', fail);
  // A slow graph may recover after the timeout. Restore the actual app then.
  window.addEventListener('voidplayer:startup-ready', ready);
  window.addEventListener('pagehide', cleanup, { once: true });
})();
