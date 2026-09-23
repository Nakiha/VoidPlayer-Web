import { isHdrTransfer } from './presentation-color.ts';
import { updateColorFlow } from './ui/color-flow.ts';
import { initializeGpuPresentation } from './webgpu-presenter.ts';
import { indexProgressLabel } from './index-progress.ts';
import { AnnotationClient } from './annotation-client.ts';
import { installAnnotationSync } from './ui/annotation-sync.ts';
import { installIdentitySettings } from './ui/identity-settings.ts';
import { installWorkspaceTransfer, isWorkspaceFile } from './ui/workspace-transfer.ts';
import { installThemeControls } from './ui/theme.ts';
import { parseTimeInput, installTimeInput } from './time-input.ts';
import { installSettings } from './ui/settings.ts';
import { matchesShortcut, PANEL_SHORTCUTS } from './ui/shortcuts.ts';
import { createFrameTask } from './ui/frame-task.ts';
import { installChoiceMenu } from './ui/choice-menu.ts';
import { installHeaderActions } from './ui/header-actions.ts';
import { SLOTS } from './model.ts';
import { installTooltips } from './ui/tooltips.ts';
import { installToasts } from './ui/toast.ts';
import { installBrandEffects } from './ui/brand-effects.ts';
import { installDrawingEditor } from './ui/drawing-editor.ts';
import { benchmarkPlayback } from './benchmark.ts';
// Feature styles in cascade order: accessibility overrides, component layout,
// then the settings window (scoped so it never depends on import position).
import './themes/accessibility.css';
import './style.css';
import './ui/settings.css';
import { shell } from './ui/shell.ts';
import { icon } from './ui/icons.ts';
import { installWorkbench } from './ui/workbench.ts';
import { installSourceActions } from './ui/source-actions.ts';
import { bindTimelinePreview, syncTimelineProgress } from './ui/seek-preview.ts';
import { installTrackDrag } from './ui/track-drag.ts';
import { createViewBindings } from './ui/view-bindings.ts';
import { installViewportGestures } from './ui/viewport-gestures.ts';
import { installViewportChrome } from './ui/viewport-chrome.ts';
import { installPixelGrid } from './ui/pixel-grid.ts';
import { openMedia } from './media.ts';
import { ReviewSession } from './session.ts';
import { formatTime } from './model.ts';
import type { Slot } from './model.ts';
import { registerReviewTools, reviewTools } from './agent.ts';
import { bindFileDrop } from './file-drop.ts';
import { handleKey, saveFileHandle } from './file-handles.ts';
import type { FsFileHandle } from './file-handles.ts';
import { exportLog, getLogSessions, log, operationContext, readLogs, traceOperation, withLogContext } from './log.ts';
import { startBrowserLogging } from './log-storage.ts';
import { installLogPanel } from './log-panel.ts';
import { paintFrame, captureFrame, disposePresentation, bindPresentationResources } from './presenter.ts';
import { setPresentationChannel } from './presentation-channel.ts';
import { Viewport, ZOOM_PRESETS } from './viewport.ts';
import type { ChannelMode, PixelSizeMode, ViewportSnapshot } from './viewport.ts';

const stopLogging = startBrowserLogging();
const uiEvents = new AbortController();

const $ = <T extends Element = HTMLElement>(id: string) => document.getElementById(id) as unknown as T;
$('app').innerHTML = shell();
const removeThemeControls = installThemeControls();
const removeHeaderActions = installHeaderActions();
const settings = installSettings();
$('brand-about').onclick = () => settings.openPane('about', $('brand-about'));
$('start-version-about').onclick = () => settings.openPane('about', $('start-version-about'));
const removeBrandEffects = installBrandEffects($<HTMLButtonElement>('brand-about'));
const canvases = Object.fromEntries(SLOTS.map(slot => [slot, $<HTMLCanvasElement>(`canvas-${slot}`)])) as Record<Slot, HTMLCanvasElement>;
const {setColorMode,setReferenceDecode}=await import('./color-mode.ts');
try{const saved=localStorage.getItem('voidplayer.reference-decode');if(saved)setReferenceDecode(JSON.parse(saved));}catch{}
let savedColorMode:'reference'|'browser'='browser';
try{if(localStorage.getItem('voidplayer.color-mode')==='reference')savedColorMode='reference';}catch{}
// Explicit diagnostic URLs retain their original backend-selection semantics.
if(!new URLSearchParams(location.search).has('colorPipeline'))setColorMode(savedColorMode);
// GPU warmup runs after first paint: early frames use the canvas path, surface
// creation failures already fall back inside initializeGpuPresentation, and
// color policy (set above) is only read lazily at decode time.
void initializeGpuPresentation(Object.values(canvases)).catch(error => {
  log.warn('media', 'GPU 后台初始化失败，已保留现有呈现路径。', { error: error instanceof Error ? error.message : String(error) });
});
const session = new ReviewSession((slot, frame) => paintFrame(canvases[slot], frame));
session.onColorModeChange=async()=>{const {refreshGpuColorMode}=await import('./webgpu-presenter.ts');await refreshGpuColorMode();};
const colorButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-color-mode]')];
const decoderButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-reference-decoder]')];
const depthMenu = installChoiceMenu('hardware-buffer-depth', [1,2,4,8].map(n=>({value:String(n),label:`${n} 帧`})), value=>{
  void act(()=>session.setReferenceDecode({...session.getState().referenceDecode,depth:Number(value) as 1|2|4|8})).finally(renderColorMode);
});
let flowKey = '';
const renderColorMode=()=>{
  const state=session.getState(), mode=state.colorMode??savedColorMode, decoder=state.referenceDecode.decoder;
  for(const button of colorButtons){button.setAttribute('aria-pressed',String(button.dataset.colorMode===mode));button.setAttribute('aria-disabled',String(state.busy));}
  for(const button of decoderButtons){button.setAttribute('aria-pressed',String(button.dataset.referenceDecoder===decoder));button.setAttribute('aria-disabled',String(state.busy));}
  $('reference-decode-settings').hidden=mode!=='reference';
  $('hardware-depth-row').style.visibility=decoder==='hardware'?'visible':'hidden';
  $('hardware-depth-row').inert=decoder!=='hardware';
  depthMenu.sync(String(state.referenceDecode.depth),`${state.referenceDecode.depth} 帧`,!state.busy);
  $('color-mode').setAttribute('aria-busy',String(state.busy));
  const key=`${mode}/${decoder}`;
  if(key!==flowKey){
    flowKey=key;updateColorFlow($('color-flow-diagram'),mode,decoder);
    $('color-mode-description').textContent=mode==='browser'?'软件回退仅近似匹配，颜色可能与原生帧不同。':decoder==='hardware'?'首帧核对失败则改用软件解码；读回帧有额外开销。':'保留原始帧精度，按统一规则转换；仅支持 SDR。';
  }
};
session.subscribe(renderColorMode);renderColorMode();
for(const button of colorButtons)button.onclick=()=>{if(session.getState().busy)return;void act(()=>session.setColorMode(button.dataset.colorMode as 'reference'|'browser')).finally(renderColorMode);};
for(const button of decoderButtons)button.onclick=()=>{if(session.getState().busy)return;void act(()=>session.setReferenceDecode({...session.getState().referenceDecode,decoder:button.dataset.referenceDecoder as 'hardware'|'software'})).finally(renderColorMode);};
window.addEventListener('pagehide',event=>{if(!event.persisted){removeBrandEffects();disposePresentation();void session.dispose();}});
const toasts = installToasts(uiEvents.signal);
const removeLogPanel = installLogPanel($('diagnostic-logs'), toasts);
const removeTooltips = installTooltips();
let inputTrigger = 'pointer';
let warningMessage = '';
let dismissWarning: (() => void) | null = null;
let benchmarkRunning = false;
let mixedColorToast: (() => void) | null = null;
const identitySettings = installIdentitySettings(actor => session.setActor(actor));
const drawingEditor = installDrawingEditor(session, canvases);
const notify = (message: string) => { toasts.show(message); };
const workbench = installWorkbench(session, act, openMarkDialog, notify);
const removeTrackDrag = installTrackDrag(session);
const sourceActions = installSourceActions(session, act, () => { void workbench.refreshLibrary(); }, notify);
bindTimelinePreview($<HTMLInputElement>('timeline'), $('timeline-preview'));
let timelineDragging = false;
let pendingTimelineUs: number | null = null;
let timelineRequest = 0;
$('timeline').addEventListener('input', () => { pendingTimelineUs = Number($<HTMLInputElement>('timeline').value); }, { signal: uiEvents.signal });
$('timeline').addEventListener('pointerdown', () => { timelineDragging = true; }, { signal: uiEvents.signal });
window.addEventListener('pointerup', () => { timelineDragging = false; }, { signal: uiEvents.signal });
window.addEventListener('pointercancel', () => { timelineDragging = false; pendingTimelineUs = null; renderProgress(session.getState().positionUs, session.getState().durationUs); }, { signal: uiEvents.signal });
function renderProgress(positionUs: number, durationUs: number) {
  const timeline = $<HTMLInputElement>('timeline');
  timeline.max = String(Math.max(1, durationUs - 1));
  if (!timelineDragging && pendingTimelineUs === null) {
    timeline.value = String(positionUs);
    syncTimelineProgress(timeline);
  }
  const position = $<HTMLInputElement>('position');
  if (document.activeElement !== position) {
    const label = formatTime(pendingTimelineUs ?? positionUs);
    position.style.setProperty('--time-input-chars', String(label.length));
    position.value = label;
  }
  workbench.renderProgress(positionUs, durationUs);
}
function openMarkDialog(slot: Slot = workbench.selected(), markId?: string) {
  viewportChrome.setFocused(false);
  drawingEditor.open(slot, markId);
}


function showWarning(message: string) {
  if (message === warningMessage) return;
  warningMessage = message;
  dismissWarning?.();
  const colorIssue = message.includes('自有色彩');
  dismissWarning = toasts.show(message, {
    kind: 'warning',
    action: { label: colorIssue ? '色彩与解码' : '日志', onClick: () => settings.openPane(colorIssue ? 'performance' : 'logs', $('settings-open')) },
  });
}
function showError(error: unknown) {
  session.captureDiagnostics('ui-error', error);
  showWarning(error instanceof Error ? error.message : String(error));
}
async function act(action: () => unknown | Promise<unknown>, name = 'ui.action', data: unknown = {}) {
  try { await traceOperation('ui', name, { trigger: inputTrigger, data }, action); } catch (e) { showError(e); }
  render();
}
for (const canvas of Object.values(canvases)) bindPresentationResources(canvas, session.resources);
const annotationSync = installAnnotationSync(session, () => drawingEditor.active());
const viewport = new Viewport();
const workspaceTransfer = installWorkspaceTransfer(session, {
  identityReady: identitySettings.ready, act, toasts, closeSettings: settings.close, capture: () => ({ viewport: viewport.snapshot(), layout: workbench.getState() }),
  beforeRestore() { if (drawingEditor.active()) $('mark-close').click(); return annotationSync.snapshotMode(); },
  async restore(document, resumeCloudAnnotations) { if (!resumeCloudAnnotations) await annotationSync.captureSnapshot(); viewport.apply(document.viewport); setPresentationChannel(viewport.channel); await workbench.restore(document.layout ?? workbench.getState()); render(); },
});
const screens = document.querySelector<HTMLElement>('.screens')!;
const viewportChrome = installViewportChrome(document.querySelector<HTMLElement>('.viewport-surface')!, $<HTMLButtonElement>('toggle-chrome'));
const grids = Object.fromEntries(SLOTS.map(slot => [slot, installPixelGrid($<HTMLCanvasElement>(`grid-${slot}`), $(`grid-label-${slot}`))])) as Record<Slot, ReturnType<typeof installPixelGrid>>;
const viewBindings = createViewBindings({ $, screens, canvases, grids, viewport, session, drawingEditor });
const { fittedTracks, applyViewTransform, syncSplitGeometry, fitAll } = viewBindings;
const fitTask = createFrameTask(fitAll);
const resizeObserver = new ResizeObserver(fitTask.schedule);
for (const slot of SLOTS) resizeObserver.observe($(`stage-${slot}`));
for (const el of document.querySelectorAll('.viewport-surface .card-heading, .viewport-surface .transport')) resizeObserver.observe(el);
const zoomMenu = installChoiceMenu('zoom-select',ZOOM_PRESETS.map(p=>({value:String(p),label:`${p}×`})),value=>{
  viewport.setZoom(Number(value)); log.info('ui','缩放预设',{zoom:viewport.zoom,trigger:inputTrigger}); applyViewTransform(); syncZoomSelect(true);
},'search');
const pixelMenu = installChoiceMenu('pixel-size',[{value:'uniform',label:'统一像素'},{value:'fill',label:'填满视图'}],value=>{
  viewport.setPixelSize(value as PixelSizeMode); log.info('ui','切换像素尺寸模式',{pixelSize:viewport.pixelSize,trigger:inputTrigger}); fitTask.schedule();
  pixelMenu.sync(viewport.pixelSize,viewport.pixelSize==='uniform'?'统一像素':'填满视图',true);
},'monitor');
const channelLabels: Record<ChannelMode, string> = { rgb: 'RGB', y: 'Y 通道', u: 'U 通道', v: 'V 通道' };
const channelMenu = installChoiceMenu('channel-select', (Object.keys(channelLabels) as ChannelMode[]).map(value => ({ value, label: channelLabels[value] })), value => {
  viewport.setChannel(value as ChannelMode); setPresentationChannel(viewport.channel);
  log.info('ui', '切换 YUV 通道', { channel: viewport.channel, trigger: inputTrigger });
  channelMenu.sync(viewport.channel, channelLabels[viewport.channel], true);
  // Playback frames pick up the new channel on their next paint; only a
  // paused view needs an explicit re-decode of the current position.
  const state = session.getState();
  if (state.tracks.length && !state.playing && !state.busy) void act(() => session.seek(state.positionUs), 'channel.seek', { channel: viewport.channel });
},'appearance', undefined, undefined, () => {
  if (session.getState().colorMode === 'reference') return true;
  toasts.show('请先在“色彩与解码”中切换为“自有色彩”，再选择 YUV 通道。', {
    action: { label: '前往色彩设置', onClick: () => settings.openPane('performance', $('channel-select')) },
  });
  return false;
});
function syncZoomSelect(loaded:boolean) { zoomMenu.sync(String(viewport.zoom),`${+viewport.zoom.toFixed(2)}×`,loaded); }
function render() {
  const state = session.getState();
  const loaded = state.tracks.length > 0;
  const visibleTracks = state.tracks.filter(t => t.visible);
  $('tracks-hidden').hidden = !loaded || visibleTracks.length > 0;
  $('performance-current').hidden = !loaded;
  $('color-runtime-tracks').textContent=state.tracks.map(track=>{
    const native=track.decoder==='webcodecs', label=native?'浏览器原生解码':'软件解码';
    const fallback=!native && (state.colorMode==='browser'||state.referenceDecode.decoder==='hardware');
    return `${track.slot} · ${track.name}\n${label}${fallback?'（已回退）':''} · ${track.output?.yuv?'原始平面':track.output?.format??'等待帧'}`;
  }).join('\n');
  viewportChrome.update(loaded);
  const cards = document.querySelectorAll<HTMLElement>('.video-card');
  screens.classList.toggle('single', visibleTracks.length < 2);
  const splitActive = viewport.mode === 'split' && visibleTracks.length >= 2;
  screens.classList.toggle('split', splitActive);
  const columns = viewport.arrangement === 'grid' ? Math.min(2, Math.max(1, visibleTracks.length)) : Math.max(1, visibleTracks.length);
  screens.style.setProperty('--view-columns', String(columns));
  screens.style.setProperty('--view-rows', String(Math.ceil(Math.max(1, visibleTracks.length) / columns)));
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
    const index = visibleTracks.findIndex(t => t.slot === slot);
    card.hidden = loaded ? index < 0 || (splitActive && index >= 2) : slot !== 'A';
    card.style.order = String(Math.max(0, index));
    card.classList.toggle('view-first', index === 0 || !loaded);
    card.classList.toggle('view-second', index === 1);
    card.classList.toggle('column-divider', index > 0 && index % columns !== 0);
    card.classList.toggle('bottom-heading', !splitActive && viewport.arrangement === 'grid' && index >= columns);
  }
  document.querySelector<HTMLElement>('.transport')!.hidden = !loaded;
  for (const card of cards) card.querySelector<HTMLElement>('.card-heading')!.hidden = !loaded;
  for (const slot of SLOTS) {
    const t = state.tracks.find(t => t.slot === slot);
    $(`empty-${slot}`).hidden = !!t;
    $(`image-${slot}`).hidden = !t || !!t.pendingRelink;
    $(`name-${slot}`).textContent = t?.name ?? (slot === 'A' ? '参考视频' : '对比视频');
    // Source HDR metadata is not proof of the browser's final HDR output.
    const hdr = t?.color && isHdrTransfer(t.color.transfer);
    const hdrTag = hdr ? (t.decoder === 'ffmpeg-wasm' ? ' · HDR 源（SDR 兜底显示）' : ' · HDR 源') : '';
    $(`meta-${slot}`).textContent = t ? `${t.width} × ${t.height} · ${t.codec} · ${t.decoder === 'ffmpeg-wasm' ? 'WASM 软件解码' : t.hardwareAcceleration === 'prefer-hardware' ? 'WebCodecs · 硬件优先' : 'WebCodecs · 浏览器解码'}${hdrTag}${t.syncState ? (t.syncState === 'index-wait' ? ' · 等待索引，画面暂未同步' : ' · 正在追赶播放位置') : ''}${t.indexState === 'building' ? ` · ${indexProgressLabel(t)}` : t.indexState === 'error' ? ' · 索引失败' : t.indexWarning ? ' · 尾部不完整，播放完整部分' : ''}` : '尚未载入';
    $(`failure-${slot}`).hidden = !t?.failure && !t?.syncState;
    $(`failure-${slot}`).textContent = t?.failure ? `轨道 ${slot} 已停用 · 画面已停止更新。${t.failure.message} 请重新载入此片源。` : t?.syncState ? `轨道 ${slot} ${t.syncState === 'index-wait' ? '等待索引数据' : '正在追赶播放位置'} · 当前画面暂未同步，其他轨道继续播放。` : '';
    if (t?.pendingRelink) {
      const failure = $(`failure-${slot}`);
      failure.textContent = `轨道 ${slot} 待重新关联 · 轨道、偏移和标注已保留。`;
      const reconnect = document.createElement('button'); reconnect.type = 'button'; reconnect.textContent = '重新关联片源';
      reconnect.onclick = () => { void act(() => workspaceTransfer.relinkMissing(), 'workspace.relink'); };
      failure.append(reconnect);
    }
    $(`pts-${slot}`).textContent = t?.frame ? formatTime(t.frame.ptsUs) : '—';
    $(`pts-${slot}`).title = t?.frame ? `源时间戳 ${t.frame.sourcePtsUs} µs · 帧时长 ${t.frame.durationUs} µs` : '';
  }
  fitTask.schedule();
  const divider = $('divider');
  divider.hidden = !splitActive;
  divider.setAttribute('aria-valuenow', String(Math.round(viewport.splitPos * 100)));
  for (const button of document.querySelectorAll<HTMLButtonElement>('#layout-mode button')) {
    button.disabled = !loaded || (button.dataset.mode === 'split' && visibleTracks.length < 2);
    button.dataset.tooltip = button.dataset.mode === 'split' ? '擦拭对比当前排序的前两个轨道' : '独立显示所有轨道';
    button.setAttribute('aria-pressed', String(button.dataset.mode === (splitActive ? 'split' : 'side-by-side')));
  }
  // All topbar view controls key off the same empty-session flag: no tracks,
  // no inspector/subtracks/analysis/arrangement/reset. Sources stays enabled so an
  // empty session can still browse the library; share keys off canShare().
  for (const id of ['arrangement', 'reset-view', 'toggle-inspector', 'toggle-subtracks', 'toggle-analysis']) {
    $<HTMLButtonElement>(id).disabled = !loaded;
  }
  pixelMenu.sync(viewport.pixelSize,viewport.pixelSize==='uniform'?'统一像素':'填满视图',loaded);
  channelMenu.sync(viewport.channel, channelLabels[viewport.channel], loaded);
  $('channel-select').dataset.tooltip = state.colorMode === 'reference'
    ? 'YUV 通道：仅原始平面帧生效' : 'YUV 通道：请先切换为自有色彩';
  syncZoomSelect(loaded);
  // Transient seek preparation must not dim the row or steal button focus.
  // Keep native disabled for empty sessions; busy actions are guarded below.
  for (const id of ['play', 'previous', 'next']) {
    const button = $<HTMLButtonElement>(id);
    button.disabled = !loaded;
    const disabled = String(!loaded || state.busy);
    if (button.getAttribute('aria-disabled') !== disabled) button.setAttribute('aria-disabled', disabled);
  }
  document.querySelector('.transport')!.setAttribute('aria-busy', String(state.busy));
  $<HTMLInputElement>('position').disabled = !loaded;
  $<HTMLButtonElement>('benchmark').disabled = benchmarkRunning || !loaded || state.busy || state.playing;
  if ($('play').dataset.playing !== String(state.playing)) {
    $('play').dataset.playing = String(state.playing);
  }
  const playLabel = state.playing ? '暂停' : '播放';
  if ($('play').getAttribute('aria-label') !== playLabel) $('play').setAttribute('aria-label', playLabel);
  const timeline = $<HTMLInputElement>('timeline');
  timeline.disabled = !loaded;
  timeline.setAttribute('aria-busy', String(state.busy));
  renderProgress(state.positionUs, state.durationUs);
  $('duration').textContent = formatTime(state.durationUs);
  $('status').textContent = state.busy ? '正在解码…' : state.playing ? '播放中 · 静音' : loaded ? '已暂停' : '等待视频';
  $('decode').textContent = state.playback && state.playback.wallMs > 500 ? `实际速度 ${state.playback.speed.toFixed(2)}×` : loaded ? `最近定位 ${state.lastDecodeMs} ms` : '—';
  const trackFailures = state.tracks.filter(t => t.failure).map(t => `轨道 ${t.slot} 已停用：${t.failure!.message}`).join('；');
  const warning = state.error || trackFailures;
  if (warning) showWarning(warning);
  else warningMessage = '';
  // 浏览器色彩下原生帧走浏览器转换、软件帧走近似转换，两者混合上屏时色彩
  // 不一致（见色彩设置页说明）。只做一次性提醒，需用户手动关闭；条件解除
  // （切换模式/只剩单一路）后自动清理，下次混合再提醒。不改解码与色彩管线。
  const presented = visibleTracks.filter(t => !t.failure && t.frame);
  const mixedColor = state.colorMode === 'browser'
    && presented.some(t => t.decoder === 'webcodecs')
    && presented.some(t => t.decoder === 'ffmpeg-wasm');
  if (mixedColor) {
    if (!mixedColorToast) {
      mixedColorToast = toasts.show('浏览器色彩下软件帧与原生帧混合上屏，色彩可能不准，建议切换色彩模式。', {
        kind: 'error', durationMs: 0,
        action: { label: '前往色彩设置', onClick: () => settings.openPane('performance', $('settings-open')) },
      });
    }
  } else if (mixedColorToast) {
    mixedColorToast();
    mixedColorToast = null;
  }
  const times = state.tracks.map(t => t.frame?.ptsUs);
  $('alignment').textContent = times.length === 2 && times.every(t => t != null)
    ? `A / B 帧起点差 ${Math.abs(times[0]! - times[1]!) / 1000} ms`
    : loaded ? `${state.tracks.length} 条轨道` : '';
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
async function importFiles(files: File[], slots: Slot[], handles?: (FsFileHandle | undefined)[]) {
  const context = operationContext();
  const revision = ++importRevision;
  for (let i = 0; i < files.length; i++) {
    if (revision !== importRevision) throw new DOMException('文件导入已被新的请求取代。', 'AbortError');
    await withLogContext(context, () => session.load(slots[i], (signal, progress) => openMedia(files[i], undefined, progress, signal), files[i].name));
    workbench.rememberFile(files[i]);
    // Remember drop-time handles so history rows can reopen without a picker.
    // Plain <input> files have no handle; those rows bootstrap one on reselect.
    const handle = handles?.[i];
    if (handle) await saveFileHandle(handleKey(files[i]), handle, files[i]).catch(() => {});
  }
}
const unbindDrop = bindFileDrop(document.body, {
  document: {
    accepts: files => files.some(isWorkspaceFile),
    load: files => act(async () => { const documents = files.filter(isWorkspaceFile); if (documents.length !== 1) throw new Error('每次请打开一个工作区文件。'); await workspaceTransfer.importFile(documents[0], files.filter(f => !isWorkspaceFile(f))); }, 'workspace.drop'),
  },
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
  const stage = $(`stage-${slot}`);
  let drawingStart: PointerEvent | undefined;
  let clickedDrawing: string | undefined;
  stage.addEventListener('pointerdown', e => {
    if (e.button !== 0 || session.getState().busy || drawingEditor.active() ||
      (e.target as Element).closest('button, input, label') || !session.getState().tracks.some(t => t.slot === slot && t.frame)) return;
    drawingStart = e;
    clickedDrawing = (e.target as Element).closest<SVGElement>('#annotations-' + slot + ' [data-shape-id]')?.dataset.shapeId;
    stage.setPointerCapture(e.pointerId);
  }, { signal: uiEvents.signal });
  stage.addEventListener('pointermove', e => {
    if (!drawingStart || e.pointerId !== drawingStart.pointerId ||
      Math.hypot(e.clientX - drawingStart.clientX, e.clientY - drawingStart.clientY) < 3) return;
    const start = drawingStart; drawingStart = undefined; clickedDrawing = undefined;
    drawingEditor.beginRectangle(slot, start, e);
  }, { signal: uiEvents.signal });
  stage.addEventListener('pointerup', e => {
    const start = drawingStart, drawingId = clickedDrawing;
    drawingStart = undefined; clickedDrawing = undefined;
    if (!start || e.pointerId !== start.pointerId || !drawingId ||
      Math.hypot(e.clientX - start.clientX, e.clientY - start.clientY) >= 3) return;
    const state = session.getState(), track = state.tracks.find(t => t.slot === slot);
    const mark = state.marks.find(m => m.mediaId === track?.id && m.frame.ptsUs === track.frame?.ptsUs && m.drawings?.some(d => d.id === drawingId));
    if (mark) drawingEditor.open(slot, mark.id, drawingId);
  }, { signal: uiEvents.signal });
  stage.addEventListener('pointercancel', () => { drawingStart = undefined; clickedDrawing = undefined; }, { signal: uiEvents.signal });
}
installViewportGestures({ $, screens, viewport, session, getTrigger: () => inputTrigger,
  applyViewTransform, syncSplitGeometry, syncZoomSelect, render });
installTimeInput($<HTMLInputElement>('position'),{
  read:()=>session.getState().positionUs,format:formatTime,parse:parseTimeInput,
  begin:()=>session.pause(),commit:ptsUs=>act(()=>session.seek(ptsUs),'seek.time',{ptsUs}),
});
$('show-all-tracks').onclick = () => {
  const tracks = session.getState().tracks;
  for (const track of tracks) if (!track.visible) session.setTrackVisibility(track.slot, true);
  if (tracks[0]) document.querySelector<HTMLButtonElement>(`[data-inspect="${tracks[0].slot}"]`)?.focus();
};
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
$('play').onclick = () => { if (!session.getState().busy) void act(() => session.getState().playing ? session.pause() : session.play(), 'play.toggle'); };
$('previous').onclick = () => { if (!session.getState().busy) void act(() => session.step(-1), 'step.previous'); };
$('next').onclick = () => { if (!session.getState().busy) void act(() => session.step(1), 'step.next'); };
$<HTMLInputElement>('timeline').onchange = async e => {
  const ptsUs = Number((e.target as HTMLInputElement).value), request = ++timelineRequest;
  pendingTimelineUs = ptsUs;
  try { await act(async () => { try { await session.seek(ptsUs); } catch (error) { if (!(error instanceof Error && error.name === 'AbortError')) throw error; } }, 'seek.timeline', { ptsUs }); }
  finally {
    if (request === timelineRequest) { pendingTimelineUs = null; const state = session.getState(); renderProgress(state.positionUs, state.durationUs); }
  }
};


// Space owns transport even when a button, menu, slider or drawing layer has
// focus. Capture prevents the focused control's native Space activation.
document.addEventListener('keydown', e => {
  if (!matchesShortcut(e, 'play') || e.isComposing || e.keyCode === 229) return;
  const editingText = e.composedPath().some(node => {
    if (!(node instanceof HTMLElement)) return false;
    if (node.isContentEditable) return true;
    if (node instanceof HTMLTextAreaElement) return !node.readOnly && !node.disabled;
    return node instanceof HTMLInputElement && !node.readOnly && !node.disabled &&
      !['button', 'submit', 'reset', 'checkbox', 'radio', 'range', 'file', 'color', 'image', 'hidden'].includes(node.type);
  });
  if (editingText) return;
  e.preventDefault(); e.stopPropagation();
  if (e.repeat || !session.getState().tracks.length) return;
  inputTrigger = 'keyboard';
  try {
    if (drawingEditor.active()) $('mark-close').click();
    $('play').click();
  } finally { inputTrigger = 'pointer'; }
}, { capture: true });
document.addEventListener('keydown', e => {
  if (e.repeat || e.isComposing || document.querySelector('dialog[open]') || drawingEditor.active()) return;
  if (e.target instanceof HTMLElement && (e.target.matches('input,textarea,select') || e.target.isContentEditable)) return;
  const panel = (Object.keys(PANEL_SHORTCUTS) as (keyof typeof PANEL_SHORTCUTS)[])
    .find(id => matchesShortcut(e, PANEL_SHORTCUTS[id]));
  if (!panel) return;
  const button = $<HTMLButtonElement>(`toggle-${panel}`);
  if (button.disabled) return;
  e.preventDefault(); button.click();
});
document.addEventListener('keydown', e => {
  if (document.querySelector('dialog[open]') || drawingEditor.active()) return;
  if (e.target instanceof HTMLElement &&
    (e.target.matches('input,textarea,select') || e.target.isContentEditable ||
      (e.target.matches('button') && !e.target.matches('#play,#previous,#next')))) return;
  if (!session.getState().tracks.length || e.ctrlKey || e.metaKey || e.altKey) return;
  inputTrigger = 'keyboard';
  try {
    if (matchesShortcut(e, 'previous') || matchesShortcut(e, 'next')) { e.preventDefault(); $(matchesShortcut(e, 'previous') ? 'previous' : 'next').click(); }
    else if (matchesShortcut(e, 'annotate')) { e.preventDefault(); openMarkDialog(); }
    else if (matchesShortcut(e, 'layout')) {
      e.preventDefault();
      if (!e.repeat) {
        viewport.setMode(viewport.mode === 'split' || session.getState().tracks.filter(t => t.visible).length < 2 ? 'side-by-side' : 'split');
        log.info('ui', '切换布局模式', { mode: viewport.mode, trigger: 'keyboard' });
        render();
      }
    }
  } finally { inputTrigger = 'pointer'; }
});
// Semantic inputs only: no per-keystroke text capture or pointer-move traffic.
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
session.subscribe(render);
session.subscribeProgress(renderProgress);
const unregister = registerReviewTools(session, workspaceTransfer);
const apiCall = <T>(name: string, data: unknown, action: () => T) => traceOperation('api', name, data, action);
const api = {
  getState: () => session.getState(),
  captureFrame: (slot: Slot) => {
    if (!SLOTS.includes(slot) || !session.getState().tracks.some(track => track.slot === slot)) throw new Error('轨道没有可读取的画面。');
    return captureFrame(canvases[slot]);
  },
  loadFile: (slot: Slot, file: File) => apiCall('loadFile', { slot, file }, async () => {
    const result = await session.load(slot, (signal, progress) => openMedia(file, undefined, progress, signal), file.name); workbench.rememberFile(file); return result;
  }),
  getWorkspace: () => workbench.getState(),
  shareWorkspace: workspaceTransfer.shareWorkspace, exportWorkspace: workspaceTransfer.exportWorkspace, importWorkspace: workspaceTransfer.importWorkspace,
  removeTrack: (slot: Slot) => apiCall('removeTrack', { slot }, () => session.removeTrack(slot)),
  reorderTracks: (order: Slot[]) => apiCall('reorderTracks', { order }, () => session.reorderTracks(order)),
  seek: (ptsUs: number) => apiCall('seek', { ptsUs }, () => session.seek(ptsUs)), step: (direction: number) => apiCall('step', { direction }, () => session.step(direction)),
  play: () => apiCall('play', {}, () => session.play()), pause: () => apiCall('pause', {}, () => session.pause()),
  cancelLoad: () => apiCall('cancelLoad', {}, () => session.cancelLoad()),
  addMark: (input: Parameters<ReviewSession['addMark']>[0]) => apiCall('addMark', input, () => session.addMark(input)),
  setTrackOffset: (slot:Slot,offsetUs:number)=>apiCall('setTrackOffset',{slot,offsetUs},()=>session.setTrackOffset(slot,offsetUs)),
  deleteMark: (id: string) => apiCall('deleteMark', { id }, () => session.deleteMark(id)), exportReview: () => session.exportReview(),
  getLogs: readLogs, listLogSessions: getLogSessions, exportLog,
  getViewport: (): ViewportSnapshot => viewport.snapshot(),
  setViewport: (patch: Partial<ViewportSnapshot>) => apiCall('setViewport', patch, async () => {
    const before = viewport.channel;
    viewport.apply(patch);
    // UI 与 Agent 共用同一 viewport 行为：通道是纯视图状态，切换后同步上屏层；
    // 暂停时重解当前帧，播放中后续帧自动生效，不打断播放。
    if (viewport.channel !== before) {
      setPresentationChannel(viewport.channel);
      log.info('ui', '切换 YUV 通道', { channel: viewport.channel, trigger: 'api' });
    }
    render();
    const state = session.getState();
    if (viewport.channel !== before && state.tracks.length && !state.playing && !state.busy) await session.seek(state.positionUs);
  }),
  tools: reviewTools(session, workspaceTransfer),
};
Object.defineProperty(window, 'voidPlayer', { value: Object.freeze(api), configurable: true });
const annotationLink = new URL(location.href).searchParams;
if (annotationLink.has('annotation')) void act(async () => {
  const space=annotationLink.get('space') ?? 'default', id=annotationLink.get('annotation')!;
  if(!/^[a-zA-Z0-9_-]{1,200}$/.test(space) || !/^[a-zA-Z0-9_-]{1,200}$/.test(id))throw new Error('标注地址无效。');
  const record=await new AnnotationClient(uiEvents.signal).read(space,id);
  if(record.deleted)throw new Error('这条标注已在回收站。');
  const mark=record.document.mark;
  const opened=await workspaceTransfer.importWorkspace({schema:'voidplayer-workspace',version:1,generatedAt:new Date().toISOString(),serverUrl:location.origin+'/',positionUs:mark.frame.ptsUs,tracks:[{slot:mark.slot,mediaId:mark.mediaId,offsetUs:0}],media:record.document.media,marks:[mark],viewport:viewport.snapshot()});
  if(opened)await annotationSync.openSpace(space);
},'annotation.open');

import.meta.hot?.dispose(() => { unregister(); annotationSync.dispose(); identitySettings.dispose(); workspaceTransfer.dispose(); removeThemeControls(); settings.dispose(); zoomMenu.dispose(); pixelMenu.dispose(); channelMenu.dispose(); removeHeaderActions(); drawingEditor.dispose(); disposePresentation(); unbindDrop(); removeTooltips(); removeLogPanel(); workbench.dispose(); sourceActions.dispose(); removeTrackDrag(); Object.values(grids).forEach(grid => grid.dispose()); uiEvents.abort(); resizeObserver.disconnect(); fitTask.dispose(); void session.dispose().finally(stopLogging); });
render();
// First frame is rendered and handlers are wired; only GPU warmup (background)
// and the annotation deep-link restore (already async) are still outstanding,
// so bootstrap can reveal without waiting for them.
window.dispatchEvent(new Event('voidplayer:shell-ready'));

$('benchmark').addEventListener('click', () => {
  void act(async () => {
    const button = $<HTMLButtonElement>('benchmark');
    benchmarkRunning = true; button.disabled = true;
    $('benchmark-result').removeAttribute('hidden');
    $('benchmark-summary').textContent = '正在检查播放性能…';
    let report;
    try { report = await benchmarkPlayback(session); }
    catch (error) { $('benchmark-summary').textContent = error instanceof Error ? error.message : String(error); throw error; }
    finally { benchmarkRunning = false; }
    const reasons: Record<string, string> = { 'below-realtime': '播放速度不足', 'frame-lag': '画面落后',
      'track-skew': '双轨不同步', 'insufficient-sample': '样本时长不足', 'page-not-visible': '测试期间页面不可见',
      'pause-latency': '暂停响应慢', 'stale-frame-after-pause': '暂停后画面改变', 'premature-end': '画面未播完',
      'playback-error': '播放出错', 'interrupted': '测试被中断', 'media-changed': '测试期间视频被替换', 'no-frames': '没有输出画面' };
    $('benchmark-summary').textContent = report.passed ? '通过' : `未通过：${report.failures.map(f => reasons[f] ?? (f.endsWith('presentation-stall') ? `${f[0]} 轨画面卡顿` : f)).join('、')}`;
    $<HTMLTextAreaElement>('benchmark-json').value = JSON.stringify(report, null, 2);

  }, 'ui.benchmark');
});
