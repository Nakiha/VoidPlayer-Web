// In-memory thumbnail budgets and lifecycle. No DOM, no presenter imports:
// session.ts and unit tests share this without pulling rendering code.

export type OfferResult =
  | 'accepted'
  | 'already-cached'
  | 'in-flight'
  | 'not-first-frame'
  | 'unsupported'
  | 'budget-exceeded'
  | 'stale';

interface SkipCounter { [reason: string]: number; }

class ThumbnailState {
  /** Cache keys with a finished local artifact (Blob stored / object URL live). */
  readonly completed = new Set<string>();
  /** Cache keys with an accepted task not yet settled. */
  readonly inFlight = new Set<string>();
  /** True while one extra full-frame candidate is retained off the hot path. */
  holdingFull = false;
  holdStartedAt = 0;
  holdPeakBytes = 0;
  /** Small-image uploads awaiting fetch. */
  pendingUploads = 0;
  pendingUploadBytes = 0;
  /** Frozen upload epochs captured at accept time, keyed by cache key. */
  readonly epochs = new Map<string, number | undefined>();
  /** Last known server status per cache key (ready flag + epoch). */
  readonly statusCache = new Map<string, { ready: boolean; epoch?: number; width?: number; height?: number; at: number }>();
  skipped: SkipCounter = {};
  syncHookLastMs = 0;
  syncHookMaxMs = 0;
  // Non-interference proof: the thumbnail path must never perform these.
  videoRangeReads = 0;
  mediaSourceOpens = 0;
  frameAtCalls = 0;
  seekCalls = 0;
  indexScans = 0;
  rendered = 0;
  uploaded = 0;
  accepted = 0;

  skip(reason: string) {
    this.skipped[reason] = (this.skipped[reason] ?? 0) + 1;
  }

  noteHook(ms: number) {
    this.syncHookLastMs = ms;
    if (ms > this.syncHookMaxMs) this.syncHookMaxMs = ms;
  }

  rememberStatus(key: string, status: { ready: boolean; epoch?: number; width?: number; height?: number }) {
    this.statusCache.set(key, { ...status, at: Date.now() });
    if (status.epoch !== undefined) this.epochs.set(key, status.epoch);
  }

  cachedEpoch(key: string): number | undefined {
    return this.epochs.get(key);
  }

  snapshot() {
    return {
      completed: this.completed.size, inFlight: this.inFlight.size, holdingFull: this.holdingFull,
      holdPeakBytes: this.holdPeakBytes, pendingUploads: this.pendingUploads,
      skipped: { ...this.skipped }, syncHookLastMs: this.syncHookLastMs, syncHookMaxMs: this.syncHookMaxMs,
      rendered: this.rendered, uploaded: this.uploaded, accepted: this.accepted,
      videoRangeReads: this.videoRangeReads, mediaSourceOpens: this.mediaSourceOpens,
      frameAtCalls: this.frameAtCalls, seekCalls: this.seekCalls, indexScans: this.indexScans,
    };
  }

  /** Test isolation only. */
  reset() {
    this.completed.clear(); this.inFlight.clear();
    this.holdingFull = false; this.holdStartedAt = 0; this.holdPeakBytes = 0;
    this.pendingUploads = 0; this.pendingUploadBytes = 0;
    this.epochs.clear(); this.statusCache.clear(); this.skipped = {};
    this.syncHookLastMs = 0; this.syncHookMaxMs = 0;
    this.videoRangeReads = 0; this.mediaSourceOpens = 0; this.frameAtCalls = 0;
    this.seekCalls = 0; this.indexScans = 0; this.rendered = 0; this.uploaded = 0; this.accepted = 0;
  }
}

export const thumbnailState = new ThumbnailState();
