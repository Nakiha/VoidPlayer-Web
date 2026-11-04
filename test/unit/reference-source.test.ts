import { test } from 'node:test';
import assert from 'node:assert/strict';
import { admitReferenceSource } from '../../src/media/policy/reference-source.ts';
import { createVerifiedFrameHandoff } from '../../src/media/decoding/verified-frame-handoff.ts';
import { rgbaDescription } from '../../shared/media/frame-description.ts';
import type { DecodedFrame, MediaSource } from '../../src/media/contract.ts';

const color = { matrix: 'bt709', primaries: 'bt709', transfer: 'bt709', fullRange: false };

function yuvFrame(width: number): DecodedFrame {
  const height = 2;
  const chromaWidth = Math.ceil(width / 2);
  const lumaBytes = width * height;
  const pixels = new Uint8ClampedArray(lumaBytes + chromaWidth * 2);
  const description = rgbaDescription(width, height, {
    format: 'YUV',
    byteLength: pixels.byteLength,
    color,
    yuv: {
      bitDepth: 8, bitShift: 0, subsampleX: 1, subsampleY: 1, semiplanar: false, chromaLocation: 1,
      planes: [
        { offset: 0, stride: width, width, height },
        { offset: lumaBytes, stride: chromaWidth, width: chromaWidth, height: 1 },
        { offset: lumaBytes + chromaWidth, stride: chromaWidth, width: chromaWidth, height: 1 },
      ],
    },
  });
  return {
    ptsUs: 0, sourcePtsUs: 0, durationUs: 1, width, height, byteSize: pixels.byteLength,
    kind: 'yuv', pixels, description, close() {},
  };
}

function mediaSource(decoder: string, width: number) {
  let disposed = 0, frameAtCalls = 0, frameCloseCalls = 0;
  let lastFrame: DecodedFrame | undefined;
  const source = {
    info: { decoder },
    frameAt: async () => {
      frameAtCalls++;
      lastFrame = yuvFrame(width);
      const close = lastFrame.close;
      lastFrame.close = () => { frameCloseCalls++; close(); };
      return lastFrame;
    },
    framesAfter: async () => [],
    async *framesFrom() { yield yuvFrame(width); },
    dispose() { disposed++; },
  } as unknown as MediaSource;
  return { source, disposeCount: () => disposed, frameAtCalls: () => frameAtCalls, frameCloseCalls: () => frameCloseCalls, lastFrame: () => lastFrame };
}

class IdleWorker {
  terminate() {}
}

test('a verified origin frame transfers ownership once and is never served for a different target', () => {
  const slot = createVerifiedFrameHandoff();
  let closed = 0;
  const frame = () => ({ ...yuvFrame(2), close() { closed++; } });
  const first = frame();
  slot.offer(first);
  assert.equal(slot.take(0), first);
  assert.equal(slot.take(0), undefined);
  slot.clear();
  assert.equal(closed, 0, 'handed-off frames belong to the caller');
  first.close();
  slot.offer(frame());
  assert.equal(slot.take(1), undefined);
  assert.equal(closed, 2, 'a nonzero seek releases the unconsumed origin');
  slot.offer(frame());
  slot.offer(frame());
  assert.equal(closed, 3, 'replacement closes the old origin');
  slot.clear();
  slot.clear();
  assert.equal(closed, 4, 'invalidating an unconsumed origin closes it once');
});

test('verified frame delivery uses the finalized namespace without inventing or changing its AU witness', () => {
  let version = 'temporary', closed = 0;
  const slot = createVerifiedFrameHandoff(() => version);
  const sourcePicture = { sourceVersion: version, stream: 'video', configuration: 2, au: 17, picture: 0 as const, layer: 0 as const, field: 'frame' as const };
  slot.offer({ ...yuvFrame(2), sourcePicture, close() { closed++; } });
  version = 'library@version';
  const delivered = slot.take(0)!;
  assert.deepEqual(delivered.sourcePicture, { ...sourcePicture, sourceVersion: version });
  delivered.close();
  slot.clear();
  assert.equal(closed, 1);
  slot.offer(yuvFrame(2));
  assert.equal(slot.take(0)?.sourcePicture, undefined, 'an unverified frame never gains an inferred AU');
});

test('reference admission reuses a validated software witness when native geometry mismatches', async () => {
  const originalWorker = globalThis.Worker;
  globalThis.Worker = IdleWorker as unknown as typeof Worker;
  const native = mediaSource('webcodecs', 4);
  const software = mediaSource('ffmpeg-wasm', 2);
  let softwareOpens = 0;
  try {
    const selected = await admitReferenceSource(native.source, async () => {
      softwareOpens++;
      return software.source;
    }, 1);

    assert.equal(selected.info.decoder, 'ffmpeg-wasm');
    assert.equal(softwareOpens, 1);
    assert.equal(native.disposeCount(), 1);
    assert.equal(software.disposeCount(), 0);

    const frame = await selected.frameAt(0);
    assert.equal(frame.kind, 'yuv');
    assert.equal(frame, software.lastFrame(), 'the verified software witness is presented without a second decode');
    assert.equal(software.frameAtCalls(), 1);
    frame.close();
    selected.dispose();
    assert.equal(software.disposeCount(), 1);
  } finally {
    globalThis.Worker = originalWorker;
  }
});

test('reference admission closes an unconsumed witness when the selected source is disposed', async () => {
  const originalWorker = globalThis.Worker;
  globalThis.Worker = IdleWorker as unknown as typeof Worker;
  const native = mediaSource('webcodecs', 4);
  const software = mediaSource('ffmpeg-wasm', 2);
  try {
    const selected = await admitReferenceSource(native.source, async () => software.source, 1);
    const witness = software.lastFrame();
    assert.ok(witness);
    assert.equal(software.frameCloseCalls(), 0);
    selected.dispose();
    assert.equal(software.frameCloseCalls(), 1, 'abandoning the pending first frame must close it');
    assert.equal(software.disposeCount(), 1);
  } finally {
    globalThis.Worker = originalWorker;
  }
});

test('reference admission still selects native output after a matching witness', async () => {
  const originalWorker = globalThis.Worker;
  globalThis.Worker = IdleWorker as unknown as typeof Worker;
  const native = mediaSource('webcodecs', 2);
  const software = mediaSource('ffmpeg-wasm', 2);
  try {
    const selected = await admitReferenceSource(native.source, async () => software.source, 1);
    assert.equal(selected.info.decoder, 'webcodecs');
    assert.equal(software.disposeCount(), 1);
    const frame = await selected.frameAt(0);
    assert.equal(frame, native.lastFrame(), 'the verified native probe is presented without another readback');
    assert.equal(native.frameAtCalls(), 1);
    frame.close();
    selected.dispose();
    assert.equal(native.disposeCount(), 1);
  } finally {
    globalThis.Worker = originalWorker;
  }
});
