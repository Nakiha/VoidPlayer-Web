import { analysisRetryButton } from './analysis/retry.ts';
import { SLOTS, formatTime } from '../../shared/review/model.ts';
import type { Slot } from '../../shared/review/model.ts';
import type { ReadonlyAnalysisResult, PresentedFrameToken } from '../../shared/analysis/bitstream/contract.ts';
import type { ReviewSession } from '../session.ts';
import { t, msg } from '../i18n.ts';
import { failureInfo, canRetryAnalysis } from '../../shared/analysis/bitstream/failure.ts';
import { bitstreamReasonText } from './bitstream-reasons.ts';
import { installNumericChoice } from './numeric-choice.ts';
import { analysisTrackBadge } from './analysis/card.ts';
import { icon } from './icons.ts';
import { progressRingMarkup } from './progress-ring.ts';
import { installFilterGestures } from './analysis/filter-gestures.ts';
import { installFloatingPanelAvoidance } from './floating-panels.ts';
import { depthLabel, installFrameInspector, predictionLabel } from './analysis/picture-overlay/frame-inspector.ts';
import { bitBandColors, blockColor } from './analysis/picture-overlay/block-display.ts';
import type { BlockFilter, Dimension, FillMode } from './analysis/picture-overlay/block-display.ts';
import './bitstream-controls.css';

type State = ReturnType<ReviewSession['getState']>;
const modes = ['sizes', 'modes', 'qp', 'depth', 'bits'] as const;
const modeIcons = { sizes: 'analysisOverlay', modes: 'shareNetwork', qp: 'gauge', depth: 'stack', bits: 'storage' } as const;
type Entry = {
  sourceId: string;
  overlay?: import('./analysis/picture-overlay/controller.ts').ReturnOverlay;
  loading?: Promise<void>;
  tooltip?: HTMLOutputElement;
  request?: AbortController;
  enabled: boolean;
  requestedKey?: string;
  result?: ReadonlyAnalysisResult;
  resultKey?: string;
  capabilities?: ReadonlyAnalysisResult['capabilities'];
  blockDepth?: ReadonlyAnalysisResult['blockDepth'];
  message?: string;
};
const tokenKey = (token: PresentedFrameToken | null) => token?.picture ? JSON.stringify([token.generation, token.picture]) : null;
const inspectionKey = (token: PresentedFrameToken | null) => tokenKey(token) ?? (token ? `${token.generation}:${token.commit}` : null);
/** Shared automatic analysis, with viewport-only overlay controls. */
export function installBitstreamControls(session: ReviewSession, canvases: Record<Slot, HTMLCanvasElement>, hooks: {
  selected(): Slot;
}) {
  const host = document.getElementById('bitstream-inspector')!;
  const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
  const panel = $('analysis-overlay-panel'), trigger = $('toggle-analysis-overlay');
  let open = false, initialized = false, mode: Dimension = 'sizes', sizeFill = false, boundaries = true, labels = false, opacity = 75;
  let filter: BlockFilter | null = null;
  const fill = (): FillMode => mode === 'sizes' && !sizeFill ? 'none' : mode;
  host.innerHTML = `
    <div class="viewport-tool-head">
      <button id="bitstream-grip" class="icon-button viewport-tool-grip" data-floating-grip type="button">${icon('grip')}</button>
      <div id="bitstream-tracks" class="viewport-tool-tracks" role="group"></div>
      <button id="bitstream-close" class="icon-button viewport-tool-close" type="button">${icon('close')}</button>
    </div>
    <div id="bitstream-retries"></div>
    <div id="bitstream-mode" role="group">${modes.map(value =>
      `<button type="button" data-mode="${value}" aria-pressed="false">${icon(modeIcons[value])}<span></span></button>`).join('')}</div>
    <button id="bitstream-show-display" type="button" class="bitstream-fold" aria-controls="bitstream-display" aria-expanded="true">
      <span></span>${icon('down')}</button>
    <div id="bitstream-display">
      <label id="bitstream-size-style"><input id="bitstream-size-fill" type="checkbox"><span></span></label>
      <div id="bitstream-prediction-key" class="bitstream-legend" hidden></div>
      <div id="bitstream-qp-key" class="bitstream-legend" hidden><span></span><i></i><span></span></div>
      <div id="bitstream-bits-key" class="bitstream-legend" hidden><span></span><i></i><span></span></div>
      <div class="bitstream-layer-buttons">
        <button id="bitstream-boundaries" type="button" aria-pressed="true">${icon('analysisOverlay')}<span></span></button>
        <button id="bitstream-labels" type="button" aria-pressed="false">${icon('text')}<span></span></button>
      </div>
      <div class="bitstream-field"><span id="bitstream-opacity-label"></span>
        <button id="bitstream-opacity" class="choice-trigger" type="button"></button></div>
    </div>
    <button id="bitstream-inspect-frame" type="button" class="bitstream-fold" aria-controls="bitstream-frame-inspector" aria-expanded="false">
      <span></span>${icon('down')}</button>
    <div id="bitstream-frame-inspector" hidden></div>`;
  const entries = new Map<Slot, Entry>();
  let lastState = session.getState();
  const life = new AbortController();
  const opacityChoice = installNumericChoice('bitstream-opacity', { glyph: 'opacity', presets: [0, 10, 25, 50, 75, 100], suffix: '%', min: 0, max: 100,
    editLabel: () => t(msg('bitstream.editOpacity', '编辑不透明度')),
    choose(value) {
      opacity = value;
      for (const slot of entries.keys()) { const canvas = document.getElementById(`bitstream-overlay-${slot}`); if (canvas) canvas.style.opacity = String(opacity / 100); }
      render();
    },
  });
  const inspector = installFrameInspector($('bitstream-frame-inspector'), () => render(), value => {
    filter = value; updateDisplay();
  });
  const modeButtons = [...$('bitstream-mode').querySelectorAll<HTMLButtonElement>('button')];
  const sizeStyle = $<HTMLInputElement>('bitstream-size-fill');
  const displayToggle = $('bitstream-show-display'), frameToggle = $('bitstream-inspect-frame');
  const sections = new Map(modes.map(key => [key, { display: true, frame: false }]));
  function showSections() {
    const { display, frame } = sections.get(mode)!;
    displayToggle.setAttribute('aria-expanded', String(display));
    frameToggle.setAttribute('aria-expanded', String(frame));
    $('bitstream-display').hidden = !display;
    inspector.setVisible(open && frame);
    $('bitstream-size-style').hidden = mode !== 'sizes';
    $('bitstream-prediction-key').hidden = mode !== 'modes';
    $('bitstream-qp-key').hidden = mode !== 'qp';
    $('bitstream-bits-key').hidden = mode !== 'bits';
    frameToggle.querySelector('span')!.textContent = t(msg('bitstream.frameDistribution', '当前帧 · {metric}分布'), {
      metric: mode === 'sizes' ? t(msg('bitstream.blockSize', '块尺寸')) : mode === 'qp' ? 'QP' : modeTitle(mode),
    });
  }
  function selectMode(next: Dimension) {
    if (mode === next) return;
    opacityChoice.close();
    mode = next;
    inspector.setDimension(next);
    showSections(); updateDisplay();
  }
  for (const button of modeButtons) button.onclick = () => { selectMode(button.dataset.mode as Dimension); render(); };
  displayToggle.onclick = () => {
    opacityChoice.close();
    const current = sections.get(mode)!; current.display = !current.display;
    showSections(); render();
  };
  frameToggle.onclick = () => {
    const current = sections.get(mode)!; current.frame = !current.frame;
    showSections(); render();
  };
  sizeStyle.onchange = () => { sizeFill = sizeStyle.checked; updateDisplay(); };
  const retryButtons = new Map<Slot, ReturnType<typeof analysisRetryButton>>();
  installFilterGestures($('bitstream-tracks'), life.signal, (button, solo) => {
    const slot = button.dataset.slot as Slot;
    const tracks = lastState.tracks.filter(track => !track.failure);
    if (!tracks.some(track => track.slot === slot)) return;
    if (solo) {
      const restoreAll = tracks.every(track => !!entryFor(track.slot)?.enabled === (track.slot === slot));
      for (const track of tracks) setVisibility(track.slot, restoreAll || track.slot === slot);
    } else setVisibility(slot, !entryFor(slot)?.enabled);
  }, '.bitstream-track-control');
  const floating = installFloatingPanelAvoidance(panel, host, $('annotation-toolbar'), life.signal);
  function setOpen(value: boolean) {
    const wasOpen = open;
    open = value && lastState.tracks.some(track=>!track.failure);
    panel.hidden = !open; trigger.setAttribute('aria-expanded', String(open));
    if (!open) { opacityChoice.close(); inspector.clearFilter(); }
    showSections();
    if (open && !initialized) { initialized = true; setVisibility(hooks.selected(), true); }
    render();
    if (open && !wasOpen) floating.place();
    else floating.update();
  }
  trigger.onclick = () => setOpen(!open);
  $('bitstream-close').onclick = () => { setOpen(false); trigger.focus(); };
  panel.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || event.defaultPrevented || (event.target as Element).closest('[popover]')) return;
    event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.focus();
  }, {signal:life.signal});
  function automatic(slot: Slot, entry: Entry) {
    if (!entry.enabled || lastState.busy || lastState.playing || cached(slot)) return;
    const state = session.getBitstreamAnalysisState(slot);
    if ((state.state === 'pending' && state.stream?.product !== 'summary') || state.state === 'paused' || state.state === 'unsupported' || entry.request) return;
    // The picture provider plans bounded preroll from a verified closed anchor.
    // Opening an overlay must never turn a paused-frame inspection into a full scan.
    const key = inspectionKey(session.getPresentedFrame(slot));
    if (key && key !== entry.requestedKey) {
      entry.requestedKey = key;
      queueMicrotask(() => {
        if (!entry.enabled || entries.get(slot) !== entry) return;
        if (lastState.busy || lastState.playing || inspectionKey(session.getPresentedFrame(slot)) !== key ||
            (session.getBitstreamAnalysisState(slot).state === 'pending' && session.getBitstreamAnalysisState(slot).stream?.product !== 'summary')) {
          if (entry.requestedKey === key) entry.requestedKey = undefined;
          return;
        }
        void run(slot);
      });
    }
  }

  function entryFor(slot: Slot): Entry | undefined {
    const track = lastState.tracks.find(track => track.slot === slot);
    if (!track) return undefined;
    let entry = entries.get(slot);
    if (!entry || entry.sourceId !== `${track.id}:${track.sourceGen}`) {
      destroy(slot);
      entry = { sourceId: `${track.id}:${track.sourceGen}`, enabled: false };
      entries.set(slot, entry);
    }
    return entry;
  }
  function destroy(slot: Slot) {
    const entry = entries.get(slot);
    entry?.request?.abort(); entry?.overlay?.dispose(); entry?.tooltip?.remove(); entries.delete(slot);
  }
  function cached(slot: Slot) {
    const token = session.getPresentedFrame(slot);
    return session.cachedBitstreamAnalysis(slot, token ?? undefined);
  }
  async function ensureOverlay(slot: Slot, entry: Entry) {
    if (entry.overlay) return;
    if (!entry.loading) entry.loading = import('./analysis/picture-overlay/controller.ts').then(({ createAnalysisOverlay }) => {
      if (entries.get(slot) !== entry || !entry.enabled || life.signal.aborted) return;
      entry.overlay = createAnalysisOverlay(session, slot, canvases[slot]);
      entry.overlay.setDisplay({ fill: fill(), boundaries, labels, filter: filter?.slot === slot ? filter : null });
      const canvas = $(`bitstream-overlay-${slot}`); canvas.style.opacity = String(opacity / 100);
      const result = cached(slot); if (result) entry.overlay.setResult(result);
      const tooltip = document.createElement('output'); tooltip.className = 'bitstream-hit-tooltip'; tooltip.hidden = true;
      panel.closest('.viewport-surface')!.append(tooltip); entry.tooltip = tooltip;
    }).finally(() => { entry.loading = undefined; });
    await entry.loading;
  }
  function setVisibility(slot: Slot, enabled: boolean) {
    const entry = entryFor(slot); if (!entry) return;
    entry.enabled = enabled;
    if (enabled) void ensureOverlay(slot, entry).catch(error => { entry.message = bitstreamReasonText(failureInfo(error).code); render(); });
    else { entry.overlay?.dispose(); entry.overlay = undefined; entry.tooltip?.remove(); entry.tooltip = undefined; }
    render();
  }
  function supports(entry: Entry, value: Dimension) {
    if (value === 'depth') return !!entry.blockDepth;
    const key = value === 'sizes' ? 'blocks' : value;
    return entry.capabilities?.[key] === 'ready';
  }
  function updateDisplay() {
    for (const [slot, entry] of entries) entry.overlay?.setDisplay({ fill: fill(), boundaries, labels, filter: filter?.slot === slot ? filter : null });
  }
  $('bitstream-labels').addEventListener('click', () => {
    labels = !labels;
    updateDisplay(); render();
  }, { signal: life.signal });
  $('bitstream-boundaries').addEventListener('click', () => {
    boundaries = !boundaries;
    updateDisplay(); render();
  }, { signal: life.signal });
  function modeTitle(key: Dimension) {
    if (key === 'sizes') return t(msg('bitstream.partitions', '块划分'));
    if (key === 'modes') return t(msg('bitstream.predictionTypes', '预测类型'));
    if (key === 'qp') return t(msg('bitstream.qp', 'QP 热图'));
    if (key === 'bits') return t(msg('bitstream.codedSize', '编码大小'));
    return depthLabel();
  }
  function localize() {
    const opacityLabel = t(msg('bitstream.opacity','不透明度')), edges = t(msg('bitstream.boundaries','块边界'));
    $('bitstream-grip').setAttribute('aria-label', t(msg('shell.dragToolbar','拖动工具条')));
    $('bitstream-grip').setAttribute('data-tooltip', t(msg('shell.dragToolbar','拖动工具条')));
    $('bitstream-close').setAttribute('aria-label', t(msg('bitstream.closeOverlay', '关闭分析遮罩')));
    trigger.setAttribute('aria-label', t(msg('bitstream.overlayControls','分析遮罩')));
    $('bitstream-tracks').setAttribute('aria-label', t(msg('analysis.compareTracks','对比轨道')));
    $('bitstream-mode').setAttribute('aria-label', t(msg('bitstream.analysisMode', '分析模式')));
    for (const button of modeButtons) button.querySelector('span')!.textContent = modeTitle(button.dataset.mode as Dimension);
    displayToggle.querySelector('span')!.textContent = t(msg('bitstream.displayTab', '画面显示'));
    $('bitstream-size-style').querySelector('span')!.textContent = t(msg('bitstream.sizeFill', '按块尺寸填色'));
    $('bitstream-prediction-key').replaceChildren(...(['intra','inter','skip'] as const).map(key => {
      const item = document.createElement('span'), dot = document.createElement('i');
      dot.style.backgroundColor = blockColor('modes', key, 'h264'); item.append(dot, predictionLabel(key)); return item;
    }));
    const qpEnds = $('bitstream-qp-key').querySelectorAll('span');
    qpEnds[0].textContent = t(msg('bitstream.lowQp', '低 QP')); qpEnds[1].textContent = t(msg('bitstream.highQp', '高 QP'));
    const bitsKey = $('bitstream-bits-key'), bitsEnds = bitsKey.querySelectorAll('span');
    bitsKey.title = t(msg('bitstream.codedSizeHint', '解码时估算的块码量，共用语法开销不计入单块'));
    bitsEnds[0].textContent = '0 bit';
    bitsEnds[1].textContent = '≥ 4 KiB';
    bitsKey.querySelector('i')!.style.background = `linear-gradient(to right,${bitBandColors.join(',')})`;
    const bitsButton = modeButtons.find(button => button.dataset.mode === 'bits')!;
    bitsButton.title = bitsKey.title;
    $('bitstream-opacity-label').textContent = opacityLabel;
    $('bitstream-opacity').setAttribute('aria-label', opacityLabel);
    $('bitstream-boundaries').querySelector('span')!.textContent = edges;
    $('bitstream-boundaries').setAttribute('aria-label', edges);
    $('bitstream-labels').querySelector('span')!.textContent = t(msg('bitstream.blockLabels', '块内文字'));
    inspector.localize();
    showSections();
    updateDisplay(); render();
  }
  function render(state: State = lastState) {
    lastState = state;
    for (const slot of SLOTS) {
      const track = state.tracks.find(track => track.slot === slot);
      if (!track || entries.get(slot)?.sourceId !== `${track.id}:${track.sourceGen}`) destroy(slot);
    }
    trigger.toggleAttribute('disabled', !state.tracks.some(track=>!track.failure));
    if (!state.tracks.length) { initialized=false; if(open) setOpen(false); }
    for(const [slot,entry] of entries) {
      automatic(slot,entry);
      const result=cached(slot);
      if (result?.confidence === 'exact') { entry.capabilities = result.capabilities; entry.blockDepth = result.blockDepth; }
      if(result && entry.enabled) entry.overlay?.setResult(result);
    }
    if (!open) return;
    const tracks = $('bitstream-tracks');
    const signature = state.tracks.filter(track=>!track.failure).map(track=>`${track.slot}:${track.id}:${track.sourceGen}`).join(',');
    if (tracks.dataset.tracks !== signature) {
      tracks.dataset.tracks = signature;
      $('bitstream-retries').replaceChildren(); retryButtons.clear();
      tracks.replaceChildren(...state.tracks.filter(track=>!track.failure).map(track=>{
        const button=document.createElement('button'); button.type='button'; button.dataset.slot=track.slot; button.className='viewport-tool-track bitstream-track-control';
        button.append(analysisTrackBadge(track.slot));
        const progress=document.createElement('span'); progress.className='bitstream-track-progress'; progress.setAttribute('role','progressbar'); progress.setAttribute('aria-valuemin','0'); progress.setAttribute('aria-valuemax','100');
        progress.innerHTML=progressRingMarkup;
        button.append(progress);
        const retry = analysisRetryButton(track.slot, async () => {
          const entry = entryFor(track.slot); if (!entry) return;
          entry.requestedKey = undefined; entry.message = undefined; entry.enabled = true;
          await ensureOverlay(track.slot, entry);
          await run(track.slot);
        });
        retry.button.id = `bitstream-retry-${track.slot}`;
        retry.button.append(document.createElement('span'));
        retryButtons.set(track.slot, retry);
        $('bitstream-retries').append(retry.button); return button;
      }));
    }
    for(const button of tracks.querySelectorAll<HTMLButtonElement>('.bitstream-track-control')) {
      const slot=button.dataset.slot as Slot, entry=entryFor(slot)!, track=state.tracks.find(track=>track.slot===slot)!;
      const retry = retryButtons.get(slot)!;
      retry.update(session.getBitstreamAnalysisState(slot), state.playing || state.busy);
      if (!retry.button.hidden) {
        const text = retry.button.getAttribute('aria-label')!, caption = retry.button.lastElementChild!;
        if (caption.textContent !== text) caption.textContent = text;
      }
      const analysis=session.getBitstreamAnalysisState(slot), stream=analysis.stream, pending=analysis.state==='pending' || !!entry.request;
      const percent=!entry.request && !analysis.queued && stream && stream.totalUs>0 ? Math.min(100,Math.floor(stream.checkedUs/stream.totalUs*100)):0;
      const status=pending ? t(msg('analysis.streamProgress','{slot} {percent}% · {count} 帧'),{slot,percent,count:stream?.pictures ?? 0}) : entry.message ?? (analysis.reason ? bitstreamReasonText(analysis.reason.code) : '');
      button.setAttribute('aria-pressed',String(entry.enabled)); button.dataset.state=pending?'pending':analysis.state;
      const label=t(entry.enabled ? msg('bitstream.hideTrackOverlay','隐藏轨道 {slot} 的遮罩') : msg('bitstream.showTrackOverlay','显示轨道 {slot} 的遮罩'),{slot});
      button.setAttribute('aria-label',label); button.title=`${label} · ${track.name}${status?' · '+status:''}\n${t(msg('analysis.trackSoloHint', '右键或长按单选此轨道，再次操作恢复全部'))}`; button.setAttribute('aria-description',status);
      const progress=button.querySelector<HTMLElement>('.bitstream-track-progress')!;
      progress.setAttribute('aria-label',t(msg('bitstream.analysisProgress','分析进度')));progress.setAttribute('aria-valuenow',String(percent));progress.setAttribute('aria-hidden',String(!pending));
      progress.style.setProperty('--inspection-progress',String(100-percent));progress.classList.toggle('is-waiting',percent===0);
    }
    const active = [...entries.values()].filter(entry => entry.enabled && entry.capabilities);
    if (active.length && !active.some(entry => supports(entry, mode))) selectMode('sizes');
    for (const button of modeButtons) {
      const key = button.dataset.mode as Dimension;
      button.disabled = key !== 'sizes' && !active.some(entry => supports(entry, key));
      button.setAttribute('aria-pressed', String(key === mode));
      if (key === 'depth') {
        const kinds = new Set(active.map(entry => entry.blockDepth).filter(Boolean));
        const caption = button.querySelector('span')!, text = depthLabel(kinds.size === 1 ? [...kinds][0] : undefined);
        if (caption.textContent !== text) caption.textContent = text;
      }
    }
    $('bitstream-boundaries').setAttribute('aria-pressed', String(boundaries));
    $('bitstream-labels').setAttribute('aria-pressed', String(labels));
    $('bitstream-labels').toggleAttribute('disabled', entries.size === 0);
    inspector.render(SLOTS.filter(slot => entries.get(slot)?.enabled), hooks.selected(), state.playing || state.busy,
      slot => cached(slot), slot => {
        const reason = session.getBitstreamAnalysisState(slot).reason;
        return entries.get(slot)?.message ?? (reason ? bitstreamReasonText(reason.code) : '');
      });
    opacityChoice.sync(String(opacity), `${+opacity.toFixed(1)}%`, entries.size > 0);
  }
  async function run(slot: Slot) {
    const entry = entryFor(slot); if (!entry) return;
    if (cached(slot)?.confidence === 'exact' && !canRetryAnalysis(session.getBitstreamAnalysisState(slot))) { setVisibility(slot, true); return; }
    if (entry.request) return;
    const requested = session.getPresentedFrame(slot), controller = new AbortController();
    entry.requestedKey = inspectionKey(requested) ?? undefined;
    entry.request = controller; entry.message = undefined;
    render();
    try {
      entry.enabled = true;
      await ensureOverlay(slot, entry);
      controller.signal.throwIfAborted();
      const current = session.getPresentedFrame(slot);
      if (!requested || current?.commit !== requested.commit || current.generation !== requested.generation) {
        return;
      }
      const result = await session.requestBitstreamAnalysis(slot, controller.signal);
      controller.signal.throwIfAborted();
      entry.result = result; entry.resultKey = tokenKey(requested) ?? undefined;
      if (tokenKey(session.getPresentedFrame(slot)) === entry.resultKey) entry.overlay?.setResult(result);
    } catch (error) {
      if (entries.get(slot) === entry) entry.message = bitstreamReasonText(controller.signal.aborted ? 'cancelled' : failureInfo(error).code);
    } finally {
      if (entry.request === controller) entry.request = undefined;
      render();
    }
  }
  for (const slot of SLOTS) {
    const stage = canvases[slot].closest<HTMLElement>('.frame-stage')!;
    stage.addEventListener('pointermove', event => {
      const entry=entries.get(slot); if(!entry?.tooltip)return;
      const rect=stage.getBoundingClientRect();
      const block=entry.enabled && stage.querySelector('.drawing-layer')?.hasAttribute('hidden') && !(event.target as Element).closest('button,input,select') ? entry.overlay?.hit(event.clientX-rect.left,event.clientY-rect.top):null;
      if (entry.tooltip.hidden !== !block) entry.tooltip.hidden = !block;
      if (!block) return;
      const token=session.getPresentedFrame(slot);
      const text = `${slot} · ${formatTime(token?.normalizedMediaUs ?? 0)} · PTS\n${block.x}, ${block.y} · ${block.width}×${block.height} · ${predictionLabel(block.mode)} · QP ${block.qp ?? '—'}`;
      const depth = block.depth === undefined ? '' : ` · ${depthLabel(entry.blockDepth)} ${block.depth}`;
      const bits = block.bits === undefined ? '' :
        `\n${t(msg('bitstream.estimatedCodedSize', '估算编码大小'))} · ${block.bits} bit · ${block.bits / 8} B · ${(block.bits / 8192).toFixed(4)} KiB`;
      const value = text + depth + bits;
      if (entry.tooltip.textContent !== value) entry.tooltip.textContent = value;
      const viewport=panel.closest('.viewport-surface')!.getBoundingClientRect(), tip=entry.tooltip.getBoundingClientRect();
      let x=event.clientX-viewport.left+12, y=event.clientY-viewport.top+12;
      if(x+tip.width>viewport.width-8)x=event.clientX-viewport.left-tip.width-12;
      if(y+tip.height>viewport.height-8)y=event.clientY-viewport.top-tip.height-12;
      entry.tooltip.style.left=`${Math.max(8,Math.min(x,viewport.width-tip.width-8))}px`;
      entry.tooltip.style.top=`${Math.max(8,Math.min(y,viewport.height-tip.height-8))}px`;
    }, {signal:life.signal});
    stage.addEventListener('pointerleave',()=>{const entry=entries.get(slot);if(entry?.tooltip)entry.tooltip.hidden=true;},{signal:life.signal});
  }
  const offFrames=session.subscribePresentedFrames(slot=>{
    const entry=entries.get(slot);if(!entry)return;
    entry.message=undefined;if(entry.tooltip)entry.tooltip.hidden=true;
    render();
  });
  localize();
  return {
    render, localize, setOpen,
    dispose() { offFrames(); floating.dispose(); life.abort(); opacityChoice.dispose(); for (const slot of SLOTS) destroy(slot); },
  };
}
