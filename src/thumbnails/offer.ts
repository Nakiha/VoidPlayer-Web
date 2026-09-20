// Synchronous first-frame offer. Runs inside the session load commit while the
// playback frame is still open, so it must stay allocation-light: validation,
// dedupe, budget checks and one independent resource reference. Heavy work
// (render, encode, store, upload) continues in tasks.ts off the hot path.

import { THUMB_FRAME_BUDGET_BYTES, THUMB_HOLD_MS } from './contract.ts';
import { thumbnailState } from './state.ts';
import type { OfferResult } from './state.ts';
import { presentationColor } from '../presentation-color.ts';
import type { DecodedFrame } from '../media.ts';

export type { OfferResult };

export interface FirstFrameContext {
  /** Versioned cache identity (server key or local key). */
  cacheKey: string;
  kind: 'library' | 'local';
  libraryId?: string;
  mediaVersion?: string;
  /** Session source generation isolating rebuilt instances. */
  sourceGen: number;
  /** Real decoded identity, never a seek argument. */
  sourcePtsUs: number;
  /** Caller-verified file-first condition (localTarget===0 && frame.ptsUs===0). */
  isFileFirst: boolean;
  /** Upload epoch frozen at accept; undefined means local-only this time. */
  epoch?: number;
  byteSize: number;
  /** False when the offering track is already superseded. */
  isLive?: () => boolean;
}

export interface AcceptedOffer {
  result: 'accepted';
  owned: DecodedFrame;
  context: FirstFrameContext;
  acceptedAt: number;
  expired: boolean;
  release(): void;
  onExpire?: () => void;
}

function unsupportedKind(frame: DecodedFrame): string | null {
  if (frame.kind === 'video-sample') return frame.sample ? null : 'video-sample without sample';
  if (frame.kind === 'yuv') return frame.pixels ? null : 'yuv without pixels';
  if (frame.kind === 'rgba8') return frame.pixels ? null : 'rgba8 without pixels';
  return 'unknown frame kind';
}

/**
 * frame stays owned by playback in every outcome. On 'accepted' the module
 * owns the returned reference and the caller must still close the original.
 */
export function offerFirstFrameCandidate(
  context: FirstFrameContext,
  frame: DecodedFrame,
): OfferResult | AcceptedOffer {
  if (!context.isFileFirst) { thumbnailState.skip('not-first-frame'); return 'not-first-frame'; }
  if (thumbnailState.completed.has(context.cacheKey)) return 'already-cached';
  if (thumbnailState.inFlight.has(context.cacheKey)) return 'in-flight';
  if (context.isLive && !context.isLive()) { thumbnailState.skip('stale'); return 'stale'; }
  const kindProblem = unsupportedKind(frame);
  if (kindProblem) { thumbnailState.skip(`unsupported:${kindProblem}`); return 'unsupported'; }
  let policy: ReturnType<typeof presentationColor>;
  try {
    policy = presentationColor(frame.kind, frame.description);
  } catch {
    thumbnailState.skip('unsupported:description');
    return 'unsupported';
  }
  // Fixed versioned SDR/sRGB output: HDR branches without a reliable
  // conversion stay missing rather than caching wrong colors.
  if (policy.unsupportedHdr) { thumbnailState.skip('unsupported:hdr'); return 'unsupported'; }
  const byteSize = Math.max(frame.byteSize, frame.pixels?.byteLength ?? 0, Number.isSafeInteger(context.byteSize) && context.byteSize >= 0 ? context.byteSize : 0);
  if (!(byteSize >= 0) || byteSize > THUMB_FRAME_BUDGET_BYTES) { thumbnailState.skip('budget:frame-bytes'); return 'budget-exceeded'; }
  if (thumbnailState.holdingFull) { thumbnailState.skip('budget:hold-slot'); return 'budget-exceeded'; }

  let owned: DecodedFrame;
  try {
    if (frame.kind === 'video-sample') {
      // Independent lifecycle via clone; the original stays with playback.
      // clone() and close() have distinct ownership semantics: never transfer.
      const sample = frame.sample!.clone();
      let closed = false;
      owned = {
        ...frame, sample,
        close() { if (closed) return; closed = true; try { sample.close(); } catch {} },
      };
    } else {
      // YUV/RGBA buffers recycle into a spare pool on close(); the async task
      // must never read the original array later, so copy once, bounded.
      const source = frame.pixels!;
      const copy = new Uint8ClampedArray(source.length);
      copy.set(source);
      let retained: Uint8ClampedArray | undefined = copy;
      let closed = false;
      owned = {
        ...frame, get pixels() { return retained; },
        close() { if (closed) return; closed = true; retained = undefined; },
      };
    }
  } catch {
    thumbnailState.skip('unsupported:clone');
    return 'unsupported';
  }

  const acceptedAt = Date.now();
  thumbnailState.inFlight.add(context.cacheKey);
  thumbnailState.holdingFull = true;
  thumbnailState.holdStartedAt = acceptedAt;
  thumbnailState.holdPeakBytes = Math.max(thumbnailState.holdPeakBytes, byteSize);
  thumbnailState.accepted++;
  if (context.epoch !== undefined) thumbnailState.epochs.set(context.cacheKey, context.epoch);
  const offer: AcceptedOffer = { result: 'accepted', owned, context, acceptedAt, expired: false, release };
  const token = Symbol(context.cacheKey);
  thumbnailState.holdOwner = token;
  let released = false;
  const timer = setTimeout(() => {
    offer.expired = true;
    offer.onExpire?.();
    release();
    thumbnailState.skip('budget:hold-timeout');
  }, THUMB_HOLD_MS);
  function release() {
    if (released) return;
    released = true;
    clearTimeout(timer);
    try { owned.close(); } catch {}
    if (thumbnailState.holdOwner === token) {
      thumbnailState.holdOwner = undefined;
      thumbnailState.holdingFull = false;
    }
  }
  return offer;
}

/** Release bookkeeping for an accepted task in every terminal outcome. */
export function settleOffer(cacheKey: string, completed: boolean) {
  thumbnailState.inFlight.delete(cacheKey);
  if (completed) thumbnailState.completed.add(cacheKey);
}
