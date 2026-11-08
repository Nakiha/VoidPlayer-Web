import { msg, onLanguageChange, t } from '../i18n.ts';
import type { ToastStack } from './toast.ts';

interface InstallPrompt extends Event {
  prompt(): Promise<unknown>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

function safariPlatform() {
  const { userAgent, platform, maxTouchPoints } = navigator;
  if (!/Version\/[\d.]+.*Safari\//.test(userAgent) || /Chrome|Chromium|CriOS|FxiOS|Edg|OPiOS/.test(userAgent)) return;
  if (/iPhone|iPad|iPod/.test(userAgent) || (platform === 'MacIntel' && maxTouchPoints > 1)) return 'ios';
  if (/Mac/.test(platform)) return 'mac';
}
function installHelp(platform: ReturnType<typeof safariPlatform>) {
  if (platform === 'ios') return t(msg('pwa.iosInstall', '轻点分享按钮，选择「添加到主屏幕」。'));
  if (platform === 'mac') return t(msg('pwa.safariInstall', '在 Safari 的「文件」菜单中选择「添加到程序坞」，然后点「添加」。'));
  return t(msg('pwa.browserInstall', '请在浏览器菜单中选择安装应用。如果没有此选项，请用桌面 Chrome 或 Edge 打开本页。'));
}

export async function installOfflineControls(toasts: ToastStack, identityReady: Promise<void>) {
  const safari = safariPlatform();
  const row = document.getElementById('web-app')!;
  const hint = document.getElementById('web-app-hint')!;
  const button = document.getElementById('web-app-install') as HTMLButtonElement;
  const lifetime = new AbortController();
  const options = { signal: lifetime.signal };
  window.addEventListener('pagehide', event => { if (!event.persisted) lifetime.abort(); }, options);
  const standalone = matchMedia('(display-mode: standalone)');
  const inApp = () => standalone.matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  let installed = inApp(), prompting = false, showHelp = false;
  let deferred: InstallPrompt | undefined;
  let state: 'idle' | 'preparing' | 'ready' | 'failed' | 'unsupported' = 'idle';

  function render() {
    row.dataset.offline = state;
    button.textContent = installed ? t(msg('pwa.installed', '已安装')) : t(msg('pwa.install', '安装'));
    button.disabled = installed || prompting;
    if (!installed && (safari || showHelp)) {
      hint.textContent = installHelp(safari);
      if (showHelp && safari === 'mac') hint.textContent += ' ' + t(msg('pwa.safariFinder', '应用会保存在个人「应用程序」文件夹。如需在 Finder 的「打开方式」中选择 VoidPlayer，请通过桌面 Chrome 或 Edge 安装。'));
    } else {
      hint.textContent = installed && state === 'failed' ? t(msg('pwa.failed', '离线资源准备失败，请联网后重试。'))
        : installed && state === 'unsupported' ? t(msg('pwa.unsupported', '当前浏览器无法保存离线资源。')) : '';
    }
    hint.hidden = !hint.textContent;
    button.title = installed && state === 'ready' ? t(msg('pwa.ready', '已就绪，可离线打开本地视频'))
      : installed && state === 'preparing' ? t(msg('pwa.preparing', '正在下载播放器资源…')) : '';
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
  function didInstall() {
    installed = true;
    showHelp = false;
    deferred = undefined;
    render();
    void prepare();
  }
  window.addEventListener('appinstalled', didInstall, options);
  standalone.addEventListener('change', () => { if (inApp()) didInstall(); }, options);
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    deferred = event as InstallPrompt;
    installed = inApp();
    showHelp = false;
    render();
  }, options);
  button.addEventListener('click', async () => {
    if (!deferred) { showHelp = true; render(); return; }
    const prompt = deferred;
    deferred = undefined; // Each event can prompt once, in the original user gesture.
    prompting = true;
    showHelp = false;
    render();
    try {
      await prompt.prompt();
      await prompt.userChoice;
    } catch { showHelp = true; }
    finally { prompting = false; render(); }
  }, options);
  onLanguageChange(render, lifetime.signal);
  const manifest = document.createElement('link');
  manifest.rel = 'manifest';
  manifest.href = '/manifest.webmanifest';
  document.head.append(manifest);
  row.hidden = false;
  render();
  if (safari && !installed) void identityReady.then(() => {
    const showVisitHint = () => {
      if (document.hidden || installed || lifetime.signal.aborted) return;
      document.removeEventListener('visibilitychange', showVisitHint);
      try {
        const key = 'voidplayer.safari-install-hint.v1';
        if (localStorage.getItem(key)) return;
        localStorage.setItem(key, '1');
      } catch { return; } // Keep the About hint available when preferences cannot be stored.
      toasts.show(() => safari === 'mac'
        ? t(msg('pwa.safariVisit', 'Safari 可通过「文件 → 添加到程序坞」安装 VoidPlayer。要让 Finder 用它打开视频，请用 Chrome 或 Edge 安装。'))
        : installHelp(safari), { durationMs: 8000 });
    };
    document.addEventListener('visibilitychange', showVisitHint, options);
    showVisitHint();
  });
  try {
    const registration = await navigator.serviceWorker.getRegistration('/');
    const worker = registration?.active ?? registration?.waiting ?? registration?.installing;
    if (registration && worker && new URL(worker.scriptURL).pathname === '/sw.js') observe(registration);
    if (installed) void prepare();
  } catch { state = 'unsupported'; render(); }
}
