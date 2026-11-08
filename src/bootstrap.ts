import { initializeLanguage, t, msg } from './i18n.ts';
import { localOnly } from './services/build-profile.ts';
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
// explicit library/deep-link loading can finish after reveal without blocking it.
let disposeLanguage = () => {};
try {
  if (!localOnly && (!globalThis.isSecureContext || location.pathname === '/connection')) {
    disposeLanguage = await initializeLanguage();
    const { showConnectionGuide } = await import('./ui/connection-guide.ts');
    const ready = showConnectionGuide({ automatic: location.pathname !== '/connection' });
    revealApp(); // The guide is usable while its connection probe is still pending.
    await ready;
  } else {
    // Reveal on main.ts's first ready frame after GPU admission. Explicit
    // annotation deep-link restoration remains async; module failures still
    // surface here.
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
    fallback.querySelector('#startup-title')!.textContent = t(msg('bootstrap.startupTitle', '启动未完成'));
    fallback.querySelector('.startup-brand span')!.textContent = t(msg('bootstrap.brandDescription', '· 视频对比'));
    fallback.querySelector('#startup-description')!.textContent = t(msg("bootstrap.startupFailed", "页面未能加载"));
  } catch { /* Keep the built-in Chinese fallback. */ }
}

window.addEventListener('pagehide', () => disposeLanguage(), {once:true});
