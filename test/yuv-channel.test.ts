import test from 'node:test';
import assert from 'node:assert/strict';
import { yuvChannelGray, yuvToRgba } from '../src/yuv-color.ts';
import { yuvFixture } from './helpers/yuv-fixture.ts';
import { Viewport } from '../src/viewport.ts';
import { getPresentationChannel, setPresentationChannel, presentationChannelCode } from '../src/presentation-channel.ts';
import type { PresentationChannel } from '../src/presentation-channel.ts';
import { parseWorkspace } from '../src/workspace-file.ts';

test('Y channel maps limited/full luma endpoints to black/white gray', () => {
  for (const full of [false, true]) {
    const f = yuvFixture(8, false, full, 'bt709', 2, 1);
    const scale = 1, max = 255;
    f.write(0, 0, 0, full ? 0 : 16 * scale);
    f.write(0, 1, 0, full ? max : 235 * scale);
    assert.deepEqual(yuvChannelGray(f.description, f.pixels, 0, 0, 'y'), [0, 0, 0]);
    assert.deepEqual(yuvChannelGray(f.description, f.pixels, 1, 0, 'y'), [255, 255, 255]);
  }
});

test('U/V neutral chroma renders mid-gray and extremes reach black/white', () => {
  const f = yuvFixture(8, false, false, 'bt709', 3, 1);
  // yuvFixture chroma is 420-subsampled: 3 luma pixels share 2 chroma samples.
  // Overwrite both chroma samples so every luma pixel sees the same value.
  f.write(1, 0, 0, 128); f.write(1, 1, 0, 128);
  f.write(2, 0, 0, 128); f.write(2, 1, 0, 128);
  for (let x = 0; x < 3; x++) {
    assert.deepEqual(yuvChannelGray(f.description, f.pixels, x, 0, 'u'), [128, 128, 128]);
    assert.deepEqual(yuvChannelGray(f.description, f.pixels, x, 0, 'v'), [128, 128, 128]);
  }
  f.write(1, 0, 0, 16); f.write(1, 1, 0, 16);
  assert.deepEqual(yuvChannelGray(f.description, f.pixels, 0, 0, 'u')[0], 0);
  f.write(1, 0, 0, 240); f.write(1, 1, 0, 240);
  assert.deepEqual(yuvChannelGray(f.description, f.pixels, 0, 0, 'u')[0], 255);
});

test('channel isolation ignores matrix and survives 10-bit planar/NV12', () => {
  for (const semi of [false, true]) {
    const a = yuvFixture(10, semi, false, 'bt709', 2, 1);
    const b = yuvFixture(10, semi, false, 'smpte170m', 2, 1);
    assert.deepEqual(yuvToRgba(a.description, a.pixels, 'y'), yuvToRgba(b.description, b.pixels, 'y'));
    assert.deepEqual(yuvToRgba(a.description, a.pixels, 'u'), yuvToRgba(b.description, b.pixels, 'u'));
    assert.deepEqual(yuvToRgba(a.description, a.pixels, 'v'), yuvToRgba(b.description, b.pixels, 'v'));
  }
  // Saturated pixel distinguishes matrices in RGB but not in isolated channels.
  const a = yuvFixture(8, false, false, 'bt709', 2, 1);
  const b = yuvFixture(8, false, false, 'smpte170m', 2, 1);
  for (const f of [a, b]) { f.write(0, 0, 0, 81); f.write(1, 0, 0, 90); f.write(2, 0, 0, 240); }
  assert.notDeepEqual(
    [...yuvToRgba(a.description, a.pixels, 'rgb').slice(0, 3)],
    [...yuvToRgba(b.description, b.pixels, 'rgb').slice(0, 3)],
  );
  assert.deepEqual(yuvToRgba(a.description, a.pixels, 'y'), yuvToRgba(b.description, b.pixels, 'y'));
  assert.deepEqual(yuvToRgba(a.description, a.pixels, 'u'), yuvToRgba(b.description, b.pixels, 'u'));
  assert.deepEqual(yuvToRgba(a.description, a.pixels, 'v'), yuvToRgba(b.description, b.pixels, 'v'));
});

test('channel grayscale output is opaque gray with equal components', () => {
  const f = yuvFixture(8, false, true, 'bt709', 2, 2);
  for (const channel of ['y', 'u', 'v'] as const) {
    const out = yuvToRgba(f.description, f.pixels, channel);
    assert.equal(out.length, 2 * 2 * 4);
    for (let i = 0; i < out.length; i += 4) {
      assert.equal(out[i], out[i + 1]);
      assert.equal(out[i + 1], out[i + 2]);
      assert.equal(out[i + 3], 255);
    }
  }
});

test('viewport channel defaults to rgb, validates and round-trips', () => {
  const v = new Viewport();
  assert.equal(v.channel, 'rgb');
  assert.equal(v.snapshot().channel, 'rgb');
  v.setChannel('u');
  assert.equal(v.snapshot().channel, 'u');
  assert.throws(() => v.setChannel('alpha' as never));
  v.apply({ channel: 'v' });
  assert.equal(v.channel, 'v');
});

test('presentation channel global validates codes', () => {
  assert.equal(getPresentationChannel(), 'rgb');
  assert.deepEqual((['rgb', 'y', 'u', 'v'] as PresentationChannel[]).map(presentationChannelCode), [0, 1, 2, 3]);
  setPresentationChannel('y');
  assert.equal(getPresentationChannel(), 'y');
  assert.throws(() => setPresentationChannel('alpha' as never));
  setPresentationChannel('rgb');
});

test('legacy workspaces without a channel restore as rgb', () => {
  const document = parseWorkspace({
    schema: 'voidplayer-workspace', version: 1, generatedAt: new Date().toISOString(),
    serverUrl: 'http://example.test/', positionUs: 0,
    tracks: [{ slot: 'A', mediaId: 'sample', offsetUs: 0 }],
    media: [{ id: 'sample', name: 'sample.mp4', size: 100, lastModified: 10, codec: 'h264', decoder: 'webcodecs', width: 100, height: 100, durationUs: 1000, firstPtsUs: 0 }],
    marks: [],
    viewport: { mode: 'side-by-side', arrangement: 'horizontal', splitPos: 0.5, zoom: 1, offsetX: 0, offsetY: 0, pixelSize: 'uniform' },
  });
  assert.equal(document.viewport.channel, 'rgb');
});
