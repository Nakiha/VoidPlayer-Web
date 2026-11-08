import { buildInfo } from '../build-info.ts';
import { formatNumber, msg, t } from '../i18n.ts';
import type { ReviewSession } from '../session.ts';
import type { Slot } from '../../shared/review/model.ts';
import type { Viewport, WheelBehavior } from '../../shared/presentation/viewport.ts';
import { localizedText } from './live-localization.ts';
import { presentationRendererName } from '../presentation/presenter.ts';
import { presentationRect, type PresentationGeometry } from '../presentation/presentation-surface.ts';

type Bounds = { left: number; top: number; width: number; height: number };
type Row = { at: number; type: string } & Record<string, unknown>;
const stopAfterMs = 60_000, rowLimit = 32_768;

function percentiles(values: number[]) {
  if (!values.length) return null;
  values.sort((a, b) => a - b);
  const at = (p: number) => values[Math.ceil(values.length * p) - 1];
  return { count: values.length, p50: at(.5), p95: at(.95), p99: at(.99), max: at(1) };
}

/** One explicitly started, memory-only trace. Times are milliseconds relative to start. */
export function installViewportTrace(session: ReviewSession, viewport: Viewport, wheelBehavior: () => WheelBehavior, closeSettings: () => void, lifetime: AbortSignal) {
  const start = document.querySelector<HTMLButtonElement>('#viewport-trace-start')!;
  const stop = document.querySelector<HTMLButtonElement>('#viewport-trace-stop')!;
  const download = document.querySelector<HTMLButtonElement>('#viewport-trace-download')!;
  const status = document.getElementById('viewport-trace-status')!;
  const interval = document.getElementById('viewport-trace-interval')!;
  let active = false, started = 0, startedAt = '', durationMs = 0, endReason = '';
  let rows: Row[] = [], frames: number[] = [], activeFrames: number[] = [], inputCount = 0;
  let raf = 0, timer = 0, previousFrame: number | undefined, lastInput = -Infinity, firstPending: number | undefined, lastPending: number | undefined;
  let context: ReturnType<typeof snapshot> | undefined, endContext: ReturnType<typeof snapshot> | undefined;
  let longFrames: PerformanceObserver | undefined;
  const stages = new Map<Slot, DOMRect>(), images = new Map<Slot, Bounds>();
  function snapshot() {
    const state = session.getState();
    return { buildId: buildInfo?.buildId, browser: navigator.userAgent, dpr: devicePixelRatio, width: innerWidth, height: innerHeight,
      standalone: matchMedia('(display-mode: standalone)').matches, viewport: viewport.snapshot(), wheelBehavior: wheelBehavior(), playing: state.playing,
      tracks: state.tracks.map(({ slot, width, height, visible, decoder }) => {
        const canvas = document.querySelector<HTMLCanvasElement>(`#canvas-${slot}`);
        return { slot, width, height, visible, decoder, colorExecutor: canvas?.dataset.colorExecutor,
          renderer: canvas ? presentationRendererName(canvas) : null,
          pictureOverlay: !!document.querySelector(`#bitstream-overlay-${slot}:not([hidden])`) };
      }) };
  }
  function row(type: string, data: Record<string, unknown>) {
    if (!active) return;
    if (rows.length >= rowLimit) { finish('capacity'); return; }
    rows.push({ type, at: performance.now() - started, ...data });
  }
  function measureBounds() {
    if (!active) return;
    stages.clear(); images.clear();
    for (const { slot, visible } of session.getViewportTracks()) {
      if (!visible) continue;
      const stage = document.getElementById(`stage-${slot}`)!.getBoundingClientRect();
      if (!stage.width || !stage.height) continue;
      stages.set(slot, stage);
      images.set(slot, document.getElementById(`image-${slot}`)!.getBoundingClientRect());
      row('stage', { slot, left: stage.left, top: stage.top, width: stage.width, height: stage.height, dpr: devicePixelRatio });
    }
  }
  function frame(timestamp: number) {
    if (!active) return;
    const now = timestamp - started;
    if (previousFrame !== undefined) {
      const interval = now - previousFrame;
      const nearInput = lastInput >= previousFrame - 120;
      frames.push(interval);
      if (nearInput) activeFrames.push(interval);
      row('raf', { frameAt: now, interval, nearInput });
    }
    previousFrame = now;
    if (active) raf = requestAnimationFrame(frame);
  }
  function finish(reason: string) {
    if (!active) return;
    active = false; endReason = reason; durationMs = performance.now() - started;
    clearTimeout(timer); cancelAnimationFrame(raf);
    longFrames?.disconnect(); longFrames = undefined;
    endContext = snapshot();
    const sample = percentiles(activeFrames);
    interval.hidden = !sample;
    if (sample) localizedText(interval, () => t(msg('viewportTrace.interval', '手势期间帧间隔 P95：{ms} ms'), { ms: formatNumber(sample.p95, { maximumFractionDigits: 1 }) }));
    start.hidden = false; stop.hidden = true; download.hidden = download.disabled = false;
    localizedText(status, () => t(msg('viewportTrace.finished', '已录制 {seconds} 秒，{count} 次视口输入'), { seconds: Math.round(durationMs / 1000), count: inputCount }));
  }
  start.onclick = () => {
    if (active) return;
    context = snapshot(); rows = []; frames = []; activeFrames = []; inputCount = 0;
    previousFrame = firstPending = lastPending = undefined; lastInput = -Infinity;
    startedAt = new Date().toISOString(); started = performance.now(); active = true;
    interval.hidden = true;
    start.hidden = true; stop.hidden = false; download.hidden = download.disabled = true;
    localizedText(status, () => t(msg('viewportTrace.recording', '录制中，最长 60 秒')));
    measureBounds();
    if (typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes.includes('long-animation-frame')) {
      longFrames = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) {
          const e = entry as PerformanceEntry & { blockingDuration: number; renderStart: number; styleAndLayoutStart: number };
          row('long-frame', { begin: e.startTime - started, durationMs: e.duration, blockingMs: e.blockingDuration,
            renderStart: e.renderStart ? e.renderStart - started : null, styleStart: e.styleAndLayoutStart ? e.styleAndLayoutStart - started : null });
        }
      });
      longFrames.observe({ type: 'long-animation-frame' });
    }
    raf = requestAnimationFrame(frame); timer = window.setTimeout(() => finish('timeout'), stopAfterMs);
    closeSettings();
  };
  stop.onclick = () => finish('manual');
  download.onclick = () => {
    if (active || !context) return;
    const inputs = new Map(rows.filter(r => r.type === 'input').map(r => [r.id, r]));
    const commits = rows.filter(r => r.type === 'commit');
    const dispatchDelays = Array.from(inputs.values(), r => r.at - Number(r.eventAt)).filter(n => n >= 0 && n <= durationMs);
    const inputToCommit = commits.flatMap(r => {
      const last = inputs.get(r.lastInput);
      return last && r.at >= Number(last.eventAt) ? [r.at - Number(last.eventAt)] : [];
    });
    const report = { schema: 'voidplayer-viewport-trace', version: 1, startedAt, durationMs, endReason, context, endContext,
      summary: { inputs: inputCount, rafIntervalMs: percentiles(frames), gestureRafIntervalMs: percentiles(activeFrames),
        inputDispatchDelayMs: percentiles(dispatchDelays), latestInputToCommitEndMs: percentiles(inputToCommit),
        commitWorkMs: percentiles(commits.map(r => Number(r.durationMs))) }, rows };
    const url = URL.createObjectURL(new Blob([JSON.stringify(report)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `voidplayer-viewport-${startedAt.replace(/[:.]/g, '-')}.json`;
    document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };
  window.addEventListener('resize', measureBounds, { signal: lifetime });
  window.addEventListener('scroll', measureBounds, { capture: true, signal: lifetime });
  document.addEventListener('visibilitychange', () => { if (document.hidden) finish('hidden'); }, { signal: lifetime });
  window.addEventListener('pagehide', () => finish('pagehide'), { signal: lifetime });
  lifetime.addEventListener('abort', () => finish('disposed'), { once: true });
  return {
    get active() { return active; },
    input(kind: string, event: Event & { clientX?: number; clientY?: number; scale?: number }, decision: 'apply' | 'filtered' | 'unchanged' | 'boundary', slot?: Slot) {
      if (!active) return;
      slot ??= (event.target as Element | null)?.closest<HTMLElement>('.video-card')?.dataset.slot as Slot | undefined;
      const box = slot && images.get(slot), { clientX: x, clientY: y } = event;
      const onImage = box && x !== undefined && y !== undefined ? x >= box.left && y >= box.top && x < box.left + box.width && y < box.top + box.height : null;
      const id = ++inputCount;
      lastInput = performance.now() - started;
      if (decision === 'apply') { firstPending ??= id; lastPending = id; }
      row('input', { id, kind, decision, slot, x, y, onImage, eventAt: event.timeStamp - started,
        ...(event instanceof WheelEvent ? { dx: event.deltaX, dy: event.deltaY, mode: event.deltaMode, ctrl: event.ctrlKey,
          momentum: (event as WheelEvent & { momentum?: boolean }).momentum ?? null } : {}),
        ...(event.scale !== undefined ? { scale: event.scale } : {}) });
    },
    geometry(slot: Slot, g: PresentationGeometry) {
      let stage = stages.get(slot);
      if (!stage || Math.abs(stage.width - g.width) > 1 || Math.abs(stage.height - g.height) > 1) {
        measureBounds(); stage = stages.get(slot);
      }
      if (!stage) return;
      const r = presentationRect(g);
      images.set(slot, { left: stage.left + r.x, top: stage.top + r.y, width: r.width, height: r.height });
    },
    commit(begin: number, presenterMs: number, gridMs: number) {
      row('commit', { begin: begin - started, durationMs: performance.now() - begin, presenterMs, gridMs, firstInput: firstPending, lastInput: lastPending,
        zoom: viewport.zoom, offsetX: viewport.offsetX, offsetY: viewport.offsetY });
      firstPending = lastPending = undefined;
    },
    settle() { if (active) row('recomposite', {}); },
  };
}
export type ViewportTrace = ReturnType<typeof installViewportTrace>;
