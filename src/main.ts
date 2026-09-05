import { benchmarkPlayback } from './benchmark.ts';
import './style.css';
import { openMedia } from './media.ts';
import { ReviewSession } from './session.ts';
import { formatTime } from './model.ts';
import type { Region, Slot } from './model.ts';
import { registerReviewTools, reviewTools } from './agent.ts';
import { bindFileDrop } from './file-drop.ts';
import { exportLog, getLogSessions, log, operationContext, readLogs, traceOperation, withLogContext } from './log.ts';
import { startBrowserLogging } from './log-storage.ts';
import { installLogPanel } from './log-panel.ts';
import { installLibraryPanel } from './library-panel.ts';
import { openLibraryItem } from './library.ts';

const stopLogging = startBrowserLogging();

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const icon = (name: 'sidebar' | 'open' | 'export' | 'play' | 'pause' | 'previous' | 'next') => {
  const paths = {
    sidebar: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
    open: '<path d="M3 7a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
    export: '<path d="M12 15V3m-4 4 4-4 4 4M7 11H4v10h16V11h-3"/>',
    play: '<path d="m8 5 11 7-11 7Z" fill="currentColor" stroke="none"/>',
    pause: '<path d="M7 5h3v14H7zm7 0h3v14h-3Z" fill="currentColor" stroke="none"/>',
    previous: '<path d="M6 5v14m12-14L8 12l10 7Z"/>',
    next: '<path d="M18 5v14M6 5l10 7-10 7Z"/>',
  };
  return `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
};
$('app').innerHTML = `
<header class="topbar"><button id="toggle-marks" aria-label="显示或隐藏标注面板" aria-expanded="false" title="标注面板">${icon('sidebar')}</button><span class="mode">并排</span><span class="toolbar-spacer"></span><button id="open" aria-label="打开视频">${icon('open')}<span>打开</span></button><button id="library-open" title="服务器媒体库"><span>媒体库</span></button><button id="export" disabled>${icon('export')}<span>导出评审</span></button><button id="export-log" title="导出会话日志（问题反馈用）">${icon('export')}<span>日志</span></button><button id="help-open" aria-label="实验范围与快捷键" title="实验范围与快捷键">?</button></header>
<main>
  <div id="notice" role="alert" hidden></div>
  <div class="workspace panel-hidden">
    <section class="comparison" aria-label="视频对比">
      <div class="screens">${(['A', 'B'] as Slot[]).map(slot => `
        <article class="video-card"><div class="card-heading"><span class="slot slot-${slot}">${slot}</span><span id="name-${slot}" class="filename">${slot === 'A' ? '参考视频' : '对比视频'}</span><output id="pts-${slot}" class="frame-time" aria-label="视频 ${slot} 当前帧时间">—</output><label class="file-button" for="file-${slot}">打开文件<input id="file-${slot}" type="file" accept="video/*,.mkv,.mov,.mp4,.webm,.ts,.avi" aria-label="打开视频 ${slot}"></label></div>
        <div class="frame-stage" id="stage-${slot}"><div class="empty" id="empty-${slot}"><label class="empty-open" for="file-${slot}">${icon('open')}<span>打开视频</span></label></div><div id="image-${slot}" class="image-wrap" hidden><canvas id="canvas-${slot}" aria-label="视频 ${slot} 当前解码画面"></canvas><svg id="region-${slot}" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true"><rect x="0" y="0" width="0" height="0"/></svg></div></div>
        <div class="card-footer"><span id="meta-${slot}">尚未载入</span></div></article>`).join('')}
      </div>
      <section class="transport" aria-label="共用播放控制"><div class="transport-row"><div class="play-buttons"><button id="previous" title="上一帧，左方向键" aria-label="上一帧" disabled>${icon('previous')}</button><button id="play" class="play" aria-label="播放" disabled>${icon('play')}</button><button id="next" title="下一帧，右方向键" aria-label="下一帧" disabled>${icon('next')}</button></div><output id="position">00:00.000</output><span class="duration">/ <span id="duration">00:00.000</span></span><span class="transport-status" id="status" role="status">等待视频</span></div><input id="timeline" type="range" min="0" max="1" step="1" value="0" aria-label="共用时间轴，微秒" disabled><div class="transport-bottom"><span>← → 逐帧 · 空格播放</span><form id="seek-form"><label for="seek-seconds">定位到</label><input id="seek-seconds" type="number" min="0" step="0.001" value="0" aria-label="定位时间，秒"><span>秒</span><button id="seek" disabled>前往</button></form></div></section>
      <div class="evidence"><span id="alignment">静音 · SDR · 本地文件</span><span id="decode">—</span></div>

    </section>
    <aside class="review-panel" aria-label="评审标注"><div class="panel-heading"><h2>标注</h2><span id="mark-count">0</span></div><form id="mark-form"><div class="field-row"><label>标注轨道<select id="mark-slot"><option>A · 参考视频</option><option>B · 对比视频</option></select></label><label>严重度<select id="severity"><option value="1">1 · 轻微</option><option value="2">2</option><option value="3" selected>3 · 明显</option><option value="4">4</option><option value="5">5 · 严重</option></select></label></div><label for="note">备注</label><textarea id="note" rows="3" maxlength="2000" placeholder="记录当前帧的问题…" required></textarea><div class="region-hint"><span id="region-hint">在画面上拖动框选</span><button type="button" id="clear-region" hidden>清除</button></div><button id="add-mark" class="primary full" disabled>＋ 添加标注</button></form><div id="marks" class="marks"><div class="marks-empty">暂无标注</div></div></aside>
  </div>
</main><dialog id="help"><h2>浏览器实验版</h2><p>本地文件，不上传。首版仅支持静音、SDR 对比，HDR 与专业色彩一致性尚未验证。</p><p>← / →：双轨协调逐帧。空格：播放 / 暂停。暂停后可拖动框选。</p><p>标注仅保留在本次会话，关闭前请导出。导出格式与桌面版暂不互通。播放可能跳帧；时间戳表示已解码并绘制到画布，不表示屏幕已完成刷新。</p><button id="benchmark">检查当前视频播放性能</button><button id="help-close">关闭</button></dialog>`;
const canvases = { A: $<HTMLCanvasElement>('canvas-A'), B: $<HTMLCanvasElement>('canvas-B') };
const session = new ReviewSession((slot, frame) => frame.draw(canvases[slot]));
const removeLogPanel = installLogPanel($('export-log'));
installLibraryPanel($('library-open'), (entry, slot) =>
  void act(() => session.load(slot, () => openLibraryItem(entry)), 'ui.library-load', { id: entry.id, name: entry.name, slot }));
let inputTrigger = 'pointer';
let draft: { slot: Slot; region: Region } | null = null;
let lastFrames = '';
let lastMarks = '';
let message = '';
const clearRegion = () => {
  draft = null;
  for (const slot of ['A', 'B']) $(`region-${slot}`).firstElementChild!.setAttribute('width', '0');
  $('clear-region').hidden = true;
  $('region-hint').textContent = '在画面上拖动框选';
};
function showError(error: unknown) {
  message = error instanceof Error ? error.message : String(error);
  render();
}
async function act(action: () => unknown | Promise<unknown>, name = 'ui.action', data: unknown = {}) {
  message = '';
  try { await traceOperation('ui', name, { trigger: inputTrigger, data }, action); } catch (e) { showError(e); }
  render();
}
function downloadReview() {
  const blob = new Blob([JSON.stringify(session.exportReview(), null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = `voidplayer-review-${new Date().toISOString().slice(0, 10)}.json`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function fitFrame(slot: Slot, width: number, height: number) {
  const stage = $(`stage-${slot}`);
  const fittedWidth = Math.max(1, Math.min(stage.clientWidth, stage.clientHeight * width / height));
  const image = $(`image-${slot}`);
  image.style.width = `${fittedWidth}px`;
  image.style.height = `${fittedWidth * height / width}px`;
}
const resizeObserver = new ResizeObserver(() => {
  for (const t of session.getState().tracks) fitFrame(t.slot, t.width, t.height);
});
for (const slot of ['A', 'B']) resizeObserver.observe($(`stage-${slot}`));
function render() {
  const state = session.getState();
  const loaded = state.tracks.length > 0;
  const cards = document.querySelectorAll<HTMLElement>('.video-card');
  document.querySelector('.screens')!.classList.toggle('single', state.tracks.length < 2);
  cards[0].hidden = state.tracks.length === 1 && state.tracks[0].slot === 'B';
  cards[1].hidden = state.tracks.length < 2 && !cards[0].hidden;
  document.querySelector<HTMLElement>('.transport')!.hidden = !loaded;
  document.querySelector<HTMLElement>('.evidence')!.hidden = !loaded;
  for (const card of cards) card.querySelector<HTMLElement>('.card-heading')!.hidden = !loaded;
  const frames = JSON.stringify(state.tracks.map(t => [t.id, t.frame?.ptsUs]));
  if (frames !== lastFrames) { clearRegion(); lastFrames = frames; }
  for (const slot of ['A', 'B'] as Slot[]) {
    const t = state.tracks.find(t => t.slot === slot);
    $(`empty-${slot}`).hidden = !!t;
    $(`image-${slot}`).hidden = !t;
    $(`name-${slot}`).textContent = t?.name ?? (slot === 'A' ? '参考视频' : '对比视频');
    $(`meta-${slot}`).textContent = t ? `${t.width} × ${t.height} · ${t.codec}${t.decoder === 'ffmpeg-wasm' ? ' · WASM' : ''}` : '尚未载入';
    $(`pts-${slot}`).textContent = t?.frame ? formatTime(t.frame.ptsUs) : '—';
    if (t) fitFrame(slot, t.width, t.height);
    $(`pts-${slot}`).title = t?.frame ? `源时间戳 ${t.frame.sourcePtsUs} µs · 帧时长 ${t.frame.durationUs} µs` : '';
  }
  $<HTMLButtonElement>('play').disabled = !loaded || state.busy;
  $<HTMLButtonElement>('previous').disabled = !state.tracks.some(t => t.slot === 'A') || state.busy;
  $<HTMLButtonElement>('next').disabled = $<HTMLButtonElement>('previous').disabled;
  $<HTMLButtonElement>('seek').disabled = !loaded || state.busy;
  $<HTMLButtonElement>('add-mark').disabled = !loaded || state.busy || state.playing;
  $<HTMLButtonElement>('export').disabled = !loaded && !state.marks.length;
  $('play').innerHTML = icon(state.playing ? 'pause' : 'play');
  $('play').setAttribute('aria-label', state.playing ? '暂停' : '播放');
  const timeline = $<HTMLInputElement>('timeline');
  timeline.disabled = !loaded || state.busy;
  timeline.max = String(Math.max(1, state.durationUs - 1));
  if (document.activeElement !== timeline) timeline.value = String(state.positionUs);
  $('position').textContent = formatTime(state.positionUs);
  $('duration').textContent = formatTime(state.durationUs);
  $('status').textContent = state.busy ? '正在解码…' : state.playing ? '播放中 · 静音' : loaded ? '已暂停' : '等待视频';
  $('decode').textContent = state.playback && state.playback.wallMs > 500 ? `实际速度 ${state.playback.speed.toFixed(2)}×` : loaded ? `最近定位 ${state.lastDecodeMs} ms` : '—';
  $('notice').hidden = !(message || state.error);
  $('notice').textContent = message || state.error;
  const times = state.tracks.map(t => t.frame?.ptsUs);
  $('alignment').textContent = times.length === 2 && times.every(t => t != null)
    ? `A / B 帧起点差 ${Math.abs(times[0]! - times[1]!) / 1000} ms`
    : '静音 · SDR · 本地文件';
  $('mark-count').textContent = String(state.marks.length);
  const signature = state.marks.map(m => m.id).join(',') + '/' + state.tracks.map(t => t.id).join(',');
  if (signature !== lastMarks) {
    lastMarks = signature;
    $('marks').replaceChildren();
    for (const mark of [...state.marks].reverse()) {
      const item = document.createElement('article'); item.className = 'mark';
      const heading = document.createElement('div'); heading.className = 'mark-heading';
      const anchor = document.createElement('button'); anchor.textContent = `${mark.slot} · ${formatTime(mark.frame.ptsUs)}`;
      anchor.title = '返回这一帧';
      anchor.disabled = !state.tracks.some(t => t.id === mark.mediaId);
      anchor.onclick = () => void act(() => session.seek(mark.frame.ptsUs), 'mark.seek', { id: mark.id, ptsUs: mark.frame.ptsUs });
      const severity = document.createElement('span'); severity.textContent = `严重度 ${mark.severity}`;
      heading.append(anchor, severity);
      const note = document.createElement('p'); note.textContent = mark.text;
      const remove = document.createElement('button'); remove.className = 'remove'; remove.textContent = '删除'; remove.setAttribute('aria-label', `删除标注 ${mark.text}`);
      remove.onclick = () => void act(() => session.deleteMark(mark.id), 'mark.delete', { id: mark.id });
      item.append(heading, note, remove); $('marks').append(item);
    }
    if (!state.marks.length) $('marks').innerHTML = '<div class="marks-empty">暂无标注</div>';
  }
}
let importRevision = 0;
async function importFiles(files: File[], slots: Slot[]) {
  const context = operationContext();
  const revision = ++importRevision;
  for (let i = 0; i < files.length; i++) {
    if (revision !== importRevision) throw new DOMException('文件导入已被新的请求取代。', 'AbortError');
    await withLogContext(context, () => session.load(slots[i], () => openMedia(files[i])));
  }
}
const unbindDrop = bindFileDrop(document.body, {
  target: event => {
    const stage = event.target instanceof Element ? event.target.closest('.video-card')?.querySelector('.frame-stage') : null;
    return stage?.id === 'stage-A' ? 'A' : stage?.id === 'stage-B' ? 'B' : undefined;
  },
  loaded: () => session.getState().tracks.map(track => track.slot),
  hover: slots => {
    for (const slot of ['A', 'B'] as Slot[]) $(`stage-${slot}`).classList.toggle('drop-target', slots.includes(slot));
  },
  load: (files, slots) => act(() => importFiles(files, slots), 'files.drop', { files, slots }),
  error: error => { log.warn('ui', '拖入文件失败', { error }); showError(error); },
});
for (const slot of ['A', 'B'] as Slot[]) {
  $<HTMLInputElement>(`file-${slot}`).onchange = event => {
    const input = event.target as HTMLInputElement; const file = input.files?.[0]; input.value = '';
    if (file) void act(() => importFiles([file], [slot]), 'files.select', { file, slot });
  };
  $<HTMLInputElement>(`file-${slot}`).oncancel = () => log.info('ui', '取消文件选择', { slot });
  const image = $(`image-${slot}`);
  let start: { x: number; y: number; pointer: number } | null = null;
  const point = (e: PointerEvent) => { const r = image.getBoundingClientRect(); return { x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)) }; };
  image.onpointerdown = e => {
    if (e.button !== 0 || session.getState().busy) return;
    log.info('ui', '开始框选', { slot });
    session.pause(); clearRegion(); start = { ...point(e), pointer: e.pointerId }; image.setPointerCapture(e.pointerId);
    $<HTMLSelectElement>('mark-slot').selectedIndex = slot === 'A' ? 0 : 1;
  };
  image.onpointermove = e => {
    if (!start || start.pointer !== e.pointerId) return;
    const end = point(e);
    const region = { left: Math.min(start.x, end.x), top: Math.min(start.y, end.y), width: Math.abs(start.x - end.x), height: Math.abs(start.y - end.y) };
    draft = { slot, region };
    const rect = $(`region-${slot}`).firstElementChild!;
    for (const [key, value] of Object.entries({ x: region.left, y: region.top, width: region.width, height: region.height })) rect.setAttribute(key, String(value));
  };
  image.onpointerup = e => {
    if (!start || start.pointer !== e.pointerId) return;
    start = null; image.releasePointerCapture(e.pointerId);
    log.info('ui', '结束框选', { slot, region: draft?.region ?? null });
    if (!draft || draft.region.width < 0.005 || draft.region.height < 0.005) clearRegion();
    else { $('region-hint').textContent = `已框选视频 ${slot} 的区域`; $('clear-region').hidden = false; }
  };
  image.onpointercancel = () => { log.info('ui', '取消框选', { slot }); start = null; clearRegion(); };
}
$('toggle-marks').onclick = () => {
  const hidden = document.querySelector('.workspace')!.classList.toggle('panel-hidden');
  $('toggle-marks').setAttribute('aria-expanded', String(!hidden));
};
$('open').onclick = () => {
  const state = session.getState();
  $<HTMLInputElement>(state.tracks.some(t => t.slot === 'A') ? 'file-B' : 'file-A').click();
};
$('help-open').onclick = () => $<HTMLDialogElement>('help').showModal();
$('help-close').onclick = () => $<HTMLDialogElement>('help').close();
$('play').onclick = () => void act(() => session.getState().playing ? session.pause() : session.play(), 'play.toggle');
$('previous').onclick = () => void act(() => session.step(-1), 'step.previous');
$('next').onclick = () => void act(() => session.step(1), 'step.next');
$<HTMLInputElement>('timeline').onchange = e => void act(() => session.seek(Number((e.target as HTMLInputElement).value)), 'seek.timeline', { ptsUs: Number((e.target as HTMLInputElement).value) });
$('seek-form').onsubmit = e => { e.preventDefault(); void act(() => session.seek(Math.round(Number($<HTMLInputElement>('seek-seconds').value) * 1e6)), 'seek.time', { seconds: $<HTMLInputElement>('seek-seconds').value }); };
$('mark-form').onsubmit = e => {
  e.preventDefault();
  void act(() => {
    const slot = $<HTMLSelectElement>('mark-slot').selectedIndex === 0 ? 'A' : 'B';
    session.addMark({ slot, text: $<HTMLTextAreaElement>('note').value, severity: Number($<HTMLSelectElement>('severity').value), region: draft?.slot === slot ? draft.region : null });
    $<HTMLTextAreaElement>('note').value = ''; clearRegion();
  }, 'mark.add', { slot: $<HTMLSelectElement>('mark-slot').selectedIndex, noteLength: $<HTMLTextAreaElement>('note').value.length, region: draft?.region });
};
$('clear-region').onclick = clearRegion;
$<HTMLSelectElement>('mark-slot').onchange = clearRegion;
$('export').onclick = () => void act(downloadReview, 'review.download');
document.addEventListener('keydown', e => {
  if (e.target instanceof HTMLElement && (e.target.matches('input,textarea,select,button') || e.target.isContentEditable)) return;
  if (!session.getState().tracks.length || e.ctrlKey || e.metaKey || e.altKey) return;
  inputTrigger = 'keyboard';
  try {
    if (e.code === 'Space') { e.preventDefault(); if (!e.repeat) $('play').click(); }
    else if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') { e.preventDefault(); $(e.code === 'ArrowLeft' ? 'previous' : 'next').click(); }
  } finally { inputTrigger = 'pointer'; }
});
// Semantic inputs only: no per-keystroke text capture or pointer-move traffic.
const uiEvents = new AbortController();
for (const eventName of ['click', 'change', 'invalid'] as const) document.addEventListener(eventName, event => {
  if (!(event.target instanceof Element)) return;
  const control = event.target.closest<HTMLElement>('button, input, select, textarea, summary, label');
  if (!control) return;
  let value: unknown;
  if (eventName === 'change') {
    if (control instanceof HTMLTextAreaElement) value = { length: control.value.length };
    else if (control instanceof HTMLInputElement && control.type === 'file') value = { count: control.files?.length ?? 0 };
    else if (control instanceof HTMLInputElement || control instanceof HTMLSelectElement) value = control.value;
  }
  log.info('ui', '界面操作', { event: eventName, control: control.id || control.dataset.action || control.tagName.toLowerCase(), trigger: inputTrigger, value });
}, { capture: true, signal: uiEvents.signal });
session.subscribe(() => { message = ''; render(); });
const unregister = registerReviewTools(session);
const apiCall = <T>(name: string, data: unknown, action: () => T) => traceOperation('api', name, data, action);
const api = {
  getState: () => session.getState(),
  loadFile: (slot: Slot, file: File) => apiCall('loadFile', { slot, file }, () => session.load(slot, () => openMedia(file))),
  seek: (ptsUs: number) => apiCall('seek', { ptsUs }, () => session.seek(ptsUs)), step: (direction: number) => apiCall('step', { direction }, () => session.step(direction)),
  play: () => apiCall('play', {}, () => session.play()), pause: () => apiCall('pause', {}, () => session.pause()),
  addMark: (input: Parameters<ReviewSession['addMark']>[0]) => apiCall('addMark', input, () => session.addMark(input)),
  deleteMark: (id: string) => apiCall('deleteMark', { id }, () => session.deleteMark(id)), exportReview: () => session.exportReview(),
  getLogs: readLogs, listLogSessions: getLogSessions, exportLog,
  tools: reviewTools(session),
};
Object.defineProperty(window, 'voidPlayer', { value: Object.freeze(api), configurable: true });
window.addEventListener('beforeunload', e => { if (session.getState().marks.length) { e.preventDefault(); e.returnValue = ''; } });
import.meta.hot?.dispose(() => { unregister(); unbindDrop(); removeLogPanel(); uiEvents.abort(); resizeObserver.disconnect(); void session.dispose().finally(stopLogging); });
render();

$('benchmark').addEventListener('click', () => {
  $<HTMLDialogElement>('help').close();
  void act(async () => {
    const report = await benchmarkPlayback(session);
    let dialog = document.getElementById('benchmark-result') as HTMLDialogElement | null;
    if (!dialog) {
      dialog = document.createElement('dialog'); dialog.id = 'benchmark-result';
      const title = document.createElement('h2'); title.textContent = '播放性能检查'; dialog.append(title);
      const result = document.createElement('p'); result.id = 'benchmark-summary'; dialog.append(result);
      const json = document.createElement('textarea'); json.id = 'benchmark-json'; json.readOnly = true;
      json.setAttribute('aria-label', '播放性能报告 JSON'); json.style.cssText = 'width:100%;height:240px'; dialog.append(json);
      const close = document.createElement('button'); close.textContent = '关闭'; close.onclick = () => dialog!.close(); dialog.append(close);
      document.body.append(dialog);
    }
    const reasons: Record<string, string> = { 'below-realtime': '播放速度不足', 'frame-lag': '画面落后',
      'track-skew': '双轨不同步', 'insufficient-sample': '样本时长不足', 'page-not-visible': '测试期间页面不可见',
      'pause-latency': '暂停响应慢', 'stale-frame-after-pause': '暂停后画面改变', 'premature-end': '画面未播完',
      'playback-error': '播放出错', 'interrupted': '测试被中断', 'media-changed': '测试期间视频被替换', 'no-frames': '没有输出画面' };
    $('benchmark-summary').textContent = report.passed ? '通过' : `未通过：${report.failures.map(f => reasons[f] ?? (f.endsWith('presentation-stall') ? `${f[0]} 轨画面卡顿` : f)).join('、')}`;
    $<HTMLTextAreaElement>('benchmark-json').value = JSON.stringify(report, null, 2);
    dialog.showModal();
  }, 'ui.benchmark');
});
