import { buildInfo } from './build-info.ts';
import type { ReviewSession } from './session.ts';
import { log } from './log.ts';

type State = ReturnType<ReviewSession['getState']>;
type Measurements = NonNullable<State['playback']>;
export const PLAYBACK_LIMITS = { minWallMs: 1000, minSpeed: .9, maxFrameLagUs: 100000,
  maxFrameSkewUs: 100000, maxP95GapMs: 75, maxGapMs: 250, maxPauseMs: 100 };
export function assessPlayback(m: Measurements | null, pauseMs: number, staleAfterPause: boolean) {
  const failures: string[] = [];
  if (!m || m.wallMs < PLAYBACK_LIMITS.minWallMs) failures.push('insufficient-sample');
  if (m) {
    if (m.speed < PLAYBACK_LIMITS.minSpeed) failures.push('below-realtime');
    if (m.maxFrameLagUs > PLAYBACK_LIMITS.maxFrameLagUs) failures.push('frame-lag');
    if (m.maxFrameSkewUs > PLAYBACK_LIMITS.maxFrameSkewUs) failures.push('track-skew');
    if (!Object.keys(m.tracks).length) failures.push('no-frames');
    for (const [slot, t] of Object.entries(m.tracks)) {
      if (!t.drawn) failures.push(`${slot}:no-frames`);
      if (t.p95GapMs > PLAYBACK_LIMITS.maxP95GapMs || t.maxGapMs > PLAYBACK_LIMITS.maxGapMs) failures.push(`${slot}:presentation-stall`);
    }
  }
  if (pauseMs > PLAYBACK_LIMITS.maxPauseMs) failures.push('pause-latency');
  if (staleAfterPause) failures.push('stale-frame-after-pause');
  return failures;
}
const running = new WeakSet<ReviewSession>();
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
/** Used unchanged by the visible app, WebMCP, and the browser matrix runner. */
export async function benchmarkPlayback(session: ReviewSession, durationMs = 8000) {
  if (!Number.isInteger(durationMs) || durationMs < 1000 || durationMs > 30000) throw new Error('测试时长必须为 1000–30000 ms。');
  if (running.has(session)) throw new Error('性能检查正在运行。');
  const before = session.getState();
  if (!before.tracks.length || before.busy) throw new Error('请先载入视频并等待定位完成。');
  running.add(session);
  const environment = {
    build: buildInfo,
    page: typeof location === 'undefined' ? null : location.href,
    userAgent: typeof navigator === 'undefined' ? 'node' : navigator.userAgent,
    crossOriginIsolated: !!globalThis.crossOriginIsolated,
    secureContext: !!globalThis.isSecureContext,
    webCodecsAvailable: typeof VideoDecoder !== 'undefined',
    hardwareUseVerified: false,
    sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
    visibility: typeof document === 'undefined' ? 'unavailable' : document.visibilityState,
    viewport: typeof window === 'undefined' ? null : { width: innerWidth, height: innerHeight, devicePixelRatio },
  };
  let backgrounded = environment.visibility !== 'visible';
  const visibility = () => { if (document.visibilityState !== 'visible') backgrounded = true; };
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', visibility);
  const longTasksSupported = typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes.includes('longtask');
  const longTasks: number[] = [];
  const observer = longTasksSupported ? new PerformanceObserver(list => { for (const e of list.getEntries()) longTasks.push(e.duration); }) : null;
  observer?.observe({ entryTypes: ['longtask'] });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;
  const check = () => { if (cancelled) throw new Error('性能检查已取消。'); };
  try {
    // Include start/seek in the watchdog, not just the polling phase.
    const run = async () => {
      await session.seek(0); check();
      const startup = performance.now();
      await session.play(); check();
      const startupMs = performance.now() - startup;
      // Exercise pause with real in-flight playback, even for short clips that
      // finish before the main measurement interval expires.
      await sleep(200); check();
      const prePauseStart = performance.now();
      const prePaused = session.pause();
      const prePauseMs = performance.now() - prePauseStart;
      await sleep(100); check();
      const preAfter = session.getState();
      const frameSignature = (s: State) => JSON.stringify(s.tracks.map(t => [t.id, t.frame?.ptsUs]));
      const preStale = frameSignature(prePaused) !== frameSignature(preAfter) || prePaused.positionUs !== preAfter.positionUs;
      await session.seek(0); check();
      await session.play(); check();
      const started = performance.now();
      while (session.getState().playing && performance.now() - started < durationMs) { await sleep(50); check(); }
      const ending = session.getState();
      const pauseStart = performance.now();
      const paused = session.pause();
      const pauseMs = Math.max(prePauseMs, performance.now() - pauseStart);
      await sleep(100); check();
      const after = session.getState();
      const staleAfterPause = preStale || frameSignature(paused) !== frameSignature(after) || paused.positionUs !== after.positionUs;
      const failures = assessPlayback(ending.playback, pauseMs, staleAfterPause);
      if (backgrounded) failures.push('page-not-visible');
      if (ending.error) failures.push('playback-error');
      if (ending.tracks.map(t => t.id).join() !== before.tracks.map(t => t.id).join()) failures.push('media-changed');
      const reachedEnd = ending.positionUs >= ending.durationUs - 1;
      if (!ending.playing && !reachedEnd && !ending.error) failures.push('interrupted');
      if (reachedEnd && ending.tracks.some(t => !t.frame || t.frame.ptsUs + t.offsetUs + t.frame.durationUs < ending.durationUs - 1000)) failures.push('premature-end');
      const report = { schema: 'voidplayer-playback-benchmark', version: 1, passed: failures.length === 0,
        failures, limits: PLAYBACK_LIMITS, environment, startupMs, requestedWallMs: durationMs,
        reachedEnd, error: ending.error, pauseMs, staleAfterPause,
        measurements: ending.playback, tracks: ending.tracks,
        longTasks: observer ? { count: longTasks.length, totalMs: longTasks.reduce((a, b) => a + b, 0) } : null,
        evidence: 'actual-app-canvas-draws; physical-screen-scanout-unverified' };
      log[report.passed ? 'info' : 'warn']('session', '播放性能检查', { passed: report.passed, failures, environment, measurements: report.measurements, tracks: ending.tracks.map(t => ({ slot: t.slot, name: t.name, decoder: t.decoder, coreVariant: t.coreVariant })), pauseMs, staleAfterPause });
      return report;
    };
    return await Promise.race([run(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { cancelled = true; session.pause(); reject(new Error('性能检查超时。')); }, durationMs + 20000);
    })]);
  } finally {
    cancelled = true; clearTimeout(timer); observer?.disconnect(); running.delete(session);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', visibility);
  }
}
