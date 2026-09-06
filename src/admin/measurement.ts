import { icon } from '../ui/icons.ts';
import type { MeasurementResult, MeasurementKind } from '../../server/measurement.ts';
import type { LibraryEntry, LibraryPage } from '../library.ts';
const kinds: Record<MeasurementKind, string> = { download: '下载吞吐', upload: '上传吞吐', storage: '存储读取', concurrent: '四路媒体读取' };
const descriptions: Record<MeasurementKind, string> = {
  download: '服务器 → 当前浏览器。单路传输内存数据，排除媒体存储读取；使用当前的网关、TLS 与网络连接。',
  upload: '当前浏览器 → 服务器。单路上传随机数据，收到后即丢弃，不保存到磁盘。',
  storage: '服务器直接重复读取所选媒体，每块最多 1 MiB，包含打开文件与版本校验。结果包含操作系统缓存，不能等同于磁盘物理带宽。',
  concurrent: '当前浏览器同时发起四路媒体读取，每块最多 1 MiB，合计统计吞吐。覆盖文件读取、HTTP 与网络，包含缓存与浏览器连接调度的影响。',
};
const active = (r: MeasurementResult | null) => !!r && ['preparing', 'running', 'stopping'].includes(r.state);
const MiB = 1024 ** 2;
export function measurementShell() {
  return `<section id="pane-measurements" hidden><header class="admin-heading"><div><h1>测速</h1><p>测量当前部署与这台浏览器之间的实际能力。</p></div></header>
    <div class="admin-measure-options"><label>测试类型<select id="measure-kind">${Object.entries(kinds).map(([key, label]) => `<option value="${key}">${label}</option>`).join('')}</select></label><label>最长时长<select id="measure-seconds"><option value="5">5 秒</option><option value="10" selected>10 秒</option><option value="15">15 秒</option></select></label><label>数据量上限<select id="measure-limit"><option value="64">64 MiB</option><option value="256" selected>256 MiB</option><option value="1024">1 GiB</option></select></label></div>
    <p id="measure-description" class="admin-caption"></p>
    <div id="measure-media-picker" hidden><div class="admin-measure-search"><label>筛选媒体<input id="measure-search" type="search" placeholder="搜索媒体库" maxlength="200"></label><button id="measure-search-button">${icon('search')}搜索</button></div><label class="admin-measure-file">读取的媒体<select id="measure-media" aria-label="读取的媒体"></select></label><div class="admin-actions"><span id="measure-media-page" class="admin-caption"></span><button id="measure-media-prev">上一页</button><button id="measure-media-next">下一页</button></div></div>
    <div class="admin-actions"><span id="measure-condition" class="admin-caption">达到时长或数据量上限即结束；一次只运行一个任务。</span><button id="measure-cancel" disabled>${icon('close')}取消测试</button><button id="measure-start">${icon('play')}开始测试</button></div>
    <p class="admin-caption">仅在点击后运行，会占用相应的网络或存储资源。结果只保留在本次服务进程中。</p>
    <h2>本次结果</h2><p id="measure-state" role="status" aria-live="polite">尚未运行测试</p>
    <div class="admin-metrics admin-measure-metrics"><div><span>吞吐</span><strong id="measure-rate">—</strong></div><div><span>每秒读取 / 传输</span><strong id="measure-speed">—</strong></div><div><span>已完成数据</span><strong id="measure-bytes">—</strong></div><div><span>实际耗时</span><strong id="measure-elapsed">—</strong></div></div>
    <dl class="admin-properties admin-measure-result"><div><dt>测试条件</dt><dd id="measure-result-condition">—</dd></div><div><dt>测量来源</dt><dd id="measure-origin">—</dd></div><div><dt>请求 / 读取块</dt><dd id="measure-count">—</dd></div><div><dt>媒体与版本</dt><dd id="measure-source">—</dd></div><div><dt>结束原因</dt><dd id="measure-reason">—</dd></div></dl>
  </section>`;
}
export function installMeasurements(life: AbortSignal, notice: (message: string, error?: boolean) => void, identity: () => string | undefined) {
  const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
  const text = (id: string, value: string) => { $(id).textContent = value; };
  const select = (id: string) => $<HTMLSelectElement>(id);
  let result: MeasurementResult | null = null, ownId: string | null = null, running = false, visible = false, pollBusy = false;
  let client: { bytes: number; requests: number; elapsedMs: number } | undefined, transfer: AbortController | null = null;
  let offset = 0, nextOffset: number | null = null, query = '', mediaSequence = 0;
  let media = new Map<string, LibraryEntry>();
  let mediaRevision: number | null = null, mediaPending = false, mediaAt = 0;
  const kind = () => select('measure-kind').value as MeasurementKind;
  async function api<T>(url: string, method = 'GET', body?: unknown): Promise<T> {
    const response = await fetch(url, { method, cache: 'no-store', headers: method === 'GET' ? {} : { 'x-voidplayer-action': 'admin', 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.any([life, AbortSignal.timeout(15000)]) });
    const value = await response.json(); if (!response.ok) throw Object.assign(new Error(value.error ?? `请求失败 (${response.status})`), { status: response.status }); return value;
  }
  const safe = async (fn: () => Promise<void>) => { try { await fn(); } catch (error) { if (!life.aborted) notice((error as Error).message, true); } };
  function controls() {
    const busy = running || active(result);
    for (const id of ['measure-kind', 'measure-seconds', 'measure-limit', 'measure-search', 'measure-search-button', 'measure-media']) $(id).toggleAttribute('disabled', busy);
    $('measure-start').toggleAttribute('disabled', busy || (['storage', 'concurrent'].includes(kind()) && !media.has(select('measure-media').value)));
    $('measure-cancel').toggleAttribute('disabled', !active(result) || result?.state === 'stopping' || result?.owner !== identity());
    $('measure-media-prev').toggleAttribute('disabled', busy || offset === 0); $('measure-media-next').toggleAttribute('disabled', busy || nextOffset === null);
  }
  function render() {
    controls(); if (!result) return;
    const labels = { preparing: '准备中', running: '进行中', stopping: '正在结束，等待当前读取释放', completed: '已完成', cancelled: '已取消', failed: '测试失败' };
    text('measure-state', `${kinds[result.kind]} · ${labels[result.state]}${result.error ? ` · ${result.error}` : ''}`);
    const sample = result.id === ownId && client ? client : result.client ?? result;
    const elapsed = Math.max(0, sample.elapsedMs), rate = elapsed ? sample.bytes * 1000 / elapsed : 0;
    text('measure-rate', `${(rate * 8 / 1e6).toFixed(1)} Mbps`); text('measure-speed', `${(rate / MiB).toFixed(1)} MiB/s`);
    text('measure-bytes', `${(sample.bytes / MiB).toFixed(1)} MiB`); text('measure-elapsed', `${(elapsed / 1000).toFixed(2)} 秒`);
    text('measure-result-condition', `${result.concurrency} 路 · 最长 ${result.seconds} 秒 · 上限 ${result.limitBytes / MiB} MiB · ${new Date(result.startedAt).toLocaleString()}`);
    text('measure-origin', result.kind === 'storage' ? '服务端文件读取（含系统缓存）' : (result.id === ownId && client) || result.client ? '发起浏览器计时（含请求往返）' : '服务端计数；浏览器结果尚未提交');
    text('measure-count', `${sample.requests} 次完成 · ${result.errors} 次错误 · ${result.activeRequests} 次处理中`);
    text('measure-source', result.media ? `${result.media.root} / ${result.media.name} · ${result.media.version}` : '随机内存数据，不写入磁盘');
    const reasons = { duration: '达到时长上限', limit: '达到数据量上限', user: '发起者取消或连接中断', client: '浏览器完成测量', error: '发生错误', shutdown: '服务关闭' };
    text('measure-reason', result.reason ? reasons[result.reason] : '—');
  }
  async function poll() {
    if (pollBusy || (!visible && !running) || life.aborted) return; pollBusy = true;
    try { result = (await api<{ job: MeasurementResult | null }>('/api/admin/measurements')).job; render();
      if (visible && !running && !active(result) && mediaPending && ['storage', 'concurrent'].includes(kind()) && performance.now() - mediaAt > 1500) await loadMedia(); }
    catch (error) { if (!life.aborted) notice((error as Error).message, true); }
    finally { pollBusy = false; }
  }
  async function loadMedia() {
    const sequence = ++mediaSequence; mediaAt = performance.now();
    let page: LibraryPage;
    try { page = await api<LibraryPage>(`/api/library/browse?recursive=1&limit=60&offset=${offset}&search=${encodeURIComponent(query)}${offset && mediaRevision !== null ? `&revision=${mediaRevision}` : ''}`); }
    catch (error) { if ((error as { status?: number }).status === 409 && sequence === mediaSequence) { offset = 0; mediaRevision = null; return loadMedia(); } throw error; }
    if (sequence !== mediaSequence) return;
    mediaRevision = page.revision; mediaPending = page.scanning || page.entries.some(e => e.state === 'pending');
    const previous = select('measure-media').value;
    media = new Map(page.entries.filter(e => e.state === 'ready' && e.size > 0 && e.version).map(e => [e.id, e])); nextOffset = page.nextOffset;
    const options = [...media.values()].map(e => { const option = document.createElement('option'); option.value = e.id; option.textContent = `${e.root} / ${e.name} · ${(e.size / MiB).toFixed(1)} MiB`; return option; });
    if (!options.length) { const option = document.createElement('option'); option.value = ''; option.textContent = mediaPending ? '等待媒体写入稳定或扫描完成…' : '本页没有可读媒体'; options.push(option); }
    select('measure-media').replaceChildren(...options);
    if (media.has(previous)) select('measure-media').value = previous;
    text('measure-media-page', `共 ${page.total} 项 · 第 ${Math.floor(offset / 60) + 1} 页，仅显示可读的非空文件`); controls();
  }
  function configure() {
    text('measure-description', descriptions[kind()]); const needsMedia = ['storage', 'concurrent'].includes(kind());
    $('measure-media-picker').hidden = !needsMedia; controls();
    if (needsMedia && !media.size) void safe(loadMedia);
  }
  async function runTransfers(job: MeasurementResult) {
    transfer = new AbortController(); const signal = AbortSignal.any([life, transfer.signal]);
    // Reuse an incompressible 1 MiB payload; generating it is outside the timer.
    const payload = new Uint8Array(MiB);
    if (job.kind === 'upload') for (let n = 0; n < payload.length; n += 65536) crypto.getRandomValues(payload.subarray(n, n + 65536));
    const at = performance.now(); client = { bytes: 0, requests: 0, elapsedMs: 0 };
    const tick = setInterval(() => { client!.elapsedMs = performance.now() - at; render(); }, 250);
    const deadline = setTimeout(() => transfer?.abort(), (job.seconds + 2) * 1000);
    let error: Error | null = null;
    const lane = async () => {
      while (!signal.aborted && performance.now() - at < job.seconds * 1000) {
        try {
          const response = await fetch(`/api/admin/measurements/${job.id}/transfer`, { method: 'POST', headers: { 'x-voidplayer-action': 'admin', ...(job.kind === 'upload' ? { 'content-type': 'application/octet-stream' } : {}) }, body: job.kind === 'upload' ? payload : undefined, cache: 'no-store', signal });
          if (response.status === 410) { await response.body?.cancel(); return; }
          if (!response.ok) { const value = await response.json(); throw new Error(value.error ?? `请求失败 (${response.status})`); }
          if (job.kind === 'upload') client!.bytes += (await response.json()).bytes;
          else {
            const reader = response.body!.getReader();
            try { for (;;) { const { done, value } = await reader.read(); if (done) break; client!.bytes += value.length; } }
            finally { reader.releaseLock(); }
          }
          client!.requests++;
        } catch (caught) { if (!signal.aborted) error = caught as Error; return; }
      }
    };
    try { await Promise.all(Array.from({ length: job.concurrency }, lane)); }
    finally { clearTimeout(deadline); clearInterval(tick); client.elapsedMs = Math.max(1, performance.now() - at); transfer = null; }
    // Let in-flight response callbacks release their server slots before saving
    // browser timing. This also makes the result available in another admin tab.
    for (let i = 0; i < 10 && !life.aborted; i++) {
      try { result = (await api<{ job: MeasurementResult }>(`/api/admin/measurements/${job.id}/finish`, 'POST', client)).job; break; }
      catch (caught) { if ((caught as { status?: number }).status !== 409 || i === 9) throw caught; await new Promise(r => setTimeout(r, 100)); }
    }
    render();
    if (error && !['duration', 'limit', 'user'].includes(result?.reason ?? '')) throw error;
  }
  $('measure-start').onclick = () => void safe(async () => {
    if (running || active(result)) return; running = true; client = undefined; notice(''); controls();
    try {
      const selected = media.get(select('measure-media').value);
      result = (await api<{ job: MeasurementResult }>('/api/admin/measurements', 'POST', { kind: kind(), seconds: Number(select('measure-seconds').value), limitMiB: Number(select('measure-limit').value), ...(['storage', 'concurrent'].includes(kind()) ? { mediaId: selected?.id, version: selected?.version } : {}) })).job;
      ownId = result.id; render();
      while (result.state === 'preparing' && !life.aborted) { await new Promise(r => setTimeout(r, 100)); await poll(); }
      if (result.state === 'running' && result.kind !== 'storage') await runTransfers(result);
    } finally { running = false; render(); }
  });
  $('measure-cancel').onclick = () => void safe(async () => { if (!result || result.owner !== identity()) return; result = (await api<{ job: MeasurementResult }>(`/api/admin/measurements/${result.id}`, 'DELETE')).job; transfer?.abort(); render(); });
  $('measure-kind').onchange = configure;
  const search = () => { query = $<HTMLInputElement>('measure-search').value.trim(); offset = 0; void safe(loadMedia); };
  $('measure-search-button').onclick = search; $('measure-search').onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); search(); } };
  $('measure-media-prev').onclick = () => { offset = Math.max(0, offset - 60); void safe(loadMedia); };
  $('measure-media-next').onclick = () => { if (nextOffset !== null) { offset = nextOffset; void safe(loadMedia); } };
  const timer = setInterval(() => void poll(), 750);
  life.addEventListener('abort', () => { clearInterval(timer); transfer?.abort(); if (active(result) && result?.id === ownId) void fetch(`/api/admin/measurements/${ownId}`, { method: 'DELETE', headers: { 'x-voidplayer-action': 'admin' }, keepalive: true }).catch(() => {}); }, { once: true });
  configure();
  return { activate(value: boolean) { visible = value; if (value) void poll(); } };
}
