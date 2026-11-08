import { mediaDiagnostic } from '../shared/media/io/media-errors.ts';
import type { MediaDiagnostic } from '../shared/media/io/media-errors.ts';
import { diagnosticMessage } from './ui/diagnostic-message.ts';
import { mountLocalizedShell } from './ui/localized-shell.ts';
import { installLanguageControls } from './ui/language.ts';
import { t as tr, getLocale, onLanguageChange, msg } from './i18n.ts';
import { isHdrTransfer } from './presentation/presentation-color.ts';
import { updateColorFlow } from './ui/color-flow.ts';
import { configureFrameResourceDemand } from './media/policy/frame-resources.ts';
import { setColorMode, setReferenceDecode } from './media/policy/color-mode.ts';
import { setColorOutput } from '../shared/color/color-output.ts';
import { hdrDisplayAvailable } from './presentation/display-capabilities.ts';
import { initializeGpuPresentation, keepNativeGpuResource } from './presentation/webgpu-presenter.ts';
import { indexProgressLabel } from './ui/index-progress.ts';
import { LocalInputError, selectVideoInputs } from './ui/video-input.ts';
import { fileBasename } from './ui/filename.ts';
import { AnnotationClient } from './review/annotation-client.ts';
import { installAnnotationSync } from './ui/annotation-sync.ts';
import { installOfflineControls } from './ui/offline-app.ts';
import { installIdentitySettings } from './ui/identity-settings.ts';
import { installWorkspaceTransfer, isWorkspaceFile } from './ui/workspace-transfer.ts';
import { installThemeControls } from './ui/theme.ts';
import { installTimeInput } from './ui/time-input.ts';
import { installFramePositions } from './ui/frame-position.ts';
import { parseTimeInput } from '../shared/review/time-input.ts';
import { analysisConcurrency, ANALYSIS_CONCURRENCY_EVENT } from './ui/analysis/concurrency.ts';
import { installSettings } from './ui/settings.ts';
import { matchesShortcut, PANEL_SHORTCUTS } from './ui/shortcuts.ts';
import { installFocusFeedback } from './ui/focus-feedback.ts';
import { createFrameTask } from './ui/frame-task.ts';
import { installChoiceMenu } from './ui/choice-menu.ts';
import { installNumericChoice } from './ui/numeric-choice.ts';
import { installHeaderActions } from './ui/header-actions.ts';
import { installTopbarCompact } from './ui/topbar-compact.ts';
import { SLOTS } from '../shared/review/model.ts';
import { dropSlots } from '../shared/review/drop-slots.ts';
import { installTooltips } from './ui/tooltips.ts';
import { installToasts } from './ui/toast.ts';
import { AnalysisFailure } from '../shared/analysis/bitstream/failure.ts';
import { createTrackToasts } from './ui/track-toasts.ts';
import { installBrandEffects } from './ui/brand-effects.ts';
import { animatePlaybackIcon } from './ui/playback-icon.ts';
import { animateArrangementIcon } from './ui/arrangement-icon.ts';
import { installDrawingEditor } from './ui/drawing-editor.ts';
import { installMarkPreviewBackfill } from './ui/mark-preview-backfill.ts';
// Feature styles in cascade order: accessibility overrides, component layout,
// then the settings window (scoped so it never depends on import position).
import './themes/accessibility.css';
import './style.css';
import './ui/settings.css';
import { shell } from './ui/shell.ts';
import { installWorkbench } from './ui/workbench.ts';
import { installSourceActions } from './ui/source-actions.ts';
import { parseLibraryFileLink } from './ui/library-link.ts';
import { bindTimelinePreview, syncTimelineProgress } from './ui/seek-preview.ts';
import { installTrackDrag } from './ui/track-drag.ts';
import { createViewBindings } from './ui/view-bindings.ts';
import { installViewportGestures } from './ui/viewport-gestures.ts';
import { installViewportChrome } from './ui/viewport-chrome.ts';
import { installPixelGrid } from './ui/pixel-grid.ts';
import { openMedia } from './media/source.ts';
import { ReviewSession } from './session.ts';
import { formatTime } from '../shared/review/model.ts';
import type { Slot } from '../shared/review/model.ts';
import { registerReviewTools, reviewTools } from './agent.ts';
import {installPageBridge} from './agent/page-bridge.ts';
import { bindFileDrop, bindFileLaunch, type LocalFileActions } from './ui/file-drop.ts';
import { installFileDropFeedback } from './ui/file-drop-feedback.ts';
import { handleKey, saveFileHandle } from './services/file-handles.ts';
import type { FsFileHandle } from './services/file-handles.ts';
import { exportLog, getLogSessions, log, operationContext, readLogs, traceOperation, withLogContext } from './logging/log.ts';
import { startBrowserLogging } from './logging/storage.ts';
import { installLogPanel } from './ui/logging/panel.ts';
import { paintFrame, captureFrame, disposePresentation, bindPresentationResources, redrawPresentationChannel } from './presentation/presenter.ts';
import { setPresentationChannel } from './presentation/presentation-channel.ts';
import { Viewport, ZOOM_PRESETS, ZOOM_MIN, ZOOM_MAX } from '../shared/presentation/viewport.ts';
import type { ChannelMode, PixelSizeMode, ViewportSnapshot } from '../shared/presentation/viewport.ts';

const stopLogging = startBrowserLogging();
const uiEvents = new AbortController();
installFocusFeedback(uiEvents.signal);

const $ = <T extends Element = HTMLElement>(id: string) => document.getElementById(id) as unknown as T;
mountLocalizedShell($<HTMLElement>('app'), shell, uiEvents.signal);
installLanguageControls(uiEvents.signal);
document.title = tr(msg("page.title", "VoidPlayer · 视频对比"));
const removeThemeControls = installThemeControls();
const removeHeaderActions = installHeaderActions();
installTopbarCompact(document.querySelector<HTMLElement>('.topbar')!, uiEvents.signal);
const settings = installSettings();
$<HTMLButtonElement>('start-identity').onclick = () => settings.openPane('identity', $<HTMLButtonElement>('start-identity'));
const removeBrandEffects = installBrandEffects($<HTMLButtonElement>('brand-about'),
  () => settings.openPane('about', $<HTMLElement>('brand-about')));
const canvases = Object.fromEntries(SLOTS.map(slot => [slot, $<HTMLCanvasElement>(`canvas-${slot}`)])) as Record<Slot, HTMLCanvasElement>;
try{const saved=localStorage.getItem('voidplayer.color-output');if(saved)setColorOutput(JSON.parse(saved));}catch{}
try {
  const saved = localStorage.getItem('voidplayer.reference-decode');
  if (saved) {
    const { depth } = JSON.parse(saved);
    setReferenceDecode({ decoder: 'hardware', depth });
    localStorage.setItem('voidplayer.reference-decode', JSON.stringify({ depth }));
  }
} catch {}
let savedColorMode:'reference'|'browser'='browser';
try{if(localStorage.getItem('voidplayer.color-mode')==='reference')savedColorMode='reference';}catch{}
// Explicit diagnostic URLs retain their original backend-selection semantics.
if(!new URLSearchParams(location.search).has('colorPipeline'))setColorMode(savedColorMode);
// GPU warmup runs after first paint: early frames use the canvas path, surface
// creation failures already fall back inside initializeGpuPresentation, and
// color policy (set above) is only read lazily at decode time.
configureFrameResourceDemand(keepNativeGpuResource);
const gpuReady=initializeGpuPresentation(Object.values(canvases)).catch(error => {
  log.warn('media', 'GPU 后台初始化失败，已保留现有呈现路径。', { error: error instanceof Error ? error.message : String(error) });
});
const session = new ReviewSession((slot, frame) => paintFrame(canvases[slot], frame));
const framePositions = installFramePositions(session, uiEvents.signal);
session.setBitstreamAnalysisConcurrency(analysisConcurrency());
window.addEventListener(ANALYSIS_CONCURRENCY_EVENT, event => session.setBitstreamAnalysisConcurrency((event as CustomEvent<number>).detail), { signal: uiEvents.signal });
session.onColorModeChange=async()=>{const {refreshGpuColorMode}=await import('./presentation/webgpu-presenter.ts');await refreshGpuColorMode();};
const colorButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-color-mode]')];
const outputButtons=[...document.querySelectorAll<HTMLButtonElement>('[data-color-target]')];
const peakMenu=installChoiceMenu('hdr-source-peak',()=>[1000,2000,4000,10000].map(n=>({value:String(n),label:`${n} nits`})),value=>{
  const output=session.getState().colorOutput,peak=Number(value);
  void act(()=>session.setColorOutput({...output,preview:{...output.preview,sourcePeakNits:peak,hlgDisplayPeakNits:peak,hlgSystemGamma:1.2+.42*Math.log10(peak/1000)}})).finally(renderColorMode);
});
const decoderButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-reference-decoder]')];
const depthMenu = installChoiceMenu('hardware-buffer-depth', () => [1,2,4,8].map(n=>({value:String(n),label:tr(msg("player.frames", "{count, plural, other {# 帧}}"), { count: n })})), value=>{
  void act(()=>session.setReferenceDecode({...session.getState().referenceDecode,depth:Number(value) as 1|2|4|8})).finally(renderColorMode);
});
let flowKey = '';
const renderColorMode=()=>{
  const state=session.getState(), mode=state.colorMode??savedColorMode, decoder=state.referenceDecode.decoder;
  for(const button of colorButtons){button.setAttribute('aria-pressed',String(button.dataset.colorMode===mode));button.setAttribute('aria-disabled',String(state.busy));}
  for(const button of decoderButtons){button.setAttribute('aria-pressed',String(button.dataset.referenceDecoder===decoder));button.setAttribute('aria-disabled',String(state.busy));}
  $('reference-decode-settings').hidden=mode!=='reference';
  $('hardware-depth-row').hidden=mode!=='reference'||decoder!=='hardware';
  depthMenu.sync(String(state.referenceDecode.depth),tr(msg("player.frames", "{count, plural, other {# 帧}}"), { count: state.referenceDecode.depth }),!state.busy);
  $('color-mode').setAttribute('aria-busy',String(state.busy));
  for(const button of outputButtons){button.setAttribute('aria-pressed',String(button.dataset.colorTarget===state.colorOutput.target));button.setAttribute('aria-disabled',String(state.busy));}
  $('hdr-source-peak-row').hidden=state.colorOutput.target!=='hdr';
  peakMenu.sync(String(state.colorOutput.preview.sourcePeakNits),`${state.colorOutput.preview.sourcePeakNits} nits`,!state.busy);
  const fallback=state.colorOutput.target==='hdr'&&state.tracks.length>0&&state.tracks.some(track=>track.presentation?.actualTarget!=='hdr');
  const nativeBlocked=state.tracks.some(track=>track.presentation?.fallbackReason?.startsWith('browser-hdr-'));
  $('color-output-description').textContent=nativeBlocked?tr(msg("colorOutput.browserPreview", "浏览器未开放原生 HDR 浮点转换，当前使用 SDR 预览；可切换自有色彩输出 HDR")):fallback?tr(msg("colorOutput.fallbackDescription", "当前环境使用 SDR 预览；HDR 显示目标已保留")):'';
  const key=`${getLocale()}/${mode}/${decoder}`;
  if(key!==flowKey){
    flowKey=key;updateColorFlow($('color-flow-diagram'),mode,decoder);
    $('color-mode-description').textContent=mode==='browser'?tr(msg("player.softwareFallbackIsAnApproximationColorsMay", "软件回退仅近似匹配，颜色可能与原生帧不同")):decoder==='hardware'?tr(msg("player.fallsBackToSoftwareIfFirstFrame", "首帧核对失败则改用软件解码；读回帧有额外开销")):tr(msg("player.preservesOriginalFramePrecisionWithConsistentConversion", "保留原始帧精度，按统一规则转换；HDR 使用明确参数映射"));
  }
};
for(const button of outputButtons)button.onclick=()=>{if(session.getState().busy)return;void act(()=>session.setColorOutput({...session.getState().colorOutput,target:button.dataset.colorTarget as 'sdr'|'hdr'})).finally(renderColorMode);};
let pendingDisplayRefresh=false;
const refreshDisplay=()=>{const state=session.getState();if(!pendingDisplayRefresh||state.busy||state.playing)return;pendingDisplayRefresh=false;queueMicrotask(()=>void act(()=>session.refreshColorOutput()).finally(renderColorMode));};
matchMedia('(dynamic-range: high)').addEventListener('change',()=>{pendingDisplayRefresh=true;refreshDisplay();});
session.subscribe(refreshDisplay);
void gpuReady.then(()=>{const state=session.getState();if(hdrDisplayAvailable()&&state.colorOutput.target==='hdr'&&state.tracks.some(track=>track.presentation?.actualTarget!=='hdr')){pendingDisplayRefresh=true;refreshDisplay();}});
session.subscribe(renderColorMode);renderColorMode();
for(const button of colorButtons)button.onclick=()=>{if(session.getState().busy)return;void act(()=>session.setColorMode(button.dataset.colorMode as 'reference'|'browser')).finally(renderColorMode);};
for(const button of decoderButtons)button.onclick=()=>{if(session.getState().busy)return;void act(()=>session.setReferenceDecode({...session.getState().referenceDecode,decoder:button.dataset.referenceDecoder as 'hardware'|'software'})).finally(renderColorMode);};
const toasts = installToasts(uiEvents.signal);
session.onDecoderPressure = kind => {
  if (kind === 'vvc-software') {
    toasts.show(() => tr(msg('player.vvcPlaybackPressure', 'H.266 软件解码轨道持续缺帧，可在「色彩与解码」中选择「自动扩容」或手动设置线程数，重新打开视频后生效')), {
      kind: 'warning', action: { label: () => tr(msg('settingsShell.colorDecoding', '色彩与解码')), onClick: () => settings.openPane('performance') },
    });
  } else {
    toasts.show(() => tr(msg('player.hardwarePlaybackPressure', '硬件优先的解码轨道持续缺帧，多轨播放时可关闭部分轨道以减轻负担')), { kind: 'warning' });
  }
};
const renderTrackToasts = createTrackToasts(toasts, () => settings.openPane('logs', $<HTMLElement>('settings-open')), uiEvents.signal);
const removeLogPanel = installLogPanel($('diagnostic-logs'), toasts);
const removeTooltips = installTooltips();
let inputTrigger = 'pointer';
let warningMessage = '';
let dismissWarning: (() => void) | null = null;
let mixedColorToast: (() => void) | null = null;
const identitySettings = installIdentitySettings(actor => session.setActor(actor));
const drawingEditor = installDrawingEditor(session, canvases);
const markPreviewBackfill = installMarkPreviewBackfill(session, canvases, () => drawingEditor.active());
const notify = (message: string) => { toasts.show(message); };
const workbench = installWorkbench(session, act, openMarkDialog, notify);
$('toggle-annotations').onclick = () => {
  if (session.getState().busy) return;
  if (drawingEditor.active()) $('mark-close').click();
  else drawingEditor.open(workbench.selected());
};
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

function showWarning(message: string, diagnostic: MediaDiagnostic | undefined = session.getErrorDiagnostic()) {
  if (message === warningMessage) return;
  warningMessage = message;
  dismissWarning?.();
  const pane = diagnostic ? 'performance' : 'logs';
  dismissWarning = toasts.show(() => diagnosticMessage(message, diagnostic), {
    kind: 'warning',
    action: { label: () => diagnostic ? tr(msg("settingsShell.colorDecoding", "色彩与解码")) : tr(msg("shell.logs", "日志")), onClick: () => settings.openPane(pane, $<HTMLElement>('settings-open')) },
  });
}
function showError(error: unknown) {
  if (error instanceof AnalysisFailure && error.code === 'cancelled' || error instanceof Error && error.name === 'AbortError') return;
  if (error instanceof LocalInputError) { notify(error.message); return; }
  session.captureDiagnostics('ui-error', error);
  showWarning(error instanceof Error ? error.message : String(error), mediaDiagnostic(error));
}
async function act(action: () => unknown | Promise<unknown>, name = 'ui.action', data: unknown = {}) {
  try { await traceOperation('ui', name, { trigger: inputTrigger, data }, action); } catch (e) { showError(e); }
  render();
}
for (const slot of SLOTS) bindPresentationResources(canvases[slot], session.resources, frame => session.recordRecoveredPresentation(slot, frame));
window.addEventListener('voidplayer:presentation-error', () => {
  showWarning(tr(msg('player.graphicsRecoveryFailed', '画面恢复失败，请刷新页面；若仍无画面，请完全退出并重新打开浏览器')));
}, { signal: uiEvents.signal });
window.addEventListener('voidplayer:ui-error', event => showError((event as CustomEvent).detail), { signal: uiEvents.signal });
const annotationSync = installAnnotationSync(session, () => drawingEditor.active());
const viewport = new Viewport();
const workspaceTransfer = installWorkspaceTransfer(session, {
  openSharedSpace: (space, seededIds) => seededIds ? annotationSync.attachWorkspace(space, seededIds) : annotationSync.openSpace(space),
  annotationScope: annotationSync.scope,
  identityReady: identitySettings.ready, act, toasts, closeSettings: settings.close, capture: () => ({ viewport: viewport.snapshot(), layout: workbench.getState() }),
  openingChanged: () => render(),
  beforeRestore() { if (drawingEditor.active()) $('mark-close').click(); return annotationSync.snapshotMode(); },
  async restore(document, resumeCloudAnnotations) { if (!resumeCloudAnnotations) await annotationSync.captureSnapshot(); viewport.apply(document.viewport); setPresentationChannel(viewport.channel); await workbench.restore(document.layout ?? workbench.getState()); render(); },
});
// Recovery's pagehide listener must capture the scene before disposal clears its tracks.
window.addEventListener('pagehide', event => {
  if (event.persisted) return;
  void session.dispose();
  removeBrandEffects();
  viewportChrome.dispose();
  disposePresentation();
});
const screens = document.querySelector<HTMLElement>('.screens')!;
const viewportChrome = installViewportChrome(document.querySelector<HTMLElement>('.viewport-surface')!, $<HTMLButtonElement>('toggle-chrome'));
const grids = Object.fromEntries(SLOTS.map(slot => [slot, installPixelGrid($<HTMLCanvasElement>(`grid-${slot}`), $(`grid-label-${slot}`))])) as Record<Slot, ReturnType<typeof installPixelGrid>>;
const viewBindings = createViewBindings({ $, screens, canvases, grids, viewport, session, drawingEditor });
const { fittedTracks, applyViewTransform, syncSplitGeometry, fitAll } = viewBindings;
const fitTask = createFrameTask(fitAll);
const resizeObserver = new ResizeObserver(fitTask.schedule);
resizeObserver.observe(screens);
for (const slot of SLOTS) resizeObserver.observe($(`stage-${slot}`));
for (const el of document.querySelectorAll('.viewport-surface .card-heading, .viewport-surface .transport-dock')) resizeObserver.observe(el);
const zoomMenu = installNumericChoice('zoom-select', { glyph: 'search', presets: ZOOM_PRESETS, suffix: '×', min: ZOOM_MIN, max: ZOOM_MAX,
  editLabel: () => tr(msg('player.editZoom', '编辑缩放倍数')),
  choose(value) { viewport.setZoom(value); log.info('ui','缩放数值',{zoom:viewport.zoom,trigger:inputTrigger}); applyViewTransform(); syncZoomSelect(true); },
});
const pixelMenu = installChoiceMenu('pixel-size',() => [{value:'uniform',label:tr(msg("player.uniformPixels", "统一像素"))},{value:'fill',label:tr(msg("player.fillView", "填满视图"))}],value=>{
  viewport.setPixelSize(value as PixelSizeMode); log.info('ui','切换像素尺寸模式',{pixelSize:viewport.pixelSize,trigger:inputTrigger}); fitTask.schedule();
  pixelMenu.sync(viewport.pixelSize,viewport.pixelSize==='uniform'?tr(msg("player.uniformPixels", "统一像素")):tr(msg("player.fillView", "填满视图")),true);
},'monitor');
const channelLabels = (): Record<ChannelMode, string> => ({ rgb: 'RGB', y: tr(msg("player.yChannel", "Y 通道")), u: tr(msg("player.uChannel", "U 通道")), v: tr(msg("player.vChannel", "V 通道")) });
const channelMenu = installChoiceMenu('channel-select', () => (Object.keys(channelLabels()) as ChannelMode[]).map(value => ({ value, label: channelLabels()[value] })), value => {
  viewport.setChannel(value as ChannelMode); setPresentationChannel(viewport.channel);
  log.info('ui', '切换 YUV 通道', { channel: viewport.channel, trigger: inputTrigger });
  channelMenu.sync(viewport.channel, channelLabels()[viewport.channel], true);
  void act(redrawPresentationChannel, 'channel.redraw', { channel: viewport.channel });
},'appearance', undefined, undefined, () => {
  if (session.getState().colorMode === 'reference') return true;
  toasts.show(() => tr(msg("player.switchToManagedColorInColorDecoding", "请先在“色彩与解码”中切换为“自有色彩”，再选择 YUV 通道")), {
    action: { label: () => tr(msg("player.openColorSettings", "前往色彩设置")), onClick: () => settings.openPane('performance', $<HTMLElement>('channel-select')) },
  });
  return false;
});
function syncZoomSelect(loaded:boolean) { zoomMenu.sync(String(viewport.zoom),`${+viewport.zoom.toFixed(2)}×`,loaded); }
function render() {
  const state = session.getState();
  framePositions.update(state.tracks);
  const openingWorkspace = $('app').hasAttribute('data-workspace-opening');
  const loaded = state.tracks.length > 0 || openingWorkspace;
  const visibleTracks = state.tracks.filter(t => t.visible);
  $('tracks-hidden').hidden = !loaded || visibleTracks.length > 0;
  $('color-runtime-section').hidden = !loaded;
  $('color-runtime-tracks').textContent=state.tracks.map(track=>{
    const native=track.decoder==='webcodecs', label=native?tr(msg("player.browserNativeDecoding", "浏览器原生解码")):tr(msg("colorFlow.softwareDecoding", "软件解码"));
    const presentation=track.presentation;
    const display=presentation?` · ${presentation.actualTarget==='hdr'?'HDR':'SDR'} · ${presentation.outputFormat==='float16'?'Display-P3 float16':'sRGB 8-bit'}`:'';
    const blocked=presentation?.fallbackReason;
    const reason=blocked==='browser-hdr-headroom-unavailable'||blocked==='browser-hdr-float16-unavailable'?tr(msg("colorOutput.nativeHdrUnavailable", " · 浏览器未开放 HDR 浮点转换")):blocked==='native-hdr-resource-unverified'?tr(msg("colorOutput.nativeResourceUnverified", " · 原生帧未通过 HDR 资源验证")):blocked==='hdr-display-unavailable'?tr(msg("colorOutput.displayUnavailable", " · 浏览器未报告 HDR 屏幕")):blocked?tr(msg("colorOutput.gpuUnavailable", " · HDR 呈现条件未满足")):'';
    const fallback=!native && (state.colorMode==='browser'||state.referenceDecode.decoder==='hardware');
    return `${track.slot} · ${track.name}
${label}${fallback?tr(msg("player.fallback", "（已回退）")):''} · ${track.output?.yuv?tr(msg("player.rawPlanes", "原始平面")):track.output?.format??tr(msg("player.waitingForFrame", "等待帧"))}${display}${reason}`;
  }).join('\n');
  viewportChrome.update(loaded);
  const cards = document.querySelectorAll<HTMLElement>('.video-card');
  screens.classList.toggle('single', visibleTracks.length < 2);
  const splitActive = viewport.mode === 'split' && visibleTracks.length >= 2;
  screens.classList.toggle('split', splitActive);
  screens.classList.toggle('grid-layout', viewport.arrangement === 'grid');
  if ($('arrangement').dataset.arrangement !== viewport.arrangement) {
    $('arrangement').dataset.arrangement = viewport.arrangement;
    animateArrangementIcon($('arrangement'), viewport.arrangement);
    $('arrangement').setAttribute('aria-label', viewport.arrangement === 'grid' ? tr(msg("player.switchToHorizontalLayout", "切换为横向布局")) : tr(msg("shell.switchToGridLayout", "切换为田字布局")));
    $('arrangement').dataset.tooltip = viewport.arrangement === 'grid' ? tr(msg("player.arrangeTracksHorizontally", "横向排列轨道")) : tr(msg("shell.arrangeTracksInAGrid", "田字排列轨道"));
  }
  $('divider').hidden = !splitActive;
  syncSplitGeometry();
  for (const card of cards) {
    const slot = card.dataset.slot as Slot;
    const index = visibleTracks.findIndex(t => t.slot === slot);
    card.hidden = state.tracks.length ? index < 0 || (splitActive && index >= 2) : slot !== 'A';
    card.style.order = String(Math.max(0, index));
    card.classList.toggle('view-first', index === 0 || !loaded);
    card.classList.toggle('view-second', index === 1);
  }
  document.querySelector<HTMLElement>('.transport')!.hidden = !loaded;
  for (const card of cards) card.querySelector<HTMLElement>('.card-heading')!.hidden = !loaded;
  for (const slot of SLOTS) {
    const t = state.tracks.find(t => t.slot === slot);
    $(`empty-${slot}`).hidden = !!t || openingWorkspace;
    $(`image-${slot}`).hidden = !t;
    const name = $(`name-${slot}`);
    const basename = t ? fileBasename(t.name) : (slot === 'A' ? tr(msg("player.referenceVideo", "参考视频")) : tr(msg("player.comparisonVideo", "对比视频")));
    if (name.textContent !== basename) name.textContent = basename;
    if (t) name.parentElement!.dataset.tooltip = t.name;
    else delete name.parentElement!.dataset.tooltip;
    // Source HDR metadata is not proof of the browser's final HDR output.
    const hdr = t?.color && isHdrTransfer(t.color.transfer);
    const hdrTag = hdr ? (t.presentation?.actualTarget==='hdr' ? tr(msg("player.hdrDisplay", " · HDR 输出")) : t.presentation?.actualTarget==='sdr' ? tr(msg("player.hdrSourceSdrFallback", " · HDR 源（SDR 预览）")) : tr(msg("player.hdrSource", " · HDR 源"))) : '';
    $(`meta-${slot}`).textContent = t ? `${t.width} × ${t.height} · ${t.codec} · ${t.decoder === 'ffmpeg-wasm' ? tr(msg("player.wasmSoftwareDecoding", "WASM 软件解码")) : t.hardwareAcceleration === 'prefer-hardware' ? tr(msg("player.webcodecsPreferHardware", "WebCodecs · 硬件优先")) : tr(msg("player.webcodecsBrowserDecoding", "WebCodecs · 浏览器解码"))}${hdrTag}${t.syncState ? (t.syncState === 'index-wait' ? tr(msg("player.waitingForIndexFrameNotSynchronized", " · 等待索引，画面暂未同步")) : tr(msg("player.catchingUpToPlayback", " · 正在追赶播放位置"))) : ''}${t.indexState === 'building' ? ` · ${indexProgressLabel(t)}` : t.indexState === 'error' ? tr(msg("player.indexFailed", " · 索引失败")) : t.indexWarning ? tr(msg("player.incompleteTailPlayingCompletePortion", " · 尾部不完整，播放完整部分")) : ''}` : tr(msg("player.notLoaded", "尚未载入"));
  }
  fitTask.schedule();
  for (const button of document.querySelectorAll<HTMLButtonElement>('#layout-mode button')) {
    button.disabled = !loaded || (button.dataset.mode === 'split' && visibleTracks.length < 2);
    button.dataset.tooltip = button.dataset.mode === 'split' ? tr(msg("player.wipeBetweenTheFirstTwoTracksIn", "擦拭对比当前排序的前两个轨道")) : tr(msg("player.showAllTracksSeparately", "独立显示所有轨道"));
    button.setAttribute('aria-pressed', String(button.dataset.mode === (splitActive ? 'split' : 'side-by-side')));
  }
  // All topbar view controls key off the same empty-session flag: no tracks,
  // no inspector/subtracks/analysis/arrangement/reset. Sources stays enabled so an
  // empty session can still browse the library; share keys off canShare().
  for (const id of ['arrangement', 'toggle-inspector', 'toggle-subtracks', 'toggle-analysis']) {
    $<HTMLButtonElement>(id).disabled = !loaded;
  }
  pixelMenu.sync(viewport.pixelSize,viewport.pixelSize==='uniform'?tr(msg("player.uniformPixels", "统一像素")):tr(msg("player.fillView", "填满视图")),loaded);
  // 通道隔离只对原始平面帧生效（见 presenter 按 frame.kind 守卫）：浏览器色彩下
  // 实际输出恒为 RGB。这里显示实际生效的通道，已存的 viewport.channel 原样保留，
  // 切回自有色彩时仍恢复，避免丢掉用户的选择。
  const effectiveChannel = state.colorMode === 'reference' ? viewport.channel : 'rgb';
  channelMenu.sync(effectiveChannel, channelLabels()[effectiveChannel], loaded);
  $<HTMLElement>('channel-select').dataset.tooltip = state.colorMode === 'reference'
    ? tr(msg("shell.yuvChannelsRawYuvFramesOnly", "YUV 通道：仅原始平面帧生效")) : tr(msg("player.yuvChannelsSwitchToManagedColorFirst", "YUV 通道：请先切换为自有色彩"));
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
  if ($('play').dataset.playing !== String(state.playing)) {
    $('play').dataset.playing = String(state.playing);
    animatePlaybackIcon($('play'), state.playing);
  }
  const playLabel = state.playing ? tr(msg("player.pause", "暂停")) : tr(msg("shell.play", "播放"));
  if ($('play').getAttribute('aria-label') !== playLabel) $('play').setAttribute('aria-label', playLabel);
  const timeline = $<HTMLInputElement>('timeline');
  timeline.disabled = !loaded;
  timeline.setAttribute('aria-busy', String(state.busy));
  renderProgress(state.positionUs, state.durationUs);
  $('duration').textContent = formatTime(state.durationUs);
  $('status').textContent = openingWorkspace ? tr(msg('transfer.importing', '工作区正在导入，请等待完成')) : state.busy ? tr(msg("player.decoding", "正在解码…")) : state.playing ? tr(msg("player.playingMuted", "播放中 · 静音")) : loaded ? tr(msg("player.paused", "已暂停")) : tr(msg("player.waitingForVideo", "等待视频"));
  $('decode').textContent = state.playback && state.playback.wallMs > 500 ? tr(msg("player.actualSpeed", "实际速度 {p0}×"), { p0: state.playback.speed.toFixed(2) }) : loaded ? tr(msg("player.lastSeekMs", "最近定位 {p0} ms"), { p0: state.lastDecodeMs }) : '—';
  renderTrackToasts(state.tracks);
  const warning = state.error;
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
      mixedColorToast = toasts.show(() => tr(msg("player.mixingSoftwareAndNativeFramesInBrowser", "浏览器色彩下软件帧与原生帧混合上屏，色彩可能不准，建议切换色彩模式")), {
        kind: 'error', durationMs: 0,
        action: { label: () => tr(msg("player.openColorSettings", "前往色彩设置")), onClick: () => settings.openPane('performance', $<HTMLElement>('settings-open')) },
      });
    }
  } else if (mixedColorToast) {
    mixedColorToast();
    mixedColorToast = null;
  }
  const times = state.tracks.map(t => t.frame?.ptsUs);
  $('alignment').textContent = times.length === 2 && times.every(t => t != null)
    ? tr(msg("player.aBFrameStartDifferenceMs", "A / B 帧起点差 {p0} ms"), { p0: Math.abs(times[0]! - times[1]!) / 1000 })
    : loaded ? tr(msg("player.tracks", "{p0, plural, other {# 条轨道}}"), { p0: state.tracks.length }) : '';
  drawingEditor.render(state);
  markPreviewBackfill.schedule();
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
async function importFiles(files: File[], handles?: (FsFileHandle | undefined)[]) {
  dropSlots(files.length, session.getState().tracks.map(track => track.slot));
  const context = operationContext();
  const revision = ++importRevision;
  for (let i = 0; i < files.length; i++) {
    if (revision !== importRevision) throw new DOMException(tr(msg("player.fileImportWasSupersededByANewer", "文件导入已被新的请求取代")), 'AbortError');
    const slot = dropSlots(files.length - i, session.getState().tracks.map(track => track.slot))[0];
    await withLogContext(context, () => session.load(slot, (signal, progress, configuration) => openMedia(files[i], undefined, progress, signal, configuration), files[i].name));
    workbench.rememberFile(files[i]);
    // Remember drop-time handles so history rows can reopen without a picker.
    // Plain <input> files have no handle; those rows bootstrap one on reselect.
    const handle = handles?.[i];
    if (handle) await saveFileHandle(handleKey(files[i]), handle, files[i]).catch(() => {});
  }
}
const dropFeedback = installFileDropFeedback(document.querySelector<HTMLElement>('.viewport-surface')!);
const fileActions: LocalFileActions = {
  document: {
    accepts: files => files.some(isWorkspaceFile),
    load: (files, origin) => traceOperation('ui', `workspace.${origin}`, { trigger: origin === 'launch' ? 'system' : inputTrigger }, async () => {
      const documents = files.filter(isWorkspaceFile);
      if (documents.length !== 1) throw new Error(tr(msg('player.openOneWorkspaceFileAtATime', '每次请打开一个工作区文件')));
      await workspaceTransfer.importFile(documents[0], files.filter(f => !isWorkspaceFile(f)));
    }),
  },
  loaded: () => session.getState().tracks.map(track => track.slot),
  load: (files, slots, handles, origin) => act(() => importFiles(files, handles), `files.${origin}`, { files, slots }),
  error: error => { if (!(error instanceof LocalInputError)) log.warn('ui', '打开本地文件失败', {error}); showError(error); },
};
const unbindDrop = bindFileDrop(document.body, { ...fileActions, hover: (slots, nonVideo) => dropFeedback.show(slots, nonVideo) });
if (import.meta.env.PROD && window.top === window && location.pathname === '/' && location.search === '?open=files'
    && !document.querySelector('meta[name="voidplayer-page-bridge"]')) bindFileLaunch(fileActions, identitySettings.ready, uiEvents.signal);
for (const slot of SLOTS) {
  $<HTMLInputElement>(`file-${slot}`).onchange = event => {
    const input = event.target as HTMLInputElement; const file = input.files?.[0]; input.value = '';
    if (file) void act(async () => {
      const accepted = await selectVideoInputs([{file}], showError);
      if (accepted.length) await importFiles([file]);
    }, 'files.select', {file,slot});
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
const syncFullscreenLabel = () => {
  const label = document.fullscreenElement ? tr(msg("player.exitFullscreen", "退出全屏")) : tr(msg("shell.fullscreen", "全屏"));
  $('fullscreen').setAttribute('aria-label', label); $('fullscreen').title = label;
};
document.addEventListener('fullscreenchange', syncFullscreenLabel);
onLanguageChange(syncFullscreenLabel, uiEvents.signal);
$<HTMLButtonElement>('fullscreen').disabled = !document.fullscreenEnabled;
$('open').onclick = () => {
  const state = session.getState();
  const slot = SLOTS.find(slot => !state.tracks.some(t => t.slot === slot));
  if (!slot) { showWarning(tr(msg('sources.noEmptyTracks', '没有空轨道，请先关闭一个视频'))); return; }
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
  if (matchesShortcut(e, 'focusMode')) {
    const button = $<HTMLButtonElement>('toggle-chrome');
    if (!button.hidden && !button.disabled) {
      e.preventDefault();
      inputTrigger = 'keyboard';
      try { button.click(); } finally { inputTrigger = 'pointer'; }
    }
    return;
  }
  const panel = (Object.keys(PANEL_SHORTCUTS) as (keyof typeof PANEL_SHORTCUTS)[])
    .find(id => matchesShortcut(e, PANEL_SHORTCUTS[id]));
  if (!panel) return;
  const button = $<HTMLButtonElement>(`toggle-${panel}`);
  if (button.disabled) return;
  e.preventDefault(); button.click();
});
document.addEventListener('keydown', e => {
  if (e.defaultPrevented || e.isComposing || e.keyCode === 229 || document.querySelector('dialog[open]') || drawingEditor.active()) return;
  // Directional widgets keep their own keys. Ordinary focused buttons must not
  // swallow frame stepping or turn the unhandled arrow into focus feedback.
  const localKeys = 'input,textarea,select,[role="slider"],[role="separator"],[role="spinbutton"],[role="combobox"],'
    + '[role="menu"],[role="listbox"],[role="tablist"],[role="tree"],[role="grid"],[role="radiogroup"]';
  const path = e.composedPath();
  if (path.some(node => node instanceof HTMLElement && (node.isContentEditable || node.matches(localKeys)))) return;
  if (document.querySelector('.popup-menu:popover-open, .header-actions[popover]:popover-open')) return;
  if (!session.getState().tracks.length || e.ctrlKey || e.metaKey || e.altKey) return;
  const frameStep = matchesShortcut(e, 'previous') || matchesShortcut(e, 'next');
  const button = path.find(node => node instanceof HTMLButtonElement);
  if (button && !frameStep && !button.matches('#play,#previous,#next')) return;
  inputTrigger = 'keyboard';
  try {
    if (frameStep) { e.preventDefault(); $(matchesShortcut(e, 'previous') ? 'previous' : 'next').click(); }
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
onLanguageChange(() => {
  document.title = tr(msg("page.title", "VoidPlayer · 视频对比"));
  delete $('arrangement').dataset.arrangement;
  flowKey = '';
  renderColorMode();
  workbench.localize();
  render();
}, uiEvents.signal);
session.subscribe(render);
session.subscribeProgress(renderProgress);
const unregister = registerReviewTools(session, workspaceTransfer);
const apiCall = <T>(name: string, data: unknown, action: () => T) => traceOperation('api', name, data, action);
const api = {
  getState: () => session.getState(),

  captureFrame: (slot: Slot) => {
    if (!SLOTS.includes(slot) || !session.getState().tracks.some(track => track.slot === slot)) throw new Error(tr(msg("player.noReadableFrameInThisTrack", "轨道没有可读取的画面")));
    return captureFrame(canvases[slot]);
  },
  loadFile: (slot: Slot, file: File) => apiCall('loadFile', { slot, file }, async () => {
    await selectVideoInputs([{file}], error => { throw error; });
    const result = await session.load(slot, (signal, progress, configuration) => openMedia(file, undefined, progress, signal, configuration), file.name); workbench.rememberFile(file); return result;
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
    // 直接复用已上屏帧与 GPU 平面，不重新定位或解码，也不打断播放。
    if (viewport.channel !== before) {
      setPresentationChannel(viewport.channel);
      redrawPresentationChannel();
      log.info('ui', '切换 YUV 通道', { channel: viewport.channel, trigger: 'api' });
    }
    render();

  }),
  tools: reviewTools(session, workspaceTransfer),
  subscribePresentedFrames: (listener: Parameters<ReviewSession['subscribePresentedFrames']>[0]) => session.subscribePresentedFrames(listener),
  subscribeState: (listener: () => void) => session.subscribe(listener),
};
Object.defineProperty(window, 'voidPlayer', { value: Object.freeze(api), configurable: true });
// Capture the temporary host marker before the bridge consumes its document credential.
if (import.meta.env.PROD && window.top === window && !document.querySelector('meta[name="voidplayer-page-bridge"]')) {
  window.addEventListener('voidplayer:startup-ready', () => { void installOfflineControls(toasts, identitySettings.ready); }, { once: true });
}
installPageBridge(session,api.tools,uiEvents.signal);
const annotationLink = new URL(location.href).searchParams;
if (annotationLink.has('media') && !['annotation','workspace','share','review'].some(key => annotationLink.has(key))) void act(async () => {
  const file = parseLibraryFileLink(location.href,location.href);
  if (!file) return;
  await identitySettings.ready;
  if (!uiEvents.signal.aborted) await workbench.openLibraryFile(file.id,file.version);
},'library.open-link');
if (annotationLink.has('annotation')) void act(async () => {
  // A cold annotation deep link must establish its actor before accepting the
  // workspace open intent, just like saved-workspace and recovery entry points.
  await identitySettings.ready;
  const space=annotationLink.get('space') ?? 'default', id=annotationLink.get('annotation')!;
  if(!/^[a-zA-Z0-9_-]{1,200}$/.test(space) || !/^[a-zA-Z0-9_-]{1,200}$/.test(id))throw new Error(tr(msg("player.invalidAnnotationAddress", "标注地址无效")));
  const record=await new AnnotationClient(uiEvents.signal).read(space,id);
  if(record.deleted)throw new Error(tr(msg("player.thisAnnotationIsInTheRecycleBin", "这条标注已在回收站")));
  const mark=record.document.mark;
  const opened=await workspaceTransfer.importWorkspace({schema:'voidplayer-workspace',version:1,generatedAt:new Date().toISOString(),serverUrl:location.origin+'/',positionUs:mark.frame.ptsUs,tracks:[{slot:mark.slot,mediaId:mark.mediaId,offsetUs:0}],media:record.document.media,marks:[mark],viewport:viewport.snapshot()});
  if(opened)await annotationSync.openSpace(space);
},'annotation.open');

import.meta.hot?.dispose(() => { unregister(); annotationSync.dispose(); identitySettings.dispose(); workspaceTransfer.dispose(); removeThemeControls(); settings.dispose(); depthMenu.dispose(); zoomMenu.dispose(); pixelMenu.dispose(); channelMenu.dispose(); removeHeaderActions(); viewportChrome.dispose(); drawingEditor.dispose(); markPreviewBackfill.dispose(); disposePresentation(); unbindDrop(); dropFeedback.dispose(); removeTooltips(); removeLogPanel(); workbench.dispose(); sourceActions.dispose(); removeTrackDrag(); Object.values(grids).forEach(grid => grid.dispose()); uiEvents.abort(); resizeObserver.disconnect(); fitTask.dispose(); void session.dispose().finally(stopLogging); });
render();
// First frame is rendered and handlers are wired; only GPU warmup (background)
// and explicit deep-link loads (already async) are still outstanding,
// so bootstrap can reveal without waiting for them.
window.dispatchEvent(new Event('voidplayer:shell-ready'));
