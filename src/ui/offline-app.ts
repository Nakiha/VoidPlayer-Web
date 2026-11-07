import { msg, onLanguageChange, t } from '../i18n.ts';

export async function installOfflineControls() {
  const manifest = document.createElement('link');
  manifest.rel = 'manifest';
  manifest.href = '/manifest.webmanifest';
  document.head.append(manifest);

  const panel = document.getElementById('offline-app')!;
  const label = document.getElementById('offline-app-status')!;
  const button = document.getElementById('offline-app-prepare') as HTMLButtonElement;
  const lifetime = new AbortController();
  const options = { signal: lifetime.signal };
  window.addEventListener('pagehide', event => { if (!event.persisted) lifetime.abort(); }, options);
  let state: 'idle' | 'preparing' | 'ready' | 'failed' | 'unsupported' = 'idle';
  function render() {
    const labels = {
      idle: msg('pwa.idle', '下载播放器和解码器后，可离线打开本地视频。'),
      preparing: msg('pwa.preparing', '正在下载播放器资源…'),
      ready: msg('pwa.ready', '已就绪，可离线打开本地视频'),
      failed: msg('pwa.failed', '离线资源准备失败，请联网后重试。'),
      unsupported: msg('pwa.unsupported', '当前浏览器无法保存离线资源。'),
    };
    label.dataset.state = state;
    label.textContent = t(labels[state]);
    button.hidden = state !== 'idle' && state !== 'failed';
  }
  function observe(registration: ServiceWorkerRegistration) {
    const track = () => {
      const worker = registration.installing ?? registration.waiting ?? registration.active;
      const sync = () => {
        state = registration.active?.state === 'activated' ? 'ready'
          : !worker || worker.state === 'redundant' ? 'failed' : 'preparing';
        render();
      };
      worker?.addEventListener('statechange', sync, options);
      sync();
    };
    registration.addEventListener('updatefound', track, options);
    track();
  }
  async function prepare() {
    if (state === 'preparing' || state === 'ready') return;
    state = 'preparing';
    render();
    try {
      observe(await navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }));
    } catch {
      state = 'failed';
      render();
    }
  }
  onLanguageChange(render, lifetime.signal);
  // A normal online visit does not fetch optional decoders until the user asks for offline use.
  try {
    const registration = await navigator.serviceWorker.getRegistration('/');
    const worker = registration?.active ?? registration?.waiting ?? registration?.installing;
    if (registration && worker && new URL(worker.scriptURL).pathname === '/sw.js') observe(registration);
    button.addEventListener('click', prepare, options);
    window.addEventListener('appinstalled', prepare, options);
    if (matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone) void prepare();
  } catch {
    state = 'unsupported';
  }
  panel.hidden = false;
  render();
}
