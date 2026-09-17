export {};
function revealApp() {
  const app = document.getElementById('app')!;
  app.removeAttribute('data-initializing');
  app.removeAttribute('aria-busy');
  app.removeAttribute('inert');
}
// Theme styles are render-blocking HTML links, so the shell never flashes
// unstyled; main.ts signals shell-ready once its first frame is rendered, and
// heavier warmup (GPU, library) finishes after reveal without blocking it.
try {
  if (!globalThis.isSecureContext || location.pathname === '/connection') {
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
    const loaded = import('./main.ts');
    await Promise.race([shell, loaded]);
    revealApp();
    await loaded;
  }
} catch (error) {
  console.error('播放器初始化失败。', error);
  const app = document.getElementById('app')!;
  app.innerHTML = '<div class="startup-error" role="alert"><p>页面未能加载，请刷新重试。</p><a href="">重新加载</a></div>';
} finally { revealApp(); }
