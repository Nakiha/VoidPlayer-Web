import './connection-guide.css';
import { observeTheme } from './ui/theme.ts';
import lock from '@phosphor-icons/core/assets/regular/lock-simple.svg?raw';
import certificate from '@phosphor-icons/core/assets/regular/certificate.svg?raw';
import download from '@phosphor-icons/core/assets/regular/download-simple.svg?raw';
import arrow from '@phosphor-icons/core/assets/regular/arrow-up-right.svg?raw';
import refreshIcon from '@phosphor-icons/core/assets/regular/arrow-clockwise.svg?raw';
import apple from '@phosphor-icons/core/assets/regular/apple-logo.svg?raw';
import windows from '@phosphor-icons/core/assets/regular/windows-logo.svg?raw';
const icon = (svg: string) => svg.replace('<svg ', '<svg class="connection-icon" aria-hidden="true" focusable="false" ');

type Connection = { configured: boolean; httpsUrl: string | null; certificateUrl: string | null; fingerprint: string | null };
export async function showConnectionGuide() {
  observeTheme();
  document.title = '证书设置 · VoidPlayer';
  document.body.classList.add('connection-page');
  document.getElementById('app')!.innerHTML = `
    <main class="connection-guide">
      <header class="connection-header">
        <h1 id="connection-title"><span class="connection-brand">VoidPlayer</span><span class="connection-title-divider">-</span>证书设置</h1>
        <details id="connection-about" class="connection-about"><summary>为什么需要证书？</summary><p>信任服务器证书后，浏览器可以建立可信的 HTTPS 连接，使用 WebCodecs 原生解码。实际硬件加速取决于浏览器、显卡和视频格式。</p></details>
      </header>
      <div id="connection-status-row" class="connection-status-row">
        <p id="connection-status" role="status">正在检查连接配置…</p>
        <button id="connection-retry" type="button" class="connection-retry" aria-label="重新检查连接配置">${icon(refreshIcon)}<span>重新检查</span></button>
      </div>
      <div class="connection-card">
        <section id="connection-setup" class="connection-setup" hidden>
          <section class="connection-download-step" aria-labelledby="connection-download-title">
            <div class="connection-step-heading"><span class="connection-number">1</span><h2 id="connection-download-title">下载证书</h2></div>
            <div class="connection-certificate">
              <span class="connection-certificate-icon">${icon(certificate)}</span>
              <div><strong>voidplayer-ca.crt</strong><span>服务器信任证书</span></div>
            </div>
            <a id="connection-download" class="connection-button secondary" href="/api/connection/certificate" download="voidplayer-ca.crt">${icon(download)}<span id="connection-download-label">下载证书</span></a>
            <p class="connection-note">安装前，请与管理员核对服务器地址和证书指纹。</p>
            <details class="connection-fingerprint"><summary>查看证书指纹</summary><span>SHA-256</span><code id="connection-fingerprint"></code></details>
          </section>
          <section class="connection-trust-step" aria-labelledby="connection-trust-title">
            <div class="connection-step-heading"><span class="connection-number">2</span><h2 id="connection-trust-title">安装并信任</h2></div>
            <div class="connection-os" role="group" aria-label="操作系统"><button type="button" data-os="windows" aria-pressed="true" aria-controls="connection-windows">${icon(windows)}Windows</button><button type="button" data-os="macos" aria-pressed="false" aria-controls="connection-macos">${icon(apple)}macOS</button></div>
            <ol id="connection-windows"><li>双击下载的证书，选择<strong>安装证书</strong>。</li><li>选择<strong>当前用户</strong>，点击“下一步”。</li><li>选择“将所有的证书都放入下列存储”，浏览并选中<strong>受信任的根证书颁发机构</strong>。</li><li>核对来源与指纹，按系统提示完成导入。</li></ol>
            <ol id="connection-macos" hidden><li>打开<strong>钥匙串访问</strong>，选中“登录”，通过“文件 → 导入项目”导入下载的证书。</li><li>找到 <strong>VoidPlayer Local CA</strong> 证书，双击打开。</li><li>展开“信任”，将<strong>安全套接字层（SSL）</strong>设为“始终信任”。</li><li>关闭窗口，按系统提示验证身份并保存。</li></ol>
            <details class="connection-install-help"><summary>无法安装或找不到证书？</summary><p>浏览器不能代替你安装系统证书。请确认已下载 voidplayer-ca.crt；如果设备由组织管理，请联系管理员部署。</p></details>
          </section>
        </section>
        <section id="connection-enter" class="connection-enter" hidden>
          <div><div class="connection-step-heading"><span id="connection-enter-number" class="connection-number">3</span><h2>打开播放器</h2></div><p id="connection-enter-hint">保存信任设置后，退出并重新打开浏览器。</p><p id="connection-address" class="connection-address"></p></div>
          <a id="connection-open" class="connection-button" href="/">打开播放器 ${icon(arrow)}</a>
        </section>
        <section id="connection-unavailable" class="connection-help" hidden><span class="connection-emblem">${icon(lock)}</span><h2>服务器未开启 HTTPS</h2><p>请联系管理员开启 HTTPS。</p><details><summary>查看服务器设置说明</summary><p>独立程序启动示例：</p><code>./voidplayer --https 服务器IP</code><p>默认 HTTPS 端口为 5180，证书引导页端口为 5181。已启用时，请使用管理员提供的引导地址。</p></details></section>
      </div>
    </main>`;
  const $ = (id: string) => document.getElementById(`connection-${id}`)!;
  const setStatus = (state: 'loading' | 'ready' | 'waiting' | 'error', message = '') => {
    $('status').dataset.state = state;
    $('status').textContent = message;
    $('status-row').hidden = state === 'ready';
    $('retry').hidden = state === 'loading' || state === 'ready';
  };
  const about = $('about') as HTMLDetailsElement;
  document.querySelector('.connection-guide')!.addEventListener('pointerdown', event => {
    if (!about.contains(event.target as Node)) about.open = false;
  });
  about.addEventListener('keydown', event => {
    if (event.key === 'Escape') { about.open = false; about.querySelector('summary')!.focus(); }
  });
  const selectOS = (os: string) => {
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-os]')) button.setAttribute('aria-pressed', String(button.dataset.os === os));
    $('windows').hidden = os !== 'windows'; $('macos').hidden = os !== 'macos';
  };
  selectOS(/Macintosh|Mac OS X/.test(navigator.userAgent) ? 'macos' : 'windows');
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-os]')) button.onclick = () => selectOS(button.dataset.os!);
  let downloading = false;
  $('download').onclick = async event => {
    event.preventDefault(); if (downloading) return;
    downloading = true; $('download').setAttribute('aria-busy', 'true');
    $('download-label').textContent = '正在下载…';
    try {
      const response = await fetch('/api/connection/certificate', { cache: 'no-store', signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error('证书下载失败，请重新检查连接后再试。');
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a'); link.href = url; link.download = 'voidplayer-ca.crt'; link.click();
      $('download-label').textContent = '再次下载证书';
      setStatus('ready');
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) { setStatus('error', (error as Error).message); $('download-label').textContent = '重试下载'; }
    finally { downloading = false; $('download').removeAttribute('aria-busy'); }
  };
  async function refresh() {
    const retry = $('retry') as HTMLButtonElement; retry.disabled = true;
    setStatus('loading', '正在检查连接配置…');
    $('setup').hidden = $('enter').hidden = $('unavailable').hidden = true;
    try {
      const response = await fetch('/api/connection', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error('暂时无法读取连接配置，请确认服务已启动后重试。');
      const info = await response.json() as Connection;
      if (!info.configured) {
        setStatus('waiting', '服务器尚未开启 HTTPS。'); $('unavailable').hidden = false; return;
      }
      const target = info.httpsUrl ? new URL(info.httpsUrl) : null;
      if (!target || target.protocol !== 'https:') {
        setStatus('waiting', '服务器已配置证书，请向管理员获取与证书匹配的 HTTPS 地址。'); return;
      }
      const install = info.certificateUrl === '/api/connection/certificate';
      $('setup').hidden = !install; $('enter').hidden = false;
      $('enter-number').textContent = install ? '3' : '1';
      $('fingerprint').textContent = info.fingerprint ?? '';
      ($('open') as HTMLAnchorElement).href = target.href;
      $('address').textContent = target.origin;
      $('enter-hint').textContent = install ? '保存信任设置后，退出并重新打开浏览器。' : '此服务器使用自有证书。若浏览器仍提示证书问题，请联系管理员。';
      setStatus('ready');
    } catch (error) { setStatus('error', (error as Error).message); }
    finally { retry.disabled = false; }
  }
  $('retry').onclick = () => void refresh();
  await refresh();
}
