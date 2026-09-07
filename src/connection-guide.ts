import './connection-guide.css';

type Connection = { configured: boolean; httpsUrl: string | null; certificateUrl: string | null; fingerprint: string | null };
export async function showConnectionGuide() {
  document.title = '连接准备 · VoidPlayer';
  document.body.classList.add('connection-page');
  document.getElementById('app')!.innerHTML = `
    <main class="connection-guide">
      <header><span class="connection-brand">VOIDPLAYER</span><span class="connection-label">连接准备</span></header>
      <section class="connection-intro"><span class="connection-eyebrow">一次设置，随后直接进入评审</span>
        <h1>为视频评审开启安全连接</h1>
        <p>当前连接无法使用 WebCodecs，视频会依赖较慢的软件解码。安装此服务器的证书并使用 HTTPS，即可让浏览器使用原生解码能力。</p>
      </section>
      <p id="connection-status" role="status">正在检查服务器的 HTTPS 配置…</p>
      <section id="connection-setup" hidden>
        <div class="connection-step"><span class="connection-number">1</span><div><h2>下载服务器证书</h2>
          <p>先向管理员核对服务器地址与下方 SHA-256 指纹，再安装证书。</p>
          <a id="connection-download" class="connection-button secondary" href="/api/connection/certificate" download="voidplayer-ca.crt">下载 voidplayer-ca.crt</a>
          <details class="connection-fingerprint"><summary>查看证书指纹</summary><code id="connection-fingerprint"></code></details>
        </div></div>
        <div class="connection-step"><span class="connection-number">2</span><div><h2>在这台电脑上信任证书</h2>
          <div class="connection-os" aria-label="操作系统"><button type="button" data-os="windows" aria-pressed="true">Windows</button><button type="button" data-os="macos" aria-pressed="false">macOS</button></div>
          <ol id="connection-windows"><li>双击下载的 <strong>voidplayer-ca.crt</strong>，点击“安装证书”。</li><li>选择“当前用户”，点击“下一步”。</li><li>选择“将所有的证书都放入下列存储”，点击“浏览”，选择<strong>受信任的根证书颁发机构</strong>。</li><li>完成导入；确认来源与指纹后，在系统提示中允许安装。</li></ol>
          <ol id="connection-macos" hidden><li>打开“钥匙串访问”，选择<strong>登录</strong>钥匙串，通过“文件 → 导入项目”导入下载的 <strong>voidplayer-ca.crt</strong>。</li><li>在“证书”中找到刚导入的 <strong>VoidPlayer Local CA</strong> 证书，双击打开。</li><li>展开“信任”，将<strong>安全套接字层（SSL）</strong>设置为“始终信任”。</li><li>关闭证书窗口，按系统提示验证身份并保存。</li></ol>
          <p class="connection-note">浏览器不能替你完成系统证书安装。如果设备由组织管理，请联系管理员部署证书。</p>
        </div></div>
      </section>
      <section id="connection-enter" class="connection-step" hidden><span id="connection-enter-number" class="connection-number">3</span><div><h2>重新打开浏览器，进入播放器</h2><p>保存安装设置后，完全退出并重新打开浏览器，再访问下面的 HTTPS 地址。</p><a id="connection-open" class="connection-button" href="/">进入 HTTPS 播放器 <span aria-hidden="true">↗</span></a><p id="connection-address" class="connection-address"></p></div></section>
      <section id="connection-unavailable" class="connection-help" hidden><h2>需要管理员先开启 HTTPS</h2><p>此服务尚未提供可用的安全入口。请让管理员在服务器上启用内置 HTTPS，并把证书引导地址发给你。</p><p>独立程序启动示例：</p><code>./voidplayer --https 服务器IP</code><p>默认 HTTPS 端口为 5180，证书引导页端口为 5181。已启用 HTTPS 时，请打开管理员提供的 HTTP 引导地址下载证书。</p></section>
      <button id="connection-retry" type="button" class="connection-retry">重新检查连接配置</button>
      <footer>HTTPS 为 WebCodecs 提供运行条件；实际硬件加速仍取决于浏览器、显卡及视频格式。</footer>
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
    try {
      const response = await fetch('/api/connection/certificate', { cache: 'no-store', signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error('证书下载失败，请重新检查连接后再试。');
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a'); link.href = url; link.download = 'voidplayer-ca.crt'; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) { $('status').textContent = (error as Error).message; }
    finally { downloading = false; $('download').removeAttribute('aria-busy'); }
  };
  async function refresh() {
    const retry = $('retry') as HTMLButtonElement; retry.disabled = true;
    $('status').textContent = '正在检查服务器的 HTTPS 配置…';
    $('setup').hidden = $('enter').hidden = $('unavailable').hidden = true;
    try {
      const response = await fetch('/api/connection', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error('暂时无法读取连接配置，请确认服务已启动后重试。');
      const info = await response.json() as Connection;
      if (!info.configured) {
        $('status').textContent = '服务器尚未开启 HTTPS。'; $('unavailable').hidden = false; return;
      }
      const target = info.httpsUrl ? new URL(info.httpsUrl) : null;
      if (!target || target.protocol !== 'https:') {
        $('status').textContent = '服务器已配置证书，请向管理员获取与证书匹配的 HTTPS 地址。'; return;
      }
      const install = info.certificateUrl === '/api/connection/certificate';
      $('setup').hidden = !install; $('enter').hidden = false;
      $('enter-number').textContent = install ? '3' : '1';
      $('fingerprint').textContent = info.fingerprint ?? '';
      ($('open') as HTMLAnchorElement).href = target.href;
      $('address').textContent = target.origin;
      $('status').textContent = install ? '服务器已准备好证书，按下面三步完成连接。' : '服务器使用自有证书。请直接进入 HTTPS；若仍有证书提示，请联系管理员提供证书链。';
    } catch (error) { $('status').textContent = (error as Error).message; }
    finally { retry.disabled = false; }
  }
  $('retry').onclick = () => void refresh();
  await refresh();
}
