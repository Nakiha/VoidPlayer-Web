import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { floorIndex, nextIndex, openFFmpegMedia } from '../src/ffmpeg-media.ts';
import { openMedia } from '../src/media.ts';
import type { FallbackDeps } from '../src/ffmpeg-media.ts';
import type { MediaSource } from '../src/media.ts';

// --- pure index navigation ---

test('floorIndex and nextIndex resolve frame navigation boundaries', () => {
  const times = [0, 33333, 66667, 100000];
  assert.equal(floorIndex(times, 0), 0);
  assert.equal(floorIndex(times, 66666), 1);
  assert.equal(floorIndex(times, 100000), 3);
  assert.equal(floorIndex(times, 999999), 3);
  assert.equal(nextIndex(times, 0), 1);
  assert.equal(nextIndex(times, 99999), 3);
  assert.equal(nextIndex(times, 100000), -1);
});

// --- real WASM decode against the repository's sample files ---

async function nodeCoreDeps(): Promise<FallbackDeps> {
  const coreDir = new URL('../public/vendor/voidplayer-core/', import.meta.url);
  let wasmBinary;
  try { wasmBinary = await readFile(new URL('voidplayer-core.wasm', coreDir)); }
  catch {
    throw new Error('缺少 vendor 的 WASM core：先运行 scripts/sync-wasm-core.sh（需要 VoidPlayer-FFmpeg-Build 的构建产物）');
  }
  return { glueURL: new URL('voidplayer-core.js', coreDir).href, wasmBinary };
}
async function openSample(name: string): Promise<MediaSource> {
  const deps = await nodeCoreDeps();
  const data = await readFile(new URL(`../fixtures/video/${name}`, import.meta.url));
  return openFFmpegMedia(new File([data], name), deps);
}

test('WASM fallback indexes and decodes an FFV1 Matroska sample frame-exactly', async () => {
  const source = await openSample('ffv1_yuv422p_8bit.mkv');
  try {
    assert.equal(source.info.codec, 'ffv1');
    assert.equal(source.info.decoder, 'ffmpeg-wasm');
    assert.equal(source.info.pixelFormat, 'yuv422p');
    assert.equal(source.info.width, 320); assert.equal(source.info.height, 180);
    assert.ok(Math.abs(source.info.durationUs - 2000000) <= 2000);
    const first = await source.frameAt(0);
    assert.equal(first.ptsUs, 0); assert.equal(first.sourcePtsUs, 0);
    const mid = await source.frameAt(33999);
    assert.equal(mid.ptsUs, 33000);
    const after = await source.framesAfter(0, 2);
    assert.deepEqual(after.map(f => f.ptsUs), [33000, 67000]);
    const tail = await source.framesAfter(1934000, 5);
    assert.deepEqual(tail.map(f => f.ptsUs), [1967000]);
    const pixels = (mid as { pixels?: Uint8ClampedArray }).pixels;
    assert.equal(pixels?.length, 320 * 180 * 4);
    assert.ok(new Set(pixels!.slice(0, 4096)).size > 1, 'frame must not be blank');
  } finally { source.dispose(); }
});

test('WASM fallback handles an MPEG-2 TS sample mediabunny cannot demux', async () => {
  const source = await openSample('mpeg2_10s_1280x720.ts');
  try {
    assert.equal(source.info.codec, 'mpeg2video');
    assert.equal(source.info.width, 1280); assert.equal(source.info.height, 720);
    assert.equal(source.info.firstPtsUs, 316667);
    assert.ok(Math.abs(source.info.durationUs - 10000000) <= 100);
    const first = await source.frameAt(0);
    assert.equal(first.ptsUs, 0); assert.equal(first.sourcePtsUs, 316667);
    const after = await source.framesAfter(0, 2);
    assert.equal(after.length, 2);
    assert.ok(Math.abs(after[0].ptsUs - 16667) <= 2 && Math.abs(after[1].ptsUs - 33333) <= 2);
    // Backward/random access must recover through a fresh GOP decode.
    const late = await source.frameAt(5000000);
    const back = await source.frameAt(0);
    assert.equal(back.ptsUs, 0);
    assert.ok(late.ptsUs > 4999000 && late.ptsUs <= 5000000);
  } finally { source.dispose(); }
});

test('WASM fallback covers H.264 High 4:2:2, which browsers do not decode', async () => {
  // avc1.7a000d (High 4:2:2) is rejected by WebCodecs on all mainstream
  // browsers; the fallback must carry it like any other codec gap.
  const source = await openSample('h264_high422p_1s_320x180.mp4');
  try {
    assert.equal(source.info.codec, 'h264');
    assert.equal(source.info.width, 320); assert.equal(source.info.height, 180);
    const first = await source.frameAt(0);
    assert.equal(first.ptsUs, 0);
    assert.ok(new Set((first as { pixels?: Uint8ClampedArray }).pixels!.slice(0, 4096)).size > 1, 'frame must not be blank');
  } finally { source.dispose(); }
});

test('WASM fallback decodes H.266/VVC through the n9.0.1 core', async () => {
  const source = await openSample('h266_10s_1920x1080.mp4');
  try {
    assert.equal(source.info.codec, 'vvc');
    assert.equal(source.info.width, 1920); assert.equal(source.info.height, 1080);
    const first = await source.frameAt(0);
    assert.equal(first.ptsUs, 0);
    const pixels = (first as { pixels?: Uint8ClampedArray }).pixels;
    assert.equal(pixels?.length, 1920 * 1080 * 4);
    assert.ok(new Set(pixels!.slice(0, 8192)).size > 1, 'frame must not be blank');
  } finally { source.dispose(); }
});

test('openMedia falls back to WASM decoding for tracks WebCodecs cannot handle', async () => {
  // Node has no WebCodecs, so the native path declines early here; in the
  // browser the same fallback is reached when mediabunny exposes no decodable
  // track (FFV1) or the browser cannot decode it. The fallback loader is
  // injected because the default browser loader fetches public/ assets.
  const deps = await nodeCoreDeps();
  const data = await readFile(new URL('../fixtures/video/ffv1_yuv422p10le.mkv', import.meta.url));
  const source = await openMedia(new File([data], 'ffv1_yuv422p10le.mkv'), f => openFFmpegMedia(f, deps));
  try {
    assert.equal(source.info.decoder, 'ffmpeg-wasm');
    assert.equal(source.info.codec, 'ffv1');
    const frame = await source.frameAt(0);
    assert.equal((frame as { pixels?: Uint8ClampedArray }).pixels?.length, source.info.width * source.info.height * 4);
  } finally { source.dispose(); }
});

test('WASM source metadata retains 10-bit layout and decoded BT.709 tags before RGBA conversion', async () => {
  const tenBit = await openSample('ffv1_yuv444p10le.mkv');
  try { assert.equal(tenBit.info.pixelFormat, 'yuv444p10le'); }
  finally { tenBit.dispose(); }
  const full = await openSample('mhw_hevc_fullrange_bt709_3s.mp4');
  try {
    // This fixture's MP4 colr says PC, but ffprobe -show_frames confirms TV in the bitstream.
    assert.equal(full.info.color?.fullRange, false);
    assert.equal(full.info.colorSource, 'decoder');
    assert.equal(full.info.color?.primaries, 'bt709');
    assert.equal(full.info.color?.transfer, 'bt709');
    assert.equal(full.info.color?.matrix, 'bt709');
    assert.ok(full.info.pixelFormat?.startsWith('yuv'));
  } finally { full.dispose(); }
});
