import type { DecodedFrame } from './media.ts';

/** One independent, bounded producer per track. Never await decoding on the presentation path. */
export class FrameQueue {
  readonly frames: DecodedFrame[] = [];
  ended = false;
  error: unknown = null;
  private stopped = false;
  private wake: (() => void) | undefined;
  private bytes = 0;
  readonly done: Promise<void>;
  private gen: AsyncGenerator<DecodedFrame>;
  readonly capacity: number;
  readonly budgetBytes: number;
  constructor(gen: AsyncGenerator<DecodedFrame>, capacity = 4, budgetBytes = 64 * 1024 * 1024) {
    this.gen = gen; this.capacity = capacity; this.budgetBytes = budgetBytes;
    this.done = this.produce();
  }
  private async produce() {
    try {
      while (!this.stopped) {
        // Bounded by both count and bytes: four 4K RGBA frames are ~133 MB.
        if (this.frames.length >= this.capacity || this.bytes >= this.budgetBytes) await new Promise<void>(r => { this.wake = r; });
        if (this.stopped) break;
        const next = await this.gen.next();
        if (next.done) { this.ended = true; break; }
        if (this.stopped) { next.value.close(); break; }
        this.bytes += next.value.byteSize;
        this.frames.push(next.value);
      }
    } catch (error) { if (!this.stopped) this.error = error; }
    finally { await this.gen.return(undefined).catch(() => {}); }
  }
  take(target: number): { frame: DecodedFrame | null; dropped: number } {
    let frame: DecodedFrame | null = null; let dropped = 0;
    while (this.frames.length && this.frames[0].ptsUs <= target) {
      const shifted = this.frames.shift()!;
      this.bytes -= shifted.byteSize;
      if (frame) { frame.close(); dropped++; }
      frame = shifted;
    }
    this.wake?.(); this.wake = undefined;
    return { frame, dropped };
  }
  stop() {
    this.stopped = true;
    this.wake?.(); this.wake = undefined;
    for (const frame of this.frames.splice(0)) frame.close();
  }
}

export class PlaybackMeasurements {
  readonly startedMs = performance.now();
  wallMs = 0;
  mediaUs = 0;
  waitingMs = 0;
  maxFrameLagUs = 0;
  maxFrameSkewUs = 0;
  private tracks = new Map<string, { drawn: number; dropped: number; lastMs: number; maxGapMs: number; intervals: number[] }>();
  draw(slot: string, now: number, dropped: number) {
    const t = this.tracks.get(slot) ?? { drawn: 0, dropped: 0, lastMs: this.startedMs, maxGapMs: 0, intervals: [] };
    const gap = now - t.lastMs;
    t.maxGapMs = Math.max(t.maxGapMs, gap);
    if (t.intervals.length < 4096) t.intervals.push(gap);
    t.drawn++; t.dropped += dropped; t.lastMs = now;
    this.tracks.set(slot, t);
  }
  snapshot() {
    return { wallMs: this.wallMs, mediaUs: this.mediaUs, waitingMs: this.waitingMs,
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
