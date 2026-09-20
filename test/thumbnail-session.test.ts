import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rgbaDescription } from '../src/frame-description.ts';
import { ReviewSession } from '../src/session.ts';
import type { DecodedFrame, MediaSource } from '../src/media.ts';
import { thumbnailState } from '../src/thumbnails/state.ts';

function sampleMedia(name = 'A', starts = [0, 40000], end = 80000) {
  let frameAts = 0;
  const frame = (pts: number): DecodedFrame => {
    const sample = {
      rotation: 0,
      clone() {
        let cloneClosed = false;
        return { rotation: 0, close() { cloneClosed = true; }, get closed() { return cloneClosed; } };
      },
      close() {},
    };
    return {
      ptsUs: pts, sourcePtsUs: pts + 500000, durationUs: 40000,
      description: rgbaDescription(8, 8), kind: 'video-sample', width: 8, height: 8,
      byteSize: 256, sample, close() {},
    } as unknown as DecodedFrame;
  };
  const source: MediaSource = {
    info: { id: name, name, size: 10, lastModified: 0, codec: 'test', decoder: 'webcodecs', width: 8, height: 8, firstPtsUs: 500000, durationUs: end },
    async frameAt(time) {
      frameAts++;
      const i = Math.max(0, starts.findLastIndex(t => t <= time));
      return frame(starts[i]!);
    },
    async framesAfter(pts, count) { return starts.filter(t => t > pts).slice(0, count).map(frame); },
    async *framesFrom(pts) {
      for (let i = Math.max(0, starts.findLastIndex(t => t <= pts)); i < starts.length; i++) yield frame(starts[i]!);
    },
    dispose() {},
  };
  return { source, frameAts: () => frameAts };
}

test('opening from the origin offers one candidate with zero extra decode work', async () => {
  thumbnailState.reset();
  const session = new ReviewSession(() => {});
  const a = sampleMedia('thumb-A');
  await session.load('A', async () => a.source);
  assert.equal(a.frameAts(), 1, 'thumbnails add no frameAt calls');
  assert.equal(thumbnailState.accepted, 1);
  while (thumbnailState.inFlight.size) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(a.frameAts(), 1, 'no deferred thumbnail decode');
  await session.dispose();
});

test('joining at a non-zero position stays missing without seeking back', async () => {
  thumbnailState.reset();
  const session = new ReviewSession(() => {});
  const a = sampleMedia('thumb-B');
  await session.load('A', async () => a.source);
  await session.seek(40000);
  const b = sampleMedia('thumb-C');
  await session.load('B', async () => b.source);
  assert.equal(b.frameAts(), 1, 'one sync frame for the join position, none for a cover');
  assert.equal(thumbnailState.accepted, 1, 'only the origin open was offered');
  assert.equal(thumbnailState.skipped['not-first-frame'], 1);
  while (thumbnailState.inFlight.size) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(b.frameAts(), 1);
  await session.dispose();
});
