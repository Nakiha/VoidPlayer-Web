export {};
function revealApp() {
  const app = document.getElementById('app')!;
  app.removeAttribute('data-initializing');
  app.removeAttribute('aria-busy');
  app.removeAttribute('inert');
}
// Theme styles are render-blocking HTML links; modules never expose an unfinished shell.
try {
  if (!globalThis.isSecureContext || location.pathname === '/connection') {
    const { showConnectionGuide } = await import('./connection-guide.ts');
    const ready = showConnectionGuide({ automatic: location.pathname !== '/connection' });
    revealApp(); // The guide is usable while its connection probe is still pending.
    await ready;
  } else {
    await import('./main.ts');
  }
} catch (error) {
  console.error('播放器初始化失败。', error);
  const app = document.getElementById('app')!;
  app.innerHTML = '<div class="startup-error" role="alert"><p>页面未能加载，请刷新重试。</p><a href="">重新加载</a></div>';
} finally { revealApp(); }
