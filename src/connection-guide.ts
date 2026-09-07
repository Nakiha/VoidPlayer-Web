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
  document.title = '连接准备 · VoidPlayer';
  document.body.classList.add('connection-page');
  document.getElementById('app')!.innerHTML = `
    <main class="connection-guide">
      <header class="connection-header"><span class="connection-brand">VoidPlayer</span><span class="connection-label">${icon(lock)} 连接设置</span></header>
      <section class="connection-intro" aria-labelledby="connection-title">
        <span class="connection-emblem">${icon(lock)}</span>
        <h1 id="connection-title">连接你的评审空间。</h1>
        <p>为这台设备设置信任，开启安全连接。<br>只需一次，随后直接进入视频评审。</p>
      </section>
      <div class="connection-status-row">
        <p id="connection-status" role="status">正在检查服务器的 HTTPS 配置…</p>
        <button id="connection-retry" type="button" class="connection-retry" aria-label="重新检查连接配置">${icon(refreshIcon)}<span>重新检查</span></button>
      </div>
      <div class="connection-card">
        <section id="connection-setup" class="connection-setup" hidden>
          <section class="connection-download-step" aria-labelledby="connection-download-title">
            <div class="connection-step-heading"><span class="connection-number">1</span><h2 id="connection-download-title">下载服务器证书</h2></div>
            <p>这份证书用于识别你正在连接的<br class="connection-desktop-break"> VoidPlayer 服务器。</p>
            <div class="connection-certificate">
              <span class="connection-certificate-icon">${icon(certificate)}</span>
              <div><strong>voidplayer-ca.crt</strong><span>服务器信任证书</span></div>
            </div>
            <a id="connection-download" class="connection-button secondary" href="/api/connection/certificate" download="voidplayer-ca.crt">${icon(download)}<span id="connection-download-label">下载证书</span></a>
            <p class="connection-note">安装前，请与管理员核对服务器地址和证书指纹。</p>
            <details class="connection-fingerprint"><summary>查看证书指纹</summary><span>SHA-256</span><code id="connection-fingerprint"></code></details>
          </section>
          <section class="connection-trust-step" aria-labelledby="connection-trust-title">
            <div class="connection-step-heading"><span class="connection-number">2</span><h2 id="connection-trust-title">在这台设备上信任</h2></div>
            <div class="connection-os" role="group" aria-label="操作系统"><button type="button" data-os="windows" aria-pressed="true" aria-controls="connection-windows">${icon(windows)}Windows</button><button type="button" data-os="macos" aria-pressed="false" aria-controls="connection-macos">${icon(apple)}macOS</button></div>
            <ol id="connection-windows"><li>双击下载的证书，选择<strong>安装证书</strong>。</li><li>选择<strong>当前用户</strong>，点击“下一步”。</li><li>选择“将所有的证书都放入下列存储”，浏览并选中<strong>受信任的根证书颁发机构</strong>。</li><li>核对来源与指纹，按系统提示完成导入。</li></ol>
            <ol id="connection-macos" hidden><li>打开<strong>钥匙串访问</strong>，选中“登录”，通过“文件 → 导入项目”导入下载的证书。</li><li>找到 <strong>VoidPlayer Local CA</strong> 证书，双击打开。</li><li>展开“信任”，将<strong>安全套接字层（SSL）</strong>设为“始终信任”。</li><li>关闭窗口，按系统提示验证身份并保存。</li></ol>
            <details class="connection-install-help"><summary>无法安装或找不到证书？</summary><p>浏览器不能代替你安装系统证书。请确认已下载 voidplayer-ca.crt；如果设备由组织管理，请联系管理员部署。</p></details>
          </section>
        </section>
        <section id="connection-enter" class="connection-enter" hidden>
          <div><div class="connection-step-heading"><span id="connection-enter-number" class="connection-number">3</span><h2>完成设置，开始评审</h2></div><p id="connection-enter-hint">保存后，完全退出并重新打开浏览器，再进入播放器。</p><p id="connection-address" class="connection-address"></p></div>
          <a id="connection-open" class="connection-button" href="/">进入播放器 ${icon(arrow)}</a>
        </section>
        <section id="connection-unavailable" class="connection-help" hidden><span class="connection-emblem">${icon(lock)}</span><h2>等待服务器开启安全连接</h2><p>请联系管理员开启 HTTPS，再回到这里继续设置。</p><details><summary>查看服务器设置说明</summary><p>独立程序启动示例：</p><code>./voidplayer --https 服务器IP</code><p>默认 HTTPS 端口为 5180，证书引导页端口为 5181。已启用时，请使用管理员提供的引导地址。</p></details></section>
      </div>
      <footer><span>${icon(lock)} 证书由你的 VoidPlayer 服务器提供</span><details><summary>为什么需要这一步？</summary><p>受信任的 HTTPS 让浏览器可以使用 WebCodecs 原生解码。实际硬件加速仍取决于浏览器、显卡和视频格式。</p></details></footer>
    </main>`;
  const $ = (id: string) => document.getElementById(`connection-${id}`)!;
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
      $('status').dataset.state = 'ready';
      $('status').textContent = '证书下载已开始 · 保存后继续设置信任';
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) { $('status').textContent = (error as Error).message; $('status').dataset.state = 'error'; $('download-label').textContent = '重试下载'; }
    finally { downloading = false; $('download').removeAttribute('aria-busy'); }
  };
  async function refresh() {
    const retry = $('retry') as HTMLButtonElement; retry.disabled = true;
    $('status').textContent = '正在检查服务器的 HTTPS 配置…';
    $('status').dataset.state = 'loading';
    $('setup').hidden = $('enter').hidden = $('unavailable').hidden = true;
    try {
      const response = await fetch('/api/connection', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error('暂时无法读取连接配置，请确认服务已启动后重试。');
      const info = await response.json() as Connection;
      if (!info.configured) {
        $('status').dataset.state = 'waiting'; $('status').textContent = '服务器尚未开启 HTTPS。'; $('unavailable').hidden = false; return;
      }
      const target = info.httpsUrl ? new URL(info.httpsUrl) : null;
      if (!target || target.protocol !== 'https:') {
        $('status').dataset.state = 'waiting'; $('status').textContent = '服务器已配置证书，请向管理员获取与证书匹配的 HTTPS 地址。'; return;
      }
      const install = info.certificateUrl === '/api/connection/certificate';
      $('setup').hidden = !install; $('enter').hidden = false;
      $('enter-number').textContent = install ? '3' : '1';
      $('fingerprint').textContent = info.fingerprint ?? '';
      ($('open') as HTMLAnchorElement).href = target.href;
      $('address').textContent = target.origin;
      $('enter-hint').textContent = install ? '保存后，完全退出并重新打开浏览器，再进入播放器。' : '此服务器使用自有证书。若浏览器仍提示证书问题，请联系管理员。';
      $('status').dataset.state = 'ready';
      $('status').textContent = install ? '服务器证书已就绪 · 按以下三步完成设置' : '服务器已配置 HTTPS · 可直接进入播放器';
    } catch (error) { $('status').textContent = (error as Error).message; $('status').dataset.state = 'error'; }
    finally { retry.disabled = false; }
  }
  $('retry').onclick = () => void refresh();
  await refresh();
}
