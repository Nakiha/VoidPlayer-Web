import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rgbaDescription } from '../src/frame-description.ts';
import type { DecodedFrame } from '../src/media.ts';
import { offerFirstFrameCandidate, settleOffer } from '../src/thumbnails/offer.ts';
import type { FirstFrameContext } from '../src/thumbnails/offer.ts';
import { thumbnailState } from '../src/thumbnails/state.ts';
import { THUMB_FRAME_BUDGET_BYTES } from '../src/thumbnails/contract.ts';

function context(overrides: Partial<FirstFrameContext> = {}): FirstFrameContext {
  return {
    cacheKey: `test|${Math.random().toString(36).slice(2)}`,
    kind: 'local', sourceGen: 1, sourcePtsUs: 1000, isFileFirst: true, byteSize: 400,
    ...overrides,
  };
}

function rgbaFrame(size = 16): DecodedFrame {
  const pixels = new Uint8ClampedArray(size);
  return {
    ptsUs: 0, sourcePtsUs: 1000, durationUs: 40000,
    description: rgbaDescription(2, 2), kind: 'rgba8', width: 2, height: 2,
    byteSize: size, pixels, close() {},
  };
}

function sampleFrame(): { frame: DecodedFrame; closes: () => number } {
  let closed = 0, clones = 0;
  const sample = {
    rotation: 0,
    clone() { clones++; return { rotation: 0, close() { closed++; } }; },
    close() {},
  };
  const frame = {
    ptsUs: 0, sourcePtsUs: 2000, durationUs: 40000,
    description: rgbaDescription(2, 2), kind: 'video-sample' as const, width: 2, height: 2,
    byteSize: 400, sample, close() {},
  } as unknown as DecodedFrame;
  return { frame, closes: () => closed };
}

test('non-first positions never produce a candidate and never seek', () => {
  thumbnailState.reset();
  const result = offerFirstFrameCandidate(context({ isFileFirst: false }), rgbaFrame());
  assert.equal(result, 'not-first-frame');
  assert.equal(thumbnailState.inFlight.size, 0);
  assert.equal(thumbnailState.frameAtCalls, 0);
  assert.equal(thumbnailState.seekCalls, 0);
  assert.equal(thumbnailState.videoRangeReads, 0);
});

test('dedupe: completed and in-flight keys are not re-accepted', () => {
  thumbnailState.reset();
  const key = 'dedupe|1';
  thumbnailState.completed.add(key);
  assert.equal(offerFirstFrameCandidate(context({ cacheKey: key }), rgbaFrame()), 'already-cached');
  thumbnailState.completed.clear();
  thumbnailState.inFlight.add(key);
  assert.equal(offerFirstFrameCandidate(context({ cacheKey: key }), rgbaFrame()), 'in-flight');
});

test('unsupported resources stay missing without holding anything', () => {
  thumbnailState.reset();
  // video-sample without a sample cannot be cloned.
  const bare = { ...rgbaFrame(), kind: 'video-sample' as const, pixels: undefined, sample: undefined };
  assert.equal(offerFirstFrameCandidate(context(), bare), 'unsupported');
  const hdr = { ...rgbaFrame(), description: {
    ...rgbaFrame().description,
    color: { primaries: null, transfer: 'pq', matrix: null, fullRange: true },
    sourceColor: { primaries: null, transfer: 'pq', matrix: null, fullRange: true },
  } };
  assert.equal(offerFirstFrameCandidate(context(), hdr), 'unsupported');
  assert.equal(thumbnailState.holdingFull, false);
  assert.equal(thumbnailState.inFlight.size, 0);
});

test('budgets bound held bytes and the single hold slot', () => {
  thumbnailState.reset();
  assert.equal(offerFirstFrameCandidate(context({ byteSize: THUMB_FRAME_BUDGET_BYTES + 1 }), rgbaFrame()), 'budget-exceeded');
  thumbnailState.holdingFull = true;
  assert.equal(offerFirstFrameCandidate(context(), rgbaFrame()), 'budget-exceeded');
});

test('stale tracks are rejected', () => {
  thumbnailState.reset();
  assert.equal(offerFirstFrameCandidate(context({ isLive: () => false }), rgbaFrame()), 'stale');
});

test('accepted video-sample clones without touching the original', () => {
  thumbnailState.reset();
  let originalClosed = false;
  const { frame, closes } = sampleFrame();
  (frame as { close: () => void }).close = () => { originalClosed = true; };
  const offered = offerFirstFrameCandidate(context({ epoch: 7 }), frame);
  assert.equal(typeof offered, 'object');
  assert.equal((offered as { result: string }).result, 'accepted');
  assert.equal(originalClosed, false);
  // Epoch is frozen at accept.
  assert.equal(thumbnailState.cachedEpoch((offered as { context: FirstFrameContext }).context.cacheKey), 7);
  const owned = (offered as { owned: DecodedFrame }).owned;
  owned.close();
  assert.equal(closes(), 1);
  assert.equal(originalClosed, false);
  settleOffer((offered as { context: FirstFrameContext }).context.cacheKey, true);
  assert.ok(thumbnailState.completed.has((offered as { context: FirstFrameContext }).context.cacheKey));
});

test('accepted pixel frames copy once and stay independent', () => {
  thumbnailState.reset();
  const frame = rgbaFrame(16);
  const offered = offerFirstFrameCandidate(context(), frame);
  assert.equal((offered as { result: string }).result, 'accepted');
  const owned = (offered as { owned: DecodedFrame }).owned;
  assert.notEqual(owned.pixels!.buffer, frame.pixels!.buffer);
  frame.pixels!.fill(9);
  assert.equal(owned.pixels![0], 0);
  owned.close();
  settleOffer((offered as { context: FirstFrameContext }).context.cacheKey, false);
  assert.equal(thumbnailState.holdingFull, false);
  assert.ok(!thumbnailState.completed.has((offered as { context: FirstFrameContext }).context.cacheKey));
});

test('non-interference counters stay zero through offers', () => {
  thumbnailState.reset();
  offerFirstFrameCandidate(context({ isFileFirst: false }), rgbaFrame());
  offerFirstFrameCandidate(context(), rgbaFrame());
  const snapshot = thumbnailState.snapshot();
  assert.equal(snapshot.videoRangeReads, 0);
  assert.equal(snapshot.mediaSourceOpens, 0);
  assert.equal(snapshot.frameAtCalls, 0);
  assert.equal(snapshot.seekCalls, 0);
  assert.equal(snapshot.indexScans, 0);
});
