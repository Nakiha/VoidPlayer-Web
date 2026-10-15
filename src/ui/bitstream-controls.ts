import { analysisRetryButton } from './analysis/retry.ts';
import { SLOTS, formatTime } from '../model.ts';
import type { Slot } from '../model.ts';
import type { AnalysisBlock, ReadonlyAnalysisResult, PresentedFrameToken } from '../bitstream-analysis/contract.ts';
import type { ReviewSession } from '../session.ts';
import { t, msg } from '../i18n.ts';
import { failureInfo, canRetryAnalysis } from '../bitstream-analysis/failure.ts';
import { bitstreamReasonText } from './bitstream-reasons.ts';
import { installChoiceMenu } from './choice-menu.ts';
import { installNumericChoice } from './numeric-choice.ts';
import { analysisTrackBadge } from './analysis/card.ts';
import { icon } from './icons.ts';
import { progressRingMarkup } from './progress-ring.ts';
import { installFilterGestures } from './analysis/filter-gestures.ts';
import { installFloatingPanelAvoidance } from './floating-panels.ts';
import './bitstream-controls.css';

type State = ReturnType<ReviewSession['getState']>;
type Mode = 'blocks' | 'qp' | 'modes';
type Entry = {
  sourceId: string;
  overlay?: import('../analysis-overlay/controller.ts').ReturnOverlay;
  loading?: Promise<void>;
  tooltip?: HTMLOutputElement;
  request?: AbortController;
  enabled: boolean;
  requestedKey?: string;
  result?: ReadonlyAnalysisResult;
  resultKey?: string;
  capabilities?: ReadonlyAnalysisResult['capabilities'];
  message?: string;
};
const tokenKey = (token: PresentedFrameToken | null) => token?.picture ? JSON.stringify([token.generation, token.picture]) : null;
const inspectionKey = (token: PresentedFrameToken | null) => tokenKey(token) ?? (token ? `${token.generation}:${token.commit}` : null);
const modeLabel = (mode: Mode) => mode === 'qp' ? t(msg('bitstream.qp','QP 热图')) : mode === 'modes' ? t(msg('bitstream.prediction','预测模式')) : t(msg('bitstream.boundaries','块边界'));
const predictionLabel = (mode: AnalysisBlock['mode']) => mode === 'intra' ? t(msg('bitstream.intra','帧内')) : mode === 'inter' ? t(msg('bitstream.inter','帧间')) : t(msg('bitstream.skip','跳过'));

/** Shared automatic analysis, with viewport-only overlay controls. */
export function installBitstreamControls(session: ReviewSession, canvases: Record<Slot, HTMLCanvasElement>, hooks: {
  selected(): Slot;
}) {
  const host = document.getElementById('bitstream-inspector')!;
  const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
  const panel = $('analysis-overlay-panel'), trigger = $('toggle-analysis-overlay');
  let open = false, initialized = false, mode: Mode = 'blocks', opacity = 75;
  host.innerHTML = `
    <button id="bitstream-grip" class="icon-button viewport-tool-grip" data-floating-grip type="button">${icon('grip')}</button>
    <strong class="bitstream-toolbar-title" data-copy="controls"></strong>
    <div id="bitstream-tracks" class="bitstream-tracks" role="group"></div>
    <span class="bitstream-toolbar-divider" aria-hidden="true"></span>
    <button id="bitstream-mode" class="choice-trigger" type="button"></button>
    <button id="bitstream-opacity" class="choice-trigger" type="button" aria-label="${t(msg('bitstream.opacity','不透明度'))}"></button>
    <button id="bitstream-close" class="icon-button" type="button">${icon('close')}</button>`;
  const copy = () => ({
    controls: t(msg('bitstream.overlayControls','分析遮罩')), opacity: t(msg('bitstream.opacity','不透明度')),
    mode: t(msg('bitstream.overlayMode','显示内容')),
  });
  const entries = new Map<Slot, Entry>();
  let lastState = session.getState();
  const life = new AbortController();
  const opacityChoice = installNumericChoice('bitstream-opacity', { glyph: 'opacity', presets: [10, 25, 50, 75, 100], suffix: '%', min: 10, max: 100,
    editLabel: () => t(msg('bitstream.editOpacity', '编辑不透明度')),
    choose(value) {
      opacity = value;
      for (const slot of entries.keys()) { const canvas = document.getElementById(`bitstream-overlay-${slot}`); if (canvas) canvas.style.opacity = String(opacity / 100); }
      render();
    },
  });
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
  const floating = installFloatingPanelAvoidance(panel, $('annotation-toolbar'), life.signal);
  function setOpen(value: boolean) {
    open = value && lastState.tracks.some(track=>!track.failure);
    panel.hidden = !open; trigger.setAttribute('aria-expanded', String(open));
    if (!open) { opacityChoice.close(); menu.close(); }
    if (open && !initialized) { initialized = true; setVisibility(hooks.selected(), true); }
    render(); floating.update();
  }
  trigger.onclick = () => setOpen(!open);
  $('bitstream-close').onclick = () => { setOpen(false); trigger.focus(); };
  panel.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !(event.target as Element).closest('[popover]:popover-open')) { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.focus(); }
  }, {signal:life.signal});
  function automatic(slot: Slot, entry: Entry) {
    if (!entry.enabled || lastState.busy || lastState.playing || cached(slot,entry)) return;
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
  function cached(slot: Slot, entry: Entry) {
    const token = session.getPresentedFrame(slot);
    return session.cachedBitstreamAnalysis(slot, token ?? undefined);
  }
  async function ensureOverlay(slot: Slot, entry: Entry) {
    if (entry.overlay) return;
    if (!entry.loading) entry.loading = import('../analysis-overlay/controller.ts').then(({ createAnalysisOverlay }) => {
      if (entries.get(slot) !== entry || !entry.enabled || life.signal.aborted) return;
      entry.overlay = createAnalysisOverlay(session, slot, canvases[slot]);
      entry.overlay.setMode(mode);
      const canvas = $(`bitstream-overlay-${slot}`); canvas.style.opacity = String(opacity / 100);
      const result = cached(slot, entry); if (result) entry.overlay.setResult(result);
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
  const choices = () => {
    const capabilities = [...entries.values()].filter(entry=>entry.enabled && entry.capabilities).map(entry=>entry.capabilities!);
    return (['blocks','qp','modes'] as Mode[]).filter(value=>value==='blocks' || capabilities.length>0 && capabilities.every(result=>value==='qp'?result.qp==='ready':result.modes==='ready')).map(value=>({value,label:modeLabel(value)}));
  };
  const menu = installChoiceMenu('bitstream-mode', choices, value => {
    mode = value as Mode;
    for(const entry of entries.values()) entry.overlay?.setMode(mode);
    render();
  });
  function localize() {
    const labels = copy();
    for (const node of host.querySelectorAll<HTMLElement>('[data-copy]')) node.textContent = labels[node.dataset.copy as keyof typeof labels];
    $('bitstream-grip').setAttribute('aria-label', t(msg('shell.dragToolbar','拖动工具条')));
    $('bitstream-grip').setAttribute('data-tooltip', t(msg('shell.dragToolbar','拖动工具条')));
    $('bitstream-close').setAttribute('aria-label', t(msg('bitstream.closeOverlay', '关闭分析遮罩')));
    trigger.setAttribute('aria-label', t(msg('bitstream.overlayControls','分析遮罩')));
    $('bitstream-tracks').setAttribute('aria-label', t(msg('analysis.compareTracks','对比轨道')));
    $('bitstream-mode').setAttribute('aria-label', labels.mode);
    $('bitstream-opacity').setAttribute('aria-label', labels.opacity);
    render();
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
      const result=cached(slot,entry);
      if(result?.confidence==='exact') entry.capabilities=result.capabilities;
      if(result && entry.enabled) entry.overlay?.setResult(result);
    }
    if (!open) return;
    const tracks = $('bitstream-tracks');
    const signature = state.tracks.filter(track=>!track.failure).map(track=>`${track.slot}:${track.id}:${track.sourceGen}`).join(',');
    if (tracks.dataset.tracks !== signature) {
      tracks.dataset.tracks = signature;
      tracks.replaceChildren(...state.tracks.filter(track=>!track.failure).map(track=>{
        const wrapper=document.createElement('span'); wrapper.className='bitstream-track-item';
        const button=document.createElement('button'); button.type='button'; button.dataset.slot=track.slot; button.className='bitstream-track-control';
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
        retry.button.id = `bitstream-retry-${track.slot}`; retryButtons.set(track.slot, retry);
        wrapper.append(button, retry.button); return wrapper;
      }));
    }
    for(const button of tracks.querySelectorAll<HTMLButtonElement>('.bitstream-track-control')) {
      const slot=button.dataset.slot as Slot, entry=entryFor(slot)!, track=state.tracks.find(track=>track.slot===slot)!;
      retryButtons.get(slot)?.update(session.getBitstreamAnalysisState(slot), state.playing || state.busy);
      const analysis=session.getBitstreamAnalysisState(slot), stream=analysis.stream, pending=analysis.state==='pending' || !!entry.request;
      const percent=!entry.request && !analysis.queued && stream && stream.totalUs>0 ? Math.min(100,Math.floor(stream.checkedUs/stream.totalUs*100)):0;
      const status=pending ? t(msg('analysis.streamProgress','{slot} {percent}% · {count} 帧'),{slot,percent,count:stream?.pictures ?? 0}) : entry.message ?? (analysis.reason ? bitstreamReasonText(analysis.reason.code) : '');
      button.setAttribute('aria-pressed',String(entry.enabled)); button.dataset.state=pending?'pending':analysis.state;
      const label=t(entry.enabled ? msg('bitstream.hideTrackOverlay','隐藏轨道 {slot} 的遮罩') : msg('bitstream.showTrackOverlay','显示轨道 {slot} 的遮罩'),{slot});
      button.setAttribute('aria-label',label); button.title=`${label} · ${track.name}${status?' · '+status:''}\n${t(msg('analysis.trackSoloHint', '右键或长按单选此轨道，再次操作恢复全部。'))}`; button.setAttribute('aria-description',status);
      const progress=button.querySelector<HTMLElement>('.bitstream-track-progress')!;
      progress.setAttribute('aria-label',t(msg('bitstream.analysisProgress','分析进度')));progress.setAttribute('aria-valuenow',String(percent));progress.setAttribute('aria-hidden',String(!pending));
      progress.style.setProperty('--inspection-progress',String(100-percent));progress.classList.toggle('is-waiting',percent===0);
    }
    const available=choices();
    if([...entries.values()].some(entry=>entry.enabled && entry.capabilities) && !available.some(option=>option.value===mode)) {mode='blocks';for(const entry of entries.values())entry.overlay?.setMode(mode);}
    menu.setOptions(choices); menu.sync(mode,modeLabel(mode),available.length>1);
    opacityChoice.sync(String(opacity), `${+opacity.toFixed(1)}%`, entries.size > 0);
  }
  async function run(slot: Slot) {
    const entry = entryFor(slot); if (!entry) return;
    if (cached(slot, entry)?.confidence === 'exact' && !canRetryAnalysis(session.getBitstreamAnalysisState(slot))) { setVisibility(slot, true); return; }
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
      entry.tooltip.hidden=!block; if(!block)return;
      const token=session.getPresentedFrame(slot);
      entry.tooltip.textContent=`${slot} · ${formatTime(token?.normalizedMediaUs ?? 0)} · PTS\n${block.x}, ${block.y} · ${block.width}×${block.height} · ${predictionLabel(block.mode)} · QP ${block.qp ?? '—'}`;
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
    dispose() { offFrames(); floating.dispose(); life.abort(); menu.dispose(); opacityChoice.dispose(); for (const slot of SLOTS) destroy(slot); },
  };
}
