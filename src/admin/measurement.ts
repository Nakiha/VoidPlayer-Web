import { requestError } from './diagnostics.ts';
import { apiError } from '../api-error.ts';
import { localizedText, localizedAttribute, type LocalizedValue } from '../ui/live-localization.ts';
import { onLanguageChange, formatDate, formatNumber, t, th, msg } from '../i18n.ts';
import { installChoiceMenu } from '../ui/choice-menu.ts';
import { icon } from '../ui/icons.ts';
import type { MeasurementResult, MeasurementKind } from '../../server/measurement.ts';
import type { LibraryEntry, LibraryPage } from '../library.ts';
const kindLabels = (): Record<MeasurementKind, string> => ({ download: t(msg("admin.speedDownload", "下载速度")), upload: t(msg("admin.speedUpload", "上传速度")), storage: t(msg("admin.speedStorage", "服务器读取速度")), concurrent: t(msg("admin.speedConcurrent", "多路视频读取")) });
const descriptionLabels = (): Record<MeasurementKind, string> => ({
  download: t(msg("admin.descDownload", "服务器 → 浏览器，传输内存数据，不读取媒体文件。")),
  upload: t(msg("admin.descUpload", "当前浏览器 → 服务器。单路上传随机数据，收到后即丢弃，不保存到磁盘。")),
  storage: t(msg("admin.descStorage", "服务器重复读取所选媒体。包含系统缓存，不代表磁盘物理带宽。")),
  concurrent: t(msg("admin.descConcurrent", "浏览器同时读取四路媒体，统计合计吞吐。包含文件读取、网络、缓存和浏览器调度。")),
});
const stateLabels = () => ( { preparing: t(msg("admin.measurePreparing", "准备中")), running: t(msg("admin.measureRunning", "进行中")), stopping: t(msg("admin.measureFinishing", "正在结束，等待当前读取释放")), completed: t(msg("admin.measureDone", "已完成")), cancelled: t(msg("admin.measureCancelled", "已取消")), failed: t(msg("admin.measureFailed", "测试失败")) });
const reasonLabels = () => ( { duration: t(msg("admin.reasonDuration", "达到时长上限")), limit: t(msg("admin.reasonData", "达到数据量上限")), user: t(msg("admin.reasonUser", "用户取消或连接中断")), client: t(msg("admin.reasonBrowser", "浏览器完成测量")), error: t(msg("admin.reasonError", "发生错误")), shutdown: t(msg("admin.reasonClosed", "服务关闭")) });
const active = (r: MeasurementResult | null) => !!r && ['preparing', 'running', 'stopping'].includes(r.state);
const MiB = 1024 ** 2;
export function measurementShell() {
  return `<section id="pane-measurements" hidden><header class="admin-heading"><div><h1>${th(msg("admin.measureTitle", "测速"))}</h1><p>${th(msg("admin.measureDesc", "选择测试类型和上限，再点击“开始测试”。"))}</p></div></header>
    <div class="admin-panel"><div class="admin-section-heading"><h2>${th(msg("admin.testSettings", "测试设置"))}</h2></div><div class="admin-measure-options">${[['kind', t(msg("admin.optKind", "测试类型"))], ['seconds', t(msg("admin.optSeconds", "最长时长"))], ['limit', t(msg("admin.optLimit", "数据量上限"))]].map(([id, label]) => `<label>${label}<button type="button" class="admin-choice" id="measure-${id}" aria-label="${label}"></button></label>`).join('')}</div>
    <p id="measure-description" class="admin-caption"></p>
    <div id="measure-media-picker" hidden><div class="admin-measure-search"><label>${th(msg("admin.filterMedia", "筛选媒体"))}<input id="measure-search" type="search" placeholder="${th(msg("admin.searchLibrary", "搜索媒体库"))}" maxlength="200"></label><button id="measure-search-button">${icon('search')}${th(msg("admin.search", "搜索"))}</button></div><label class="admin-measure-file">${th(msg("admin.readMedia", "读取的媒体"))}<button type="button" class="admin-choice" id="measure-media" aria-label="${th(msg("admin.readMedia", "读取的媒体"))}"></button></label><div class="admin-actions"><span id="measure-media-page" class="admin-caption"></span><button id="measure-media-prev">${th(msg("admin.prevPage", "上一页"))}</button><button id="measure-media-next">${th(msg("admin.nextPage", "下一页"))}</button></div></div>
    <div class="admin-panel-footer"><span id="measure-condition" class="admin-caption">${th(msg("admin.capNote", "达到任一上限即结束。"))}</span><div class="admin-button-group"><button id="measure-cancel" hidden disabled>${icon('close')}${th(msg("admin.cancelTest", "取消测试"))}</button><button id="measure-start" class="admin-primary">${icon('play')}${th(msg("admin.startTest", "开始测试"))}</button></div></div>
    <p class="admin-help">${th(msg("admin.resourceNote", "测试期间会占用网络或存储资源。"))}</p></div>
    <div class="admin-panel"><div class="admin-section-heading"><h2>${th(msg("admin.resultsTitle", "测试结果"))}</h2><span id="measure-state" class="admin-caption" role="status" aria-live="polite">${th(msg("admin.notStarted", "尚未开始"))}</span></div><p id="measure-empty" class="admin-caption">${th(msg("admin.resultsHint", "完成测试后显示速度、传输量和耗时。"))}</p>
    <div id="measure-result" hidden><div class="admin-metrics admin-measure-metrics"><div><span>${th(msg("admin.netRate", "网络速率"))}</span><strong id="measure-rate">—</strong></div><div><span>${th(msg("admin.throughput", "传输速度"))}</span><strong id="measure-speed">—</strong></div><div><span>${th(msg("admin.dataDone", "已完成数据"))}</span><strong id="measure-bytes">—</strong></div><div><span>${th(msg("admin.elapsed", "实际耗时"))}</span><strong id="measure-elapsed">—</strong></div></div>
    <dl class="admin-properties admin-measure-result"><div><dt>${th(msg("admin.testConditions", "测试条件"))}</dt><dd id="measure-result-condition">—</dd></div><div><dt>${th(msg("admin.measureSource", "测量来源"))}</dt><dd id="measure-origin">—</dd></div><div><dt>${th(msg("admin.blocks", "请求 / 读取块"))}</dt><dd id="measure-count">—</dd></div><div><dt>${th(msg("admin.mediaVersion", "媒体与版本"))}</dt><dd id="measure-source">—</dd></div><div><dt>${th(msg("admin.endReason", "结束原因"))}</dt><dd id="measure-reason">—</dd></div></dl></div></div>
  </section>`;
}
export function installMeasurements(life: AbortSignal, notice: (message: LocalizedValue, error?: boolean) => void) {
  const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
  const text = (id: string, value: LocalizedValue) => { localizedText($(id), value); };
  let kinds = kindLabels(), descriptions = descriptionLabels(), labels = stateLabels(), reasons = reasonLabels();
  onLanguageChange(() => { kinds = kindLabels(); descriptions = descriptionLabels(); labels = stateLabels(); reasons = reasonLabels(); }, life);
  let chooseMediaLabel = t(msg('admin.chooseMedia', '选择媒体'));
  const values: Record<string, string> = { 'measure-kind': 'download', 'measure-seconds': '10', 'measure-limit': '256', 'measure-media': '' };
  const choices: Record<string, { value: string; label: string }[]> = {
    'measure-kind': Object.entries(kinds).map(([value, label]) => ({ value, label })),
    'measure-seconds': [5, 10, 15].map(value => ({ value: String(value), label: t(msg("activity.durationSeconds", "{s} 秒"), { s: value }) })),
    'measure-limit': [{ value: '64', label: '64 MiB' }, { value: '256', label: '256 MiB' }, { value: '1024', label: '1 GiB' }],
    'measure-media': [],
  };
  const menus = Object.fromEntries(Object.entries(choices).map(([id, options]) => {
    const menu = installChoiceMenu(id, () => id === 'measure-kind' ? Object.entries(kinds).map(([value,label]) => ({value,label})) : id === 'measure-seconds' ? [5,10,15].map(value => ({value:String(value),label:t(msg("activity.durationSeconds", "{s} 秒"),{s:value})})) : choices[id], value => { values[id] = value; if (id === 'measure-kind') configure(); else controls(); });
    $(`${id}-menu`).classList.add('admin-choice-menu'); return [id, menu];
  }));
  onLanguageChange(() => {
    chooseMediaLabel = t(msg('admin.chooseMedia', '选择媒体'));
    choices['measure-kind'] = Object.entries(kinds).map(([value,label]) => ({value,label}));
    choices['measure-seconds'] = [5,10,15].map(value => ({value:String(value),label:t(msg('activity.durationSeconds', '{s} 秒'),{s:value})}));
    if (!media.size && choices['measure-media'].length) {
      choices['measure-media'] = [{value:'',label:mediaPending ? t(msg('admin.waitStable', '等待媒体写入稳定或扫描完成…')) : t(msg('admin.noReadableMedia', '本页没有可读媒体'))}];
      menus['measure-media'].setOptions(choices['measure-media']);
    }
    for (const [id,menu] of Object.entries(menus)) menu.sync(values[id], choices[id].find(o => o.value === values[id])?.label ?? chooseMediaLabel, !running && !active(result) && visible);
  }, life);
  let result: MeasurementResult | null = null, ownId: string | null = null, running = false, visible = false, pollBusy = false;
  let client: { bytes: number; requests: number; elapsedMs: number } | undefined, transfer: AbortController | null = null;
  let offset = 0, nextOffset: number | null = null, query = '', mediaSequence = 0;
  let media = new Map<string, LibraryEntry>();
  let mediaRevision: number | null = null, mediaPending = false, mediaAt = 0;
  const kind = () => values['measure-kind'] as MeasurementKind;
  async function api<T>(url: string, method = 'GET', body?: unknown): Promise<T> {
    const response = await fetch(url, { method, cache: 'no-store', headers: method === 'GET' ? {} : { 'x-voidplayer-action': 'admin', 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.any([life, AbortSignal.timeout(15000)]) });
    const value = await response.json(); if (!response.ok) throw apiError(response.status, value); return value;
  }
  const safe = async (fn: () => Promise<void>) => { try { await fn(); } catch (error) { if (!life.aborted) notice(() => requestError(error), true); } };
  function controls() {
    const busy = running || active(result);
    for (const id of ['measure-kind', 'measure-seconds', 'measure-limit', 'measure-search', 'measure-search-button', 'measure-media']) $(id).toggleAttribute('disabled', busy);
    for (const [id, menu] of Object.entries(menus)) menu.sync(values[id], choices[id].find(o => o.value === values[id])?.label ?? chooseMediaLabel, !busy && visible);
    $('measure-start').toggleAttribute('disabled', busy || (['storage', 'concurrent'].includes(kind()) && !media.has(values['measure-media'])));
    $('measure-cancel').hidden = !active(result);
    $('measure-cancel').toggleAttribute('disabled', !active(result) || result?.state === 'stopping');
    $('measure-media-prev').toggleAttribute('disabled', busy || offset === 0); $('measure-media-next').toggleAttribute('disabled', busy || nextOffset === null);
  }
  function render() {
    controls(); $('measure-result').hidden = !result; $('measure-empty').hidden = !!result; if (!result) return; const current = result;
    text('measure-state', () => `${kinds[current.kind]} · ${labels[current.state]}${current.error ? ` · ${requestError({message:current.error})}` : ''}`);
    const sample = current.id === ownId && client ? client : current.client ?? result;
    const elapsed = Math.max(0, sample.elapsedMs), rate = elapsed ? sample.bytes * 1000 / elapsed : 0;
    text('measure-rate', () => `${(rate * 8 / 1e6).toFixed(1)} Mbps`); text('measure-speed', () => `${(rate / MiB).toFixed(1)} MiB/s`);
    text('measure-bytes', () => `${(sample.bytes / MiB).toFixed(1)} MiB`); text('measure-elapsed', () => t(msg("activity.durationSeconds", "{s} 秒"), { s: (elapsed / 1000).toFixed(2) }));
    text('measure-result-condition', () => t(msg("admin.resultConditions", "{concurrency} 路 · 最长 {seconds} 秒 · 上限 {limit} MiB · {date}"), {concurrency:current.concurrency,seconds:current.seconds,limit:current.limitBytes / MiB,date:formatDate(current.startedAt)}));
    text('measure-origin', () => current.kind === 'storage' ? t(msg("admin.originServerRead", "服务端文件读取（含系统缓存）")) : (current.id === ownId && client) || current.client ? t(msg("admin.originBrowserTiming", "发起浏览器计时（含请求往返）")) : t(msg("admin.originServerCount", "服务端计数；浏览器结果尚未提交")));
    text('measure-count', () => t(msg("admin.countLine", "{done} 次完成 · {errors} 次错误 · {pending} 次处理中"), { done: sample.requests, errors: current.errors, pending: current.activeRequests }));
    text('measure-source', () => current.media ? `${current.media.root} / ${current.media.name} · ${current.media.version}` : t(msg("admin.sourceRandom", "随机内存数据，不写入磁盘")));
    text('measure-reason', () => current.reason ? reasons[current.reason] : '—');
  }
  async function poll() {
    if (pollBusy || (!visible && !running) || life.aborted) return; pollBusy = true;
    try { result = (await api<{ job: MeasurementResult | null }>('/api/admin/measurements')).job; render();
      if (visible && !running && !active(result) && mediaPending && ['storage', 'concurrent'].includes(kind()) && performance.now() - mediaAt > 1500) await loadMedia(); }
    catch (error) { if (!life.aborted) notice(() => requestError(error), true); }
    finally { pollBusy = false; }
  }
  async function loadMedia() {
    const sequence = ++mediaSequence; mediaAt = performance.now();
    let page: LibraryPage;
    try { page = await api<LibraryPage>(`/api/library/browse?recursive=1&limit=60&offset=${offset}&search=${encodeURIComponent(query)}${offset && mediaRevision !== null ? `&revision=${mediaRevision}` : ''}`); }
    catch (error) { if ((error as { status?: number }).status === 409 && sequence === mediaSequence) { offset = 0; mediaRevision = null; return loadMedia(); } throw error; }
    if (sequence !== mediaSequence) return;
    mediaRevision = page.revision; mediaPending = page.scanning || page.entries.some(e => e.state === 'pending');
    const previous = values['measure-media'];
    media = new Map(page.entries.filter(e => e.state === 'ready' && e.size > 0 && e.version).map(e => [e.id, e])); nextOffset = page.nextOffset;
    choices['measure-media'] = [...media.values()].map(e => ({ value: e.id, label: `${e.root} / ${e.name} · ${(e.size / MiB).toFixed(1)} MiB` }));
    if (!media.size) choices['measure-media'].push({ value: '', label: mediaPending ? t(msg("admin.waitStable", "等待媒体写入稳定或扫描完成…")) : t(msg("admin.noReadableMedia", "本页没有可读媒体")) });
    values['measure-media'] = media.has(previous) ? previous : choices['measure-media'][0].value;
    menus['measure-media'].setOptions(choices['measure-media']);
    text('measure-media-page', () => t(msg("admin.pageCaption", "共 {total} 项 · 第 {n} 页，仅显示可读的非空文件"), { total: page.total, n: Math.floor(offset / 60) + 1 })); controls();
  }
  function configure() {
    text('measure-description', () => descriptions[kind()]); const needsMedia = ['storage', 'concurrent'].includes(kind());
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
          if (!response.ok) { const value = await response.json(); throw apiError(response.status, value); }
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
    if (running || active(result)) return; running = true; client = undefined; notice(() => ''); controls();
    try {
      const selected = media.get(values['measure-media']);
      result = (await api<{ job: MeasurementResult }>('/api/admin/measurements', 'POST', { kind: kind(), seconds: Number(values['measure-seconds']), limitMiB: Number(values['measure-limit']), ...(['storage', 'concurrent'].includes(kind()) ? { mediaId: selected?.id, version: selected?.version } : {}) })).job;
      ownId = result.id; render();
      while (result.state === 'preparing' && !life.aborted) { await new Promise(r => setTimeout(r, 100)); await poll(); }
      if (result.state === 'running' && result.kind !== 'storage') await runTransfers(result);
    } finally { running = false; render(); }
  });
  $('measure-cancel').onclick = () => void safe(async () => { if (!result) return; result = (await api<{ job: MeasurementResult }>(`/api/admin/measurements/${result.id}`, 'DELETE')).job; transfer?.abort(); render(); });
  const search = () => { query = $<HTMLInputElement>('measure-search').value.trim(); offset = 0; void safe(loadMedia); };
  $('measure-search-button').onclick = search; $('measure-search').onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); search(); } };
  $('measure-media-prev').onclick = () => { offset = Math.max(0, offset - 60); void safe(loadMedia); };
  $('measure-media-next').onclick = () => { if (nextOffset !== null) { offset = nextOffset; void safe(loadMedia); } };
  const timer = setInterval(() => void poll(), 750);
  life.addEventListener('abort', () => { clearInterval(timer); Object.values(menus).forEach(menu => menu.dispose()); transfer?.abort(); if (active(result) && result?.id === ownId) void fetch(`/api/admin/measurements/${ownId}`, { method: 'DELETE', headers: { 'x-voidplayer-action': 'admin' }, keepalive: true }).catch(() => {}); }, { once: true });
  configure();
  return { activate(value: boolean) { visible = value; controls(); if (value) void poll(); } };
}
