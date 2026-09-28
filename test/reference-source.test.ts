import { test } from 'node:test';
import assert from 'node:assert/strict';
import { admitReferenceSource } from '../src/reference-source.ts';
import { rgbaDescription } from '../src/frame-description.ts';
import type { DecodedFrame, MediaSource } from '../src/media.ts';

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
  let disposed = 0;
  const source = {
    info: { decoder },
    frameAt: async () => yuvFrame(width),
    framesAfter: async () => [],
    async *framesFrom() { yield yuvFrame(width); },
    dispose() { disposed++; },
  } as unknown as MediaSource;
  return { source, disposeCount: () => disposed };
}

class IdleWorker {
  terminate() {}
}

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
    frame.close();
    selected.dispose();
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
    selected.dispose();
    assert.equal(native.disposeCount(), 1);
  } finally {
    globalThis.Worker = originalWorker;
  }
});
