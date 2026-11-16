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
  holdOwner?: symbol;
  holdStartedAt = 0;
  holdPeakBytes = 0;
  skipped: SkipCounter = {};
  syncHookLastMs = 0;
  syncHookMaxMs = 0;
  rendered = 0;
  accepted = 0;

  skip(reason: string) {
    this.skipped[reason] = (this.skipped[reason] ?? 0) + 1;
  }

  noteHook(ms: number) {
    this.syncHookLastMs = ms;
    if (ms > this.syncHookMaxMs) this.syncHookMaxMs = ms;
  }

  snapshot() {
    return {
      completed: this.completed.size, inFlight: this.inFlight.size, holdingFull: this.holdingFull,
      holdPeakBytes: this.holdPeakBytes,
      skipped: { ...this.skipped }, syncHookLastMs: this.syncHookLastMs, syncHookMaxMs: this.syncHookMaxMs,
      rendered: this.rendered, accepted: this.accepted,
    };
  }

  /** Test isolation only. */
  reset() {
    this.completed.clear(); this.inFlight.clear();
    this.holdingFull = false; this.holdOwner = undefined; this.holdStartedAt = 0; this.holdPeakBytes = 0;
    this.skipped = {};
    this.syncHookLastMs = 0; this.syncHookMaxMs = 0;
    this.rendered = 0; this.accepted = 0;
  }
}

export const thumbnailState = new ThumbnailState();
