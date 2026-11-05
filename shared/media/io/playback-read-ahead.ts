const MIB = 1024 * 1024;
export const BASE_CACHE_BYTES = 8 * MIB;
export const MAX_PLAYBACK_CACHE_BYTES = 32 * MIB;
const BASE_AHEAD_BYTES = 2 * MIB;
const MAX_BATCH_BYTES = 8 * MIB;

export interface PlaybackReadAheadSnapshot {
  cacheLimitBytes: number;
  batchBytes: number;
  lowWaterBytes: number;
  consumptionBytesPerSecond: number;
  refillBytesPerSecond: number;
  refillP95Ms: number;
  inputWaitMs: number;
  starvationEvents: number;
  adjustments: number;
}

/** Byte-consumption and refill feedback, independent of source type, codec and
 * decoder threads. A slow completion alone cannot cause growth: actual demand
 * must have waited for missing bytes. All time values use one monotonic clock. */
export class PlaybackReadAhead {
  private cacheLimit = BASE_CACHE_BYTES;
  private batch = BASE_AHEAD_BYTES;
  private lowWater = BASE_AHEAD_BYTES;
  private rate = 0;
  private frontier?: number;
  private samplePosition = 0;
  private sampleAt = 0;
  private sampleWaitMs = 0;
  private lastReadAt?: number;
  private startedAt = 0;
  private lastAdjustment = 0;
  private lastStarvation = 0;
  private waits = 0;
  private waitEvents = 0;
  private totalWait = 0;
  private totalEvents = 0;
  private freshWait = false;
  private adjustments = 0;
  private refills: {bytes:number;ms:number}[] = [];
  readonly blockSize: number;
  constructor(blockSize: number) { this.blockSize = blockSize; }
  get cacheBytes() { return this.cacheLimit; }
  get batchBytes() { return this.batch; }
  get lowWaterBytes() { return this.lowWater; }
  private aligned(bytes: number) { return Math.ceil(bytes / this.blockSize) * this.blockSize; }
  private refillTime(bytes = this.batch) {
    const samples = this.refills.map(sample => sample.ms * Math.max(1, bytes / sample.bytes)).sort((a,b) => a-b);
    return samples[Math.max(0,Math.ceil(samples.length*.95)-1)] ?? 0;
  }
  snapshot(): PlaybackReadAheadSnapshot {
    return {cacheLimitBytes:this.cacheLimit,batchBytes:this.batch,lowWaterBytes:this.lowWater,
      consumptionBytesPerSecond:this.rate*1000,refillBytesPerSecond:this.refillTime() ? this.batch/this.refillTime()*1000 : 0,
      refillP95Ms:this.refillTime(),inputWaitMs:this.totalWait,
      starvationEvents:this.totalEvents,adjustments:this.adjustments};
  }
  begin(offset: number, now: number) {
    if (this.frontier === undefined) this.lastAdjustment = now-500;
    if (this.frontier === undefined || (this.lastReadAt !== undefined && now-this.lastReadAt > 1500)
      || offset > this.frontier + MAX_PLAYBACK_CACHE_BYTES || offset + MAX_PLAYBACK_CACHE_BYTES < this.frontier) {
      this.frontier = this.samplePosition = offset;
      this.sampleAt = this.startedAt = this.lastStarvation = now;
      this.sampleWaitMs = 0;
      this.rate = this.waits = this.waitEvents = 0; this.freshWait = false;
    }
  }
  consumed(end: number, now: number) {
    this.frontier = Math.max(this.frontier ?? end,end);
    this.lastReadAt = now;
    const elapsed = now-this.sampleAt;
    const active = elapsed-this.sampleWaitMs;
    // A fast decoder can spend almost all startup time waiting for IO. Keep
    // its wall-clock rate until there is enough unblocked time to estimate
    // consumption capacity; never postpone feedback while the input starves.
    if (elapsed >= 250) {
      const rate = (this.frontier-this.samplePosition)/(active >= 100 ? active : elapsed);
      this.rate = this.rate ? this.rate*.5+rate*.5 : rate;
      this.sampleAt = now; this.samplePosition = this.frontier; this.sampleWaitMs = 0;
    }
    this.adjust(now,this.freshWait);
    this.freshWait = false;
  }
  refilled(bytes: number, ms: number) {
    if (bytes <= 0 || !Number.isFinite(ms) || ms <= 0) return;
    this.refills.push({bytes,ms});
    if (this.refills.length > 12) this.refills.shift();
  }
  waited(ms: number, now: number) {
    this.sampleWaitMs += ms;
    this.totalWait += ms;
    if (ms < 4) return;
    this.waits += ms; this.waitEvents++;
    this.totalEvents++; this.freshWait = true;
    this.lastStarvation = now;
  }
  private apply(batch: number, lowWater: number, now: number) {
    // Reserve history plus the current block. Protecting forward blocks in the
    // reader prevents an enlarged refill from evicting its own next demand.
    const history = MIB + this.blockSize;
    lowWater = Math.min(this.aligned(lowWater),MAX_PLAYBACK_CACHE_BYTES-batch-history);
    let cache = BASE_CACHE_BYTES;
    while (cache < lowWater+batch+history) cache *= 2;
    if (batch !== this.batch || lowWater !== this.lowWater || cache !== this.cacheLimit) this.adjustments++;
    this.batch = batch; this.lowWater = lowWater; this.cacheLimit = cache;
    this.lastAdjustment = now; this.waits = this.waitEvents = 0;
  }
  private adjust(now: number, freshWait: boolean) {
    if (!this.rate || this.refills.length < 2 || now-this.startedAt < 500) return;
    if (freshWait && this.waitEvents >= 2 && this.waits >= 20 && now-this.lastAdjustment >= 1000) {
      const busy = this.rate*this.refillTime()/this.batch;
      const batch = busy >= .7 ? Math.min(MAX_BATCH_BYTES,this.batch*2) : this.batch;
      const needed = Math.max(BASE_AHEAD_BYTES,this.rate*(this.refillTime(batch)*1.5+50));
      this.apply(batch,Math.max(needed,this.lowWater+this.batch/2),now);
    } else if (now-this.lastStarvation >= 15000 && now-this.lastAdjustment >= 5000) {
      // Use the observed full-request duration as an upper bound for a smaller
      // request, rather than assuming its fixed latency scales with byte size.
      const duration = this.refillTime();
      const batch = this.batch > BASE_AHEAD_BYTES && this.rate*duration < this.batch/4 ? this.batch/2 : this.batch;
      const needed = Math.max(BASE_AHEAD_BYTES,this.rate*(duration*1.5+50));
      this.apply(batch,Math.min(this.lowWater,Math.max(needed,this.lowWater/2)),now);
    }
  }
}
