import { initializeLanguage, t, msg } from './i18n.ts';
export {};
function revealApp() {
  const app = document.getElementById('app')!;
  app.removeAttribute('data-initializing');
  app.removeAttribute('aria-busy');
  app.removeAttribute('inert');
  app.hidden = false;
  document.getElementById('startup-fallback')!.hidden = true;
  window.dispatchEvent(new Event('voidplayer:startup-ready'));
}
// Theme styles are render-blocking HTML links, so the shell never flashes
// unstyled; main.ts signals shell-ready once its first frame is rendered, and
// heavier warmup (GPU, library) finishes after reveal without blocking it.
let disposeLanguage = () => {};
try {
  if (!globalThis.isSecureContext || location.pathname === '/connection') {
    disposeLanguage = await initializeLanguage();
    const { showConnectionGuide } = await import('./connection-guide.ts');
    const ready = showConnectionGuide({ automatic: location.pathname !== '/connection' });
    revealApp(); // The guide is usable while its connection probe is still pending.
    await ready;
  } else {
    // Reveal on main.ts's first rendered frame; module evaluation (GPU warmup,
    // annotation deep-link restore) still completes before this branch
    // resolves, so load failures keep surfacing here.
    let shellReady!: () => void;
    const shell = new Promise<void>(resolve => { shellReady = resolve; });
    window.addEventListener('voidplayer:shell-ready', () => shellReady(), { once: true });
    disposeLanguage = await initializeLanguage();
    const loaded = import('./main.ts');
    await Promise.race([shell, loaded]);
    revealApp();
    await loaded;
  }
} catch (error) {
  console.error('播放器初始化失败。', error);
  const app = document.getElementById('app')!;
  const fallback = document.getElementById('startup-fallback')!;
  app.hidden = true;
  fallback.hidden = false;
  window.dispatchEvent(new Event('voidplayer:startup-failed'));
  try {
    fallback.querySelector('p')!.textContent = t(msg("bootstrap.startupFailed", "页面未能加载，请刷新重试。"));
    fallback.querySelector('a')!.textContent = t(msg("bootstrap.reload", "重新加载"));
  } catch { /* Keep the built-in Chinese fallback. */ }
}

window.addEventListener('pagehide', () => disposeLanguage(), {once:true});
