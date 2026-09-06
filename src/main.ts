import { parseTimeInput, installTimeInput } from './time-input.ts';
import { installMenu } from './ui/menu.ts';
import { createFrameTask } from './ui/frame-task.ts';
import { installChoiceMenu } from './ui/choice-menu.ts';
import { installHeaderActions } from './ui/header-actions.ts';
import { SLOTS } from './model.ts';
import { installTooltips } from './ui/tooltips.ts';
import { installDrawingEditor } from './ui/drawing-editor.ts';
import { benchmarkPlayback } from './benchmark.ts';
import './themes/silver-glass.css';
import './style.css';
import { shell } from './ui/shell.ts';
import { icon } from './ui/icons.ts';
import { installWorkbench } from './ui/workbench.ts';
import { needsViewRecovery } from './ui/view-recovery.ts';
import { installSourceActions } from './ui/source-actions.ts';
import { bindTimelinePreview } from './ui/seek-preview.ts';
import { installTrackDrag } from './ui/track-drag.ts';
import { installViewportChrome } from './ui/viewport-chrome.ts';
import { installPixelGrid } from './ui/pixel-grid.ts';
import { openMedia } from './media.ts';
import { ReviewSession } from './session.ts';
import { formatTime } from './model.ts';
import type { Region, Slot } from './model.ts';
import { registerReviewTools, reviewTools } from './agent.ts';
import { bindFileDrop } from './file-drop.ts';
import { exportLog, getLogSessions, log, operationContext, readLogs, traceOperation, withLogContext } from './log.ts';
import { startBrowserLogging } from './log-storage.ts';
import { installLogPanel } from './log-panel.ts';
import { paintFrame } from './presenter.ts';
import { PanMomentumFilter, Viewport, splitPixelGeometry, wheelZoomFactor, ZOOM_PRESETS, classifyWheel, fittedSize, normalizeWheelDelta } from './viewport.ts';
import type { LayoutMode, PixelSizeMode, TrackGeometry, ViewportSnapshot } from './viewport.ts';

const stopLogging = startBrowserLogging();

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
$('app').innerHTML = shell();
const removeHeaderActions = installHeaderActions();
const actionMenu = installMenu($<HTMLButtonElement>('more-actions'), $('more-actions-menu'), { align: 'end' });
const canvases = Object.fromEntries(SLOTS.map(slot => [slot, $<HTMLCanvasElement>(`canvas-${slot}`)])) as Record<Slot, HTMLCanvasElement>;
const session = new ReviewSession((slot, frame) => paintFrame(canvases[slot], frame));
const removeLogPanel = installLogPanel($('export-log'));
const removeTooltips = installTooltips();
let inputTrigger = 'pointer';
let draft: { slot: Slot; region: Region } | null = null;
let lastFrames = '';
let message = '';
const drawingEditor = installDrawingEditor(session, canvases);
const workbench = installWorkbench(session, act, openMarkDialog);
const removeTrackDrag = installTrackDrag(session);
const sourceActions = installSourceActions(session, act, () => { void workbench.refreshLibrary(); });
bindTimelinePreview($<HTMLInputElement>('timeline'), $('timeline-preview'));
function openMarkDialog(slot: Slot = draft?.slot ?? workbench.selected()) {
  viewportChrome.setFocused(false);
  drawingEditor.open(slot, draft?.slot === slot ? draft.region : null);
  clearRegion();
}

const clearRegion = () => {
  draft = null;
  for (const slot of SLOTS) $(`region-${slot}`).firstElementChild!.setAttribute('width', '0');
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
const viewport = new Viewport();
const screens = document.querySelector<HTMLElement>('.screens')!;
const viewportChrome = installViewportChrome(document.querySelector<HTMLElement>('.viewport-surface')!, $<HTMLButtonElement>('toggle-chrome'));
const grids = Object.fromEntries(SLOTS.map(slot => [slot, installPixelGrid($<HTMLCanvasElement>(`grid-${slot}`), $(`grid-label-${slot}`))])) as Record<Slot, ReturnType<typeof installPixelGrid>>;
const fittedTracks = new Map<Slot, { width: number; height: number; sourceWidth: number; sourceHeight: number }>();
function trackGeometry(track: { slot: Slot; width: number; height: number }): TrackGeometry {
  const stage = $(`stage-${track.slot}`);
  return { slotW: stage.clientWidth, slotH: stage.clientHeight, videoW: track.width, videoH: track.height };
}
let primaryFitted: { width: number; height: number } | null = null;
function applyViewTransform() {
  const { zoom, offsetX, offsetY } = viewport;
  const value = zoom === 1 && !offsetX && !offsetY ? '' : `translate(${offsetX}px, ${offsetY}px) scale(${zoom})`;
  for (const slot of SLOTS) {
    const image = $(`image-${slot}`);
    if (image.style.transform !== value) image.style.transform = value;
    const stage = $(`stage-${slot}`);
    const fitted = fittedTracks.get(slot);
    const split = viewport.mode === 'split' && fittedTracks.size === 2;
    const first = stage.closest('.video-card')!.classList.contains('view-first');
    const cut = Math.max(0, Math.min(1, viewport.splitPos));
    const left = split && !first ? cut : 0, right = split && first ? cut : 1;
    const recovery = $(`recover-${slot}`);
    recovery.hidden = !fitted || right - left < .08 || !needsViewRecovery({ width: stage.clientWidth, height: stage.clientHeight, imageWidth: fitted?.width ?? 0, imageHeight: fitted?.height ?? 0, zoom, offsetX, offsetY }, left, right);
    recovery.style.left = `${(left + right) / 2 * 100}%`;
    grids[slot].update(fitted ? { width: stage.clientWidth, height: stage.clientHeight, imageWidth: fitted.width, imageHeight: fitted.height, sourceWidth: fitted.sourceWidth, sourceHeight: fitted.sourceHeight, zoom, panX: offsetX, panY: offsetY } : null);
  }
}
function syncSplitGeometry() {
  const rect=screens.getBoundingClientRect();
  const seam=splitPixelGeometry(viewport.splitPos,rect.width,rect.left,devicePixelRatio);
  for (const [name, value] of [['--split-x', `${seam.x}px`], ['--split-stroke-width', `${seam.strokeWidth}px`]]) {
    if (screens.style.getPropertyValue(name) !== value) screens.style.setProperty(name, value);
  }
}
function fitAll() {
  syncSplitGeometry();
  fittedTracks.clear();
  const allTracks = session.getState().tracks;
  const tracks = viewport.mode === 'split' ? allTracks.slice(0, 2) : allTracks;
  if (!tracks.length) { primaryFitted = null; applyViewTransform(); return; }
  // uniformVideoPixels reference: the track with the most pixels.
  const reference = tracks.reduce((a, b) => (a.width * a.height >= b.width * b.height ? a : b));
  const referenceGeometry = trackGeometry(reference);
  for (const track of tracks) {
    const geometry = trackGeometry(track);
    const size = fittedSize(geometry, referenceGeometry, viewport.pixelSize);
    fittedTracks.set(track.slot, { ...size, sourceWidth: track.width, sourceHeight: track.height });
    const image = $(`image-${track.slot}`);
    const width = `${size.width}px`, height = `${size.height}px`;
    if (image.style.width !== width) image.style.width = width;
    if (image.style.height !== height) image.style.height = height;
    if (track === (tracks.find(t => t.slot === 'A') ?? tracks[0])) {
      if (primaryFitted && (viewport.zoom !== 1 || viewport.offsetX || viewport.offsetY) &&
        (Math.abs(primaryFitted.width - size.width) > 0.5 || Math.abs(primaryFitted.height - size.height) > 0.5)) {
        viewport.rescaleOffset(size.width / primaryFitted.width, size.height / primaryFitted.height);
      }
      primaryFitted = size;
    }
  }
  applyViewTransform();
}
const fitTask = createFrameTask(fitAll);
const resizeObserver = new ResizeObserver(fitTask.schedule);
for (const slot of SLOTS) resizeObserver.observe($(`stage-${slot}`));
const zoomMenu = installChoiceMenu('zoom-select',ZOOM_PRESETS.map(p=>({value:String(p),label:`${p}×`})),value=>{
  viewport.setZoom(Number(value)); log.info('ui','缩放预设',{zoom:viewport.zoom,trigger:inputTrigger}); applyViewTransform(); syncZoomSelect(true);
},'search');
const pixelMenu = installChoiceMenu('pixel-size',[{value:'uniform',label:'统一像素'},{value:'fill',label:'填满视图'}],value=>{
  viewport.setPixelSize(value as PixelSizeMode); log.info('ui','切换像素尺寸模式',{pixelSize:viewport.pixelSize,trigger:inputTrigger}); fitTask.schedule();
  pixelMenu.sync(viewport.pixelSize,viewport.pixelSize==='uniform'?'统一像素':'填满视图',true);
});
function syncZoomSelect(loaded:boolean) { zoomMenu.sync(String(viewport.zoom),`${+viewport.zoom.toFixed(2)}×`,loaded); }
function render() {
  const state = session.getState();
  const loaded = state.tracks.length > 0;
  viewportChrome.update(loaded);
  const cards = document.querySelectorAll<HTMLElement>('.video-card');
  screens.classList.toggle('single', state.tracks.length < 2);
  const splitActive = viewport.mode === 'split' && state.tracks.length >= 2;
  screens.classList.toggle('split', splitActive);
  const columns = viewport.arrangement === 'grid' ? Math.min(2, Math.max(1, state.tracks.length)) : Math.max(1, state.tracks.length);
  screens.style.setProperty('--view-columns', String(columns));
  screens.style.setProperty('--view-rows', String(Math.ceil(Math.max(1, state.tracks.length) / columns)));
  screens.classList.toggle('grid-layout', viewport.arrangement === 'grid');
  if ($('arrangement').dataset.arrangement !== viewport.arrangement) {
    $('arrangement').dataset.arrangement = viewport.arrangement;
  $('arrangement').innerHTML = icon(viewport.arrangement === 'grid' ? 'columns' : 'grid');
  $('arrangement').setAttribute('aria-label', viewport.arrangement === 'grid' ? '切换为横向布局' : '切换为田字布局');
  $('arrangement').dataset.tooltip = viewport.arrangement === 'grid' ? '横向排列轨道' : '田字排列轨道';
  }
  syncSplitGeometry();
  for (const card of cards) {
    const slot = card.dataset.slot as Slot;
    const index = state.tracks.findIndex(t => t.slot === slot);
    card.hidden = loaded ? index < 0 || (splitActive && index >= 2) : slot !== 'A';
    card.style.order = String(Math.max(0, index));
    card.classList.toggle('view-first', index === 0 || !loaded);
    card.classList.toggle('view-second', index === 1);
    card.classList.toggle('column-divider', index > 0 && index % columns !== 0);
    card.classList.toggle('bottom-heading', !splitActive && viewport.arrangement === 'grid' && index >= columns);
  }
  document.querySelector<HTMLElement>('.transport')!.hidden = !loaded;
  for (const card of cards) card.querySelector<HTMLElement>('.card-heading')!.hidden = !loaded;
  const frames = JSON.stringify(state.tracks.map(t => [t.id, t.frame?.ptsUs]));
  if (frames !== lastFrames) { clearRegion(); lastFrames = frames; }
  for (const slot of SLOTS) {
    const t = state.tracks.find(t => t.slot === slot);
    $(`empty-${slot}`).hidden = !!t;
    $(`image-${slot}`).hidden = !t;
    $(`name-${slot}`).textContent = t?.name ?? (slot === 'A' ? '参考视频' : '对比视频');
    // Source HDR metadata is not proof of the browser's final HDR output.
    const hdr = t?.color && (t.color.transfer === 'pq' || t.color.transfer === 'hlg');
    const hdrTag = hdr ? (t.decoder === 'ffmpeg-wasm' ? ' · HDR 源（SDR 兜底显示）' : ' · HDR 源') : '';
    $(`meta-${slot}`).textContent = t ? `${t.width} × ${t.height} · ${t.codec}${t.decoder === 'ffmpeg-wasm' ? ' · WASM' : ''}${hdrTag}` : '尚未载入';
    $(`pts-${slot}`).textContent = t?.frame ? formatTime(t.frame.ptsUs) : '—';
    $(`pts-${slot}`).title = t?.frame ? `源时间戳 ${t.frame.sourcePtsUs} µs · 帧时长 ${t.frame.durationUs} µs` : '';
  }
  fitTask.schedule();
  const divider = $('divider');
  divider.hidden = !splitActive;
  divider.setAttribute('aria-valuenow', String(Math.round(viewport.splitPos * 100)));
  for (const button of document.querySelectorAll<HTMLButtonElement>('#layout-mode button')) {
    button.disabled = !loaded || (button.dataset.mode === 'split' && state.tracks.length < 2);
    button.dataset.tooltip = button.dataset.mode === 'split' ? '擦拭对比当前排序的前两个轨道' : '独立显示所有轨道';
    button.setAttribute('aria-pressed', String(button.dataset.mode === (splitActive ? 'split' : 'side-by-side')));
  }
  pixelMenu.sync(viewport.pixelSize,viewport.pixelSize==='uniform'?'统一像素':'填满视图',loaded);
  syncZoomSelect(loaded);
  $<HTMLButtonElement>('play').disabled = !loaded || state.busy;
  $<HTMLButtonElement>('previous').disabled = !loaded || state.busy;
  $<HTMLButtonElement>('next').disabled = $<HTMLButtonElement>('previous').disabled;
  $<HTMLInputElement>('position').disabled = !loaded;
  $<HTMLButtonElement>('export').disabled = !loaded && !state.marks.length;
  if ($('play').dataset.playing !== String(state.playing)) {
    $('play').innerHTML = icon(state.playing ? 'pause' : 'play');
    $('play').dataset.playing = String(state.playing);
  }
  $('play').setAttribute('aria-label', state.playing ? '暂停' : '播放');
  const timeline = $<HTMLInputElement>('timeline');
  timeline.disabled = !loaded || state.busy;
  timeline.max = String(Math.max(1, state.durationUs - 1));
  if (document.activeElement !== timeline) timeline.value = String(state.positionUs);
  timeline.style.setProperty('--progress-ratio', String(Number(timeline.value) / Math.max(1, Number(timeline.max))));
  $('position').style.setProperty('--time-input-chars', String(Math.max(formatTime(state.durationUs).length, formatTime(state.positionUs).length)));
  if(document.activeElement !== $('position')) $<HTMLInputElement>('position').value = formatTime(state.positionUs);
  $('duration').textContent = formatTime(state.durationUs);
  $('status').textContent = state.busy ? '正在解码…' : state.playing ? '播放中 · 静音' : loaded ? '已暂停' : '等待视频';
  $('decode').textContent = state.playback && state.playback.wallMs > 500 ? `实际速度 ${state.playback.speed.toFixed(2)}×` : loaded ? `最近定位 ${state.lastDecodeMs} ms` : '—';
  $('notice').hidden = !(message || state.error);
  $('notice').textContent = message || state.error;
  const times = state.tracks.map(t => t.frame?.ptsUs);
  $('alignment').textContent = times.length === 2 && times.every(t => t != null)
    ? `A / B 帧起点差 ${Math.abs(times[0]! - times[1]!) / 1000} ms`
    : '静音 · SDR · 本地文件';
  drawingEditor.render(state);
  workbench.render(state);
  sourceActions.render(state);

}
let importRevision = 0;
for (const slot of SLOTS) $(`remove-track-${slot}`).onclick = async () => {
  ++importRevision;
  await act(() => session.removeTrack(slot), 'ui.remove-track', { slot });
  const remaining = session.getState().tracks[0];
  if (remaining) document.querySelector<HTMLElement>(`.card-heading [data-drag-surface="${remaining.slot}"]`)?.focus();
  else $('open').focus();
};
async function importFiles(files: File[], slots: Slot[]) {
  const context = operationContext();
  const revision = ++importRevision;
  for (let i = 0; i < files.length; i++) {
    if (revision !== importRevision) throw new DOMException('文件导入已被新的请求取代。', 'AbortError');
    await withLogContext(context, () => session.load(slots[i], () => openMedia(files[i])));
    workbench.rememberFile(files[i]);
  }
}
const unbindDrop = bindFileDrop(document.body, {
  target: event => {
    const stage = event.target instanceof Element ? event.target.closest('.video-card')?.querySelector('.frame-stage') : null;
    return stage?.closest<HTMLElement>('[data-slot]')?.dataset.slot as Slot | undefined;
  },
  loaded: () => session.getState().tracks.map(track => track.slot),
  hover: slots => {
    for (const slot of SLOTS) $(`stage-${slot}`).classList.toggle('drop-target', slots.includes(slot));
  },
  load: (files, slots) => act(() => importFiles(files, slots), 'files.drop', { files, slots }),
  error: error => { log.warn('ui', '拖入文件失败', { error }); showError(error); },
});
for (const slot of SLOTS) {
  $<HTMLInputElement>(`file-${slot}`).onchange = event => {
    const input = event.target as HTMLInputElement; const file = input.files?.[0]; input.value = '';
    if (file) void act(() => importFiles([file], [slot]), 'files.select', { file, slot });
  };
  $<HTMLInputElement>(`file-${slot}`).oncancel = () => log.info('ui', '取消文件选择', { slot });
  const image = $(`image-${slot}`);
  let start: { x: number; y: number; pointer: number } | null = null;
  let dragging = false;
  const point = (e: PointerEvent) => { const r = image.getBoundingClientRect(); return { x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)) }; };
  image.onpointerdown = e => {
    if (e.button !== 0 || session.getState().busy || drawingEditor.active()) return;
    session.pause(); clearRegion(); start = { ...point(e), pointer: e.pointerId }; dragging = false; image.setPointerCapture(e.pointerId);
  };
  image.onpointermove = e => {
    if (!start || start.pointer !== e.pointerId) return;
    const end = point(e);
    const region = { left: Math.min(start.x, end.x), top: Math.min(start.y, end.y), width: Math.abs(start.x - end.x), height: Math.abs(start.y - end.y) };
    if (!dragging && region.width >= 0.005 && region.height >= 0.005) { dragging = true; log.info('ui', '开始框选', { slot }); }
    draft = { slot, region };
    const rect = $(`region-${slot}`).firstElementChild!;
    for (const [key, value] of Object.entries({ x: region.left, y: region.top, width: region.width, height: region.height })) rect.setAttribute(key, String(value));
  };
  image.onpointerup = e => {
    if (!start || start.pointer !== e.pointerId) return;
    start = null; image.releasePointerCapture(e.pointerId);
    if (dragging) log.info('ui', '结束框选', { slot, region: draft?.region ?? null });
    dragging = false;
    if (!draft || draft.region.width < 0.005 || draft.region.height < 0.005) clearRegion();
    else openMarkDialog(slot);
  };
  image.onpointercancel = () => { if (dragging) log.info('ui', '取消框选', { slot }); dragging = false; start = null; clearRegion(); };
}
// Viewport gestures (desktop parity): right-drag pans, wheel/pinch zooms at the
// cursor, trackpad two-finger scroll pans. Pan/zoom are shared by both tracks.
function wrapAnchor(target: Element | null, clientX: number, clientY: number) {
  const wrap = (target?.closest('.image-wrap') ?? target?.closest('.video-card')?.querySelector('.image-wrap') ?? document.querySelector('.image-wrap:not([hidden])')) as HTMLElement | null;
  if (!wrap) return { x: 0, y: 0 };
  const rect = wrap.getBoundingClientRect();
  // The rect center is post-transform (C + offset); recover the layout center.
  return { x: clientX - (rect.left + rect.width / 2) + viewport.offsetX, y: clientY - (rect.top + rect.height / 2) + viewport.offsetY };
}
let gestureLogTimer: ReturnType<typeof setTimeout> | undefined;
// Safari.app has been observed leaving stale composited tiles ("trails") in the
// stage area after zoom/pan gestures on a transformed canvas. Not reproducible
// in Playwright WebKit; as a mitigation, force the view to re-composite once
// when a gesture settles.
let flushScheduled = false;
function flushView() {
  if (flushScheduled) return;
  flushScheduled = true;
  requestAnimationFrame(() => {
    screens.style.transform = 'translateZ(0)';
    requestAnimationFrame(() => { screens.style.transform = ''; flushScheduled = false; });
  });
}
function logViewSettled(msg: string) {
  clearTimeout(gestureLogTimer);
  gestureLogTimer = setTimeout(() => {
    log.info('ui', msg, { zoom: Math.round(viewport.zoom * 1000) / 1000, offsetX: Math.round(viewport.offsetX), offsetY: Math.round(viewport.offsetY), trigger: inputTrigger });
    flushView();
  }, 400);
}
const panMomentum = new PanMomentumFilter();
for (const slot of SLOTS) {
  const stage = $(`stage-${slot}`);
  stage.addEventListener('contextmenu', e => e.preventDefault());
  let pan: { pointer: number; x: number; y: number } | null = null;
  stage.addEventListener('pointerdown', e => {
    if (e.button !== 2 || !session.getState().tracks.length) return;
    e.preventDefault();
    pan = { pointer: e.pointerId, x: e.clientX, y: e.clientY };
    stage.setPointerCapture(e.pointerId);
  });
  stage.addEventListener('pointermove', e => {
    if (!pan || pan.pointer !== e.pointerId) return;
    viewport.panBy(e.clientX - pan.x, e.clientY - pan.y);
    pan.x = e.clientX;
    pan.y = e.clientY;
    applyViewTransform();
  });
  const endPan = (e: PointerEvent) => {
    if (!pan || pan.pointer !== e.pointerId) return;
    pan = null;
    log.info('ui', '视口平移', { offsetX: Math.round(viewport.offsetX), offsetY: Math.round(viewport.offsetY) });
    flushView();
  };
  stage.addEventListener('pointerup', endPan);
  stage.addEventListener('pointercancel', endPan);
}
screens.addEventListener('wheel', e => {
  if (!session.getState().tracks.length) return;
  e.preventDefault();
  const inverted = (e as WheelEvent & { webkitDirectionInvertedFromDevice?: boolean }).webkitDirectionInvertedFromDevice;
  if (classifyWheel(e.deltaY, e.deltaMode, e.ctrlKey, inverted) === 'pan') {
    const dx = -normalizeWheelDelta(e.deltaX, e.deltaMode);
    const dy = -normalizeWheelDelta(e.deltaY, e.deltaMode);
    if (!panMomentum.accept(dx, dy, e.timeStamp)) return;
    viewport.panBy(dx, dy);
    applyViewTransform();
    logViewSettled('触控板滚动平移');
    return;
  }
  const factor = wheelZoomFactor(e.deltaY, e.deltaMode, e.ctrlKey);
  const anchor = wrapAnchor(e.target as Element | null, e.clientX, e.clientY);
  if (viewport.zoomAt(factor, anchor.x, anchor.y)) { applyViewTransform(); syncZoomSelect(true); logViewSettled('视口缩放'); }
}, { passive: false });
// Safari delivers trackpad pinch as gesture events instead of ctrl+wheel.
let gestureScale = 1;
for (const type of ['gesturestart', 'gesturechange', 'gestureend'] as const) {
  screens.addEventListener(type, e => {
    e.preventDefault();
    const event = e as Event & { scale?: number; clientX?: number; clientY?: number };
    const scale = event.scale ?? 1;
    if (type === 'gesturestart') { gestureScale = scale; return; }
    if (type === 'gestureend') { logViewSettled('视口缩放'); return; }
    if (!session.getState().tracks.length) { gestureScale = scale; return; }
    const anchor = wrapAnchor(e.target as Element | null, event.clientX ?? 0, event.clientY ?? 0);
    if (viewport.zoomAt(scale / gestureScale, anchor.x, anchor.y)) { applyViewTransform(); syncZoomSelect(true); }
    gestureScale = scale;
  });
}
// Splitter: draggable divider (unclamped while dragging, clamped on release,
// like the desktop) with a 5% keyboard step.
const divider = $('divider');
let dividerDrag: number | null = null;
divider.addEventListener('pointerdown', e => {
  if (e.button !== 0) return;
  e.preventDefault();
  dividerDrag = e.pointerId;
  divider.setPointerCapture(e.pointerId);
});
divider.addEventListener('pointermove', e => {
  if (dividerDrag !== e.pointerId) return;
  const rect = screens.getBoundingClientRect();
  viewport.setSplitPos((e.clientX - rect.left) / rect.width);
  syncSplitGeometry();
  applyViewTransform();
});
const endDividerDrag = (e: PointerEvent) => {
  if (dividerDrag !== e.pointerId) return;
  dividerDrag = null;
  viewport.setSplitPos(viewport.splitPos, true);
  syncSplitGeometry();
  divider.setAttribute('aria-valuenow', String(Math.round(viewport.splitPos * 100)));
  applyViewTransform();
  log.info('ui', '分割线拖拽结束', { splitPos: Math.round(viewport.splitPos * 1000) / 1000 });
};
divider.addEventListener('pointerup', endDividerDrag);
divider.addEventListener('pointercancel', endDividerDrag);
divider.addEventListener('keydown', e => {
  if (e.code !== 'ArrowLeft' && e.code !== 'ArrowRight') return;
  e.preventDefault();
  e.stopPropagation();
  viewport.setSplitPos(viewport.splitPos + (e.code === 'ArrowRight' ? 0.05 : -0.05), true);
  syncSplitGeometry();
  divider.setAttribute('aria-valuenow', String(Math.round(viewport.splitPos * 100)));
  applyViewTransform();
  log.info('ui', '分割线键盘调整', { splitPos: Math.round(viewport.splitPos * 1000) / 1000, trigger: 'keyboard' });
});
$('arrangement').onclick = () => {
  viewport.apply({ arrangement: viewport.arrangement === 'grid' ? 'horizontal' : 'grid', mode: 'side-by-side' });
  render();
};
for (const button of document.querySelectorAll<HTMLButtonElement>('#layout-mode button')) {
  button.onclick = () => {
    const mode = button.dataset.mode as LayoutMode;
    if (viewport.mode === mode) return;
    viewport.setMode(mode);
    log.info('ui', '切换布局模式', { mode, trigger: inputTrigger });
    render();
  };
}
installTimeInput($<HTMLInputElement>('position'),{
  read:()=>session.getState().positionUs,format:formatTime,parse:parseTimeInput,
  begin:()=>session.pause(),commit:ptsUs=>act(()=>session.seek(ptsUs),'seek.time',{ptsUs}),
});
$('reset-view').onclick = () => { viewport.reset(); fitTask.schedule(); syncZoomSelect(session.getState().tracks.length > 0); };
for (const slot of SLOTS) $(`recover-${slot}`).onclick = () => {
  const stage = $(`stage-${slot}`);
  const split = viewport.mode === 'split' && fittedTracks.size === 2;
  const first = stage.closest('.video-card')!.classList.contains('view-first');
  const cut = Math.max(0, Math.min(1, viewport.splitPos));
  const center = split ? (first ? cut / 2 : (1 + cut) / 2) : .5;
  viewport.apply({ offsetX: stage.clientWidth * (center - .5), offsetY: 0 }); applyViewTransform();
};
$('fullscreen').onclick = () => void act(async () => {
  if (document.fullscreenElement) await document.exitFullscreen();
  else await document.documentElement.requestFullscreen();
}, 'ui.fullscreen');
document.addEventListener('fullscreenchange', () => {
  const label = document.fullscreenElement ? '退出全屏' : '全屏';
  $('fullscreen').setAttribute('aria-label', label); $('fullscreen').title = label;
});
$<HTMLButtonElement>('fullscreen').disabled = !document.fullscreenEnabled;
$('open').onclick = () => {
  const state = session.getState();
  const slot = SLOTS.find(slot => !state.tracks.some(t => t.slot === slot)) ?? workbench.selected();
  $<HTMLInputElement>(`file-${slot}`).click();
};
$('help-open').onclick = () => $<HTMLDialogElement>('help').showModal();
$('help-close').onclick = () => $<HTMLDialogElement>('help').close();
$('play').onclick = () => void act(() => session.getState().playing ? session.pause() : session.play(), 'play.toggle');
$('previous').onclick = () => void act(() => session.step(-1), 'step.previous');
$('next').onclick = () => void act(() => session.step(1), 'step.next');
$<HTMLInputElement>('timeline').onchange = e => void act(() => session.seek(Number((e.target as HTMLInputElement).value)), 'seek.timeline', { ptsUs: Number((e.target as HTMLInputElement).value) });

$('export').onclick = () => void act(downloadReview, 'review.download');
document.addEventListener('keydown', e => {
  if (document.querySelector('dialog[open]') || drawingEditor.active()) return;
  if (e.target instanceof HTMLElement && (e.target.matches('input,textarea,select,button') || e.target.isContentEditable)) return;
  if (!session.getState().tracks.length || e.ctrlKey || e.metaKey || e.altKey) return;
  inputTrigger = 'keyboard';
  try {
    if (e.code === 'Space') { e.preventDefault(); if (!e.repeat) $('play').click(); }
    else if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') { e.preventDefault(); $(e.code === 'ArrowLeft' ? 'previous' : 'next').click(); }
    else if (e.code === 'KeyM') {
      e.preventDefault();
      if (!e.repeat) {
        viewport.setMode(viewport.mode === 'split' || session.getState().tracks.length < 2 ? 'side-by-side' : 'split');
        log.info('ui', '切换布局模式', { mode: viewport.mode, trigger: 'keyboard' });
        render();
      }
    }
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
  loadFile: (slot: Slot, file: File) => apiCall('loadFile', { slot, file }, async () => {
    const result = await session.load(slot, () => openMedia(file)); workbench.rememberFile(file); return result;
  }),
  getWorkspace: () => workbench.getState(),
  removeTrack: (slot: Slot) => apiCall('removeTrack', { slot }, () => session.removeTrack(slot)),
  reorderTracks: (order: Slot[]) => apiCall('reorderTracks', { order }, () => session.reorderTracks(order)),
  seek: (ptsUs: number) => apiCall('seek', { ptsUs }, () => session.seek(ptsUs)), step: (direction: number) => apiCall('step', { direction }, () => session.step(direction)),
  play: () => apiCall('play', {}, () => session.play()), pause: () => apiCall('pause', {}, () => session.pause()),
  addMark: (input: Parameters<ReviewSession['addMark']>[0]) => apiCall('addMark', input, () => session.addMark(input)),
  setTrackOffset: (slot:Slot,offsetUs:number)=>apiCall('setTrackOffset',{slot,offsetUs},()=>session.setTrackOffset(slot,offsetUs)),
  deleteMark: (id: string) => apiCall('deleteMark', { id }, () => session.deleteMark(id)), exportReview: () => session.exportReview(),
  getLogs: readLogs, listLogSessions: getLogSessions, exportLog,
  getViewport: (): ViewportSnapshot => viewport.snapshot(),
  setViewport: (patch: Partial<ViewportSnapshot>) => apiCall('setViewport', patch, () => { viewport.apply(patch); render(); }),
  tools: reviewTools(session),
};
Object.defineProperty(window, 'voidPlayer', { value: Object.freeze(api), configurable: true });
window.addEventListener('beforeunload', e => { if (session.getState().marks.length) { e.preventDefault(); e.returnValue = ''; } });
import.meta.hot?.dispose(() => { unregister(); actionMenu.dispose(); zoomMenu.dispose(); pixelMenu.dispose(); removeHeaderActions(); drawingEditor.dispose(); unbindDrop(); removeTooltips(); removeLogPanel(); workbench.dispose(); sourceActions.dispose(); removeTrackDrag(); Object.values(grids).forEach(grid => grid.dispose()); uiEvents.abort(); resizeObserver.disconnect(); fitTask.dispose(); void session.dispose().finally(stopLogging); });
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
