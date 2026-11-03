import type { SessionResources } from './resources.ts';
import type { DecodedFrame, VvcTuningAxis, VvcTuningState } from '../media/contract.ts';

/** One independent, bounded producer per track. Never await decoding on the presentation path. */
export class FrameQueue {
  readonly frames: DecodedFrame[] = [];
  ended = false;
  error: unknown = null;
  private stopped = false;
  private suspended = false;
  private wake: (() => void) | undefined;
  private frameChanged?: () => void;
  private lookahead = 0;
  private bytes = 0;
  private peakFrames = 0;
  private peakBytes = 0;
  private largestFrameBytes = 0;
  private minimumFrames: number;
  private resources?: SessionResources;
  private estimateBytes: number;
  private unsubscribe?: () => void;
  private get effectiveBudgetBytes() { return Math.max(this.budgetBytes, Math.min(this.minimumFrames, this.capacity) * this.largestFrameBytes); }
  readonly done: Promise<void>;
  private gen: AsyncGenerator<DecodedFrame>;
  private nextStartedMs: number | null = null;
  readonly capacity: number;
  readonly budgetBytes: number;
  constructor(gen: AsyncGenerator<DecodedFrame>, capacity = 4, budgetBytes?: number, resources?: SessionResources, estimateBytes = 0) {
    this.gen = gen; this.capacity = capacity; this.budgetBytes = budgetBytes ?? 64 * 1024 * 1024;
    this.resources = resources; this.estimateBytes = estimateBytes;
    this.unsubscribe = resources?.subscribe(() => { this.wake?.(); this.wake = undefined; });
    this.minimumFrames = budgetBytes === undefined ? 2 : 1;
    this.done = this.produce();
  }
  private async produce() {
    try {
      while (!this.stopped) {
        // Bounded by both count and bytes: four 4K RGBA frames are ~133 MB.
        while (!this.stopped && this.frames.length >= this.lookahead &&
            (this.suspended || this.frames.length >= this.capacity || this.bytes >= this.effectiveBudgetBytes ||
             (this.frames.length > 0 && this.resources && !this.resources.canPrefetch(Math.max(this.estimateBytes, this.largestFrameBytes))))) {
          await new Promise<void>(r => { this.wake = r; });
        }
        if (this.stopped) break;
        // Reserve before next(): independent tracks cannot all prefetch into
        // the same remaining bytes. One required frame per track guarantees progress.
        const release = this.resources?.reserve('decodeReservations', Math.max(this.estimateBytes, this.largestFrameBytes), this.frames.length === 0 || this.frames.length < this.lookahead);
        if (this.resources && !release) continue;
        let next: IteratorResult<DecodedFrame>;
        this.nextStartedMs = performance.now();
        try { next = await this.gen.next(); if (!next.done) this.resources?.own(next.value); }
        finally { this.nextStartedMs = null; release?.(); }
        if (next.done) { this.ended = true; break; }
        if (this.stopped) { next.value.close(); break; }
        this.largestFrameBytes = Math.max(this.largestFrameBytes, next.value.byteSize);
        this.bytes += next.value.byteSize;
        this.frames.push(next.value);
        this.peakFrames = Math.max(this.peakFrames, this.frames.length);
        this.peakBytes = Math.max(this.peakBytes, this.bytes);
        this.frameChanged?.();
      }
    } catch (error) { if (!this.stopped) this.error = error; }
    finally { this.frameChanged?.(); this.unsubscribe?.(); await this.gen.return(undefined).catch(() => {}); }
  }
  /** A paused consumer may require up to two frames for exact multi-track
   * stepping. Count them as essential just as the previous frame probe did. */
  async waitForSuccessors(after: number, count: 1 | 2, signal?: AbortSignal) {
    this.lookahead = count;
    try {
      for (;;) {
        signal?.throwIfAborted();
        this.take(after).frame?.close();
        if (this.error) throw this.error;
        if (this.frames.length >= count || this.ended || this.stopped) return;
        await new Promise<void>((resolve, reject) => {
          const finish = () => { this.frameChanged = undefined; signal?.removeEventListener('abort', abort); };
          const abort = () => { finish(); reject(signal?.reason); };
          this.frameChanged = () => { finish(); resolve(); };
          signal?.addEventListener('abort', abort, { once: true });
          this.wake?.(); this.wake = undefined;
        });
      }
    } finally { this.lookahead = 0; }
  }
  takeNext() {
    const frame = this.frames.shift();
    if (frame) {
      this.bytes -= frame.byteSize;
      this.wake?.(); this.wake = undefined;
    }
    return frame;
  }
  take(target: number): { frame: DecodedFrame | null; dropped: number } {
    let frame: DecodedFrame | null = null; let dropped = 0;
    while (this.frames.length && this.frames[0].ptsUs <= target) {
      const shifted = this.frames.shift()!;
      this.bytes -= shifted.byteSize;
      if (frame) { frame.close(); dropped++; }
      frame = shifted;
    }
    if (frame) { this.wake?.(); this.wake = undefined; }
    return { frame, dropped };
  }
  suspend() { this.suspended = true; }
  resume() { this.suspended = false; this.wake?.(); this.wake = undefined; }
  stop() {
    this.stopped = true;
    this.frameChanged?.();
    this.wake?.(); this.wake = undefined;
    for (const frame of this.frames.splice(0)) frame.close();
    this.bytes = 0;
  }
  snapshot() {
    return { ended: this.ended, suspended: this.suspended, stopped: this.stopped, error: this.error instanceof Error ? this.error.message : this.error == null ? null : String(this.error), frames: this.frames.length, bytes: this.bytes, peakFrames: this.peakFrames, peakBytes: this.peakBytes,
      firstPtsUs: this.frames[0]?.ptsUs ?? null, lastPtsUs: this.frames.at(-1)?.ptsUs ?? null,
      producerWaitMs: this.nextStartedMs === null ? null : performance.now() - this.nextStartedMs,
      capacity: this.capacity, budgetBytes: this.budgetBytes, effectiveBudgetBytes: this.effectiveBudgetBytes };
  }
}

export class PlaybackMeasurements {
  readonly startedMs = performance.now();
  wallMs = 0;
  mediaUs = 0;
  waitingMs = 0;
  firstAdvanceMs: number | null = null;
  firstPresentationMs: number | null = null;
  maxFrameLagUs = 0;
  maxFrameSkewUs = 0;
  private tracks = new Map<string, { drawn: number; dropped: number; lastMs: number; maxGapMs: number; intervals: number[] }>();
  private heldUntil = new Map<string,number>();
  private buffers: Record<string, ReturnType<FrameQueue['snapshot']>> = {};
  buffer(slot: string, queue: FrameQueue) { this.buffers[slot] = queue.snapshot(); }
  holdBeforeStart(slot:string, now:number) { this.heldUntil.set(slot,now); }
  draw(slot: string, now: number, dropped: number) {
    this.firstPresentationMs ??= now - this.startedMs;
    const t = this.tracks.get(slot) ?? { drawn: 0, dropped: 0, lastMs: this.heldUntil.get(slot) ?? this.startedMs, maxGapMs: 0, intervals: [] };
    const gap = now - t.lastMs;
    t.maxGapMs = Math.max(t.maxGapMs, gap);
    if (t.intervals.length < 4096) t.intervals.push(gap);
    t.drawn++; t.dropped += dropped; t.lastMs = now;
    this.tracks.set(slot, t);
  }
  snapshot() {
    return { wallMs: this.wallMs, mediaUs: this.mediaUs, waitingMs: this.waitingMs, firstAdvanceMs: this.firstAdvanceMs, firstPresentationMs: this.firstPresentationMs, buffers: { ...this.buffers },
      speed: this.wallMs > 0 ? this.mediaUs / (this.wallMs * 1000) : 0,
      maxFrameLagUs: this.maxFrameLagUs, maxFrameSkewUs: this.maxFrameSkewUs,
      tracks: Object.fromEntries([...this.tracks].map(([slot, t]) => {
        const intervals = [...t.intervals].sort((a, b) => a - b);
        return [slot, { drawn: t.drawn, dropped: t.dropped,
          fps: this.wallMs > 0 ? t.drawn * 1000 / this.wallMs : 0,
          maxGapMs: t.maxGapMs, p95GapMs: intervals[Math.max(0, Math.ceil(intervals.length * .95) - 1)] ?? 0 }];
      })) };
  }
}

/** Observe continuous playback in separate windows, excluding pauses and long UI ticks. */
export class VvcGrowthMonitor {
  private wallMs = 0;
  private skippedMs = 0;
  private advanceUs = 0;
  private starvedMs = 0;
  private slowWindows = 0;

  reset() { this.wallMs = this.skippedMs = this.advanceUs = this.starvedMs = this.slowWindows = 0; }

  sample(elapsed: number, advanceUs: number, starved: boolean, eligible: boolean) {
    if (!eligible) { this.reset(); return; }
    if (elapsed > 100) {
      this.skippedMs += elapsed;
    } else {
      this.wallMs += elapsed;
      this.advanceUs += advanceUs;
      if (starved) this.starvedMs += Math.max(0, elapsed - advanceUs / 1000);
    }
    const total = this.wallMs + this.skippedMs;
    if (total < 2000) return;
    const skipped = this.skippedMs / total;
    const speed = this.wallMs ? this.advanceUs / (this.wallMs * 1000) : 1;
    const starvation = this.wallMs ? this.starvedMs / this.wallMs : 0;
    this.wallMs = this.skippedMs = this.advanceUs = this.starvedMs = 0;
    this.slowWindows = skipped < .5 && speed < .95 && starvation >= .10 ? this.slowWindows + 1 : 0;
    return { speed, starvation, skipped, grow: this.slowWindows >= 2 };
  }
}


type VvcObservation = NonNullable<ReturnType<VvcGrowthMonitor['sample']>>;

export class VvcGrowthPolicy {
  private trial?: { axis: VvcTuningAxis; before: VvcObservation; warmup: boolean; first?: VvcObservation };

  private readonly blocked: Set<VvcTuningAxis>;

  constructor(blocked: Set<VvcTuningAxis>) { this.blocked = blocked; }

  restartObservation() {
    if (this.trial) {
      this.trial.warmup = true;
      this.trial.first = undefined;
    }
  }

  choose(window: VvcObservation, core: VvcTuningState): VvcTuningAxis | undefined {
    if (this.trial || !window.grow || !core.dispatched) return;
    const saturated = core.saturated / core.dispatched >= .12;
    if (saturated && core.threads < core.maxThreads && !this.blocked.has('threads')) return 'threads';
    const full = core.submitted > 0 && core.full / core.submitted >= .75 && core.maxFrameWaitUs >= 1000;
    if (full && core.contexts < core.maxContexts && !this.blocked.has('contexts')) return 'contexts';
  }

  applied(axis: VvcTuningAxis, before: VvcObservation, old: VvcTuningState, next: VvcTuningState | null) {
    if (!next || next[axis] <= old[axis]) { this.blocked.add(axis); return; }
    this.trial = { axis, before, warmup: true };
  }

  assess(window: VvcObservation) {
    const trial = this.trial;
    if (!trial || window.skipped >= .5) return;
    if (trial.warmup) { trial.warmup = false; return; }
    if (!trial.first) { trial.first = window; return; }
    const speed = (trial.first.speed + window.speed) / 2;
    const starvation = (trial.first.starvation + window.starvation) / 2;
    const helpful = speed >= trial.before.speed + .03 ||
      (speed >= trial.before.speed - .01 && starvation <= trial.before.starvation - .05);
    if (!helpful) this.blocked.add(trial.axis);
    this.trial = undefined;
    return { axis: trial.axis, before: trial.before, speed, starvation, helpful };
  }
}
