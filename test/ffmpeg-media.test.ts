import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { buildExtractArgs, extractionMatchesIndex, openFFmpegMedia, parseShowinfoIndex } from '../src/ffmpeg-media.ts';
import type { FFmpegCoreFactory } from '../src/ffmpeg-core.ts';
import { openMedia } from '../src/media.ts';

// --- pure parsing / planning ---

const MKV_STREAM = '  Stream #0:0: Video: ffv1, yuv422p(tv, progressive), 320x180, SAR 1:1 DAR 16:9, 30 fps, 30 tbr, 1k tbn';
const TS_STREAM = '  Stream #0:0[0x12d]: Video: mpeg2video (Main) ([2][0][0][0] / 0x0002), yuv420p(tv, progressive), 1280x720 [SAR 1:1 DAR 16:9], 59.94 fps, 59.94 tbr, 90k tbn';
const frameLine = (pts: number, key: boolean, size = '320x180') =>
  `[Parsed_showinfo_0 @ 0xabc] n:   0 pts:${String(pts).padStart(6)} pts_time:${pts / 1000}   pos:      592 fmt:yuv422p sar:1/1 s:${size} i:P iskey:${key ? 1 : 0} type:I checksum:DEADBEEF`;

test('parseShowinfoIndex reads codec, timebase, dimensions, ticks and keyframe flags', () => {
  const index = parseShowinfoIndex([MKV_STREAM, frameLine(0, true), frameLine(33, false), frameLine(67, false)]);
  assert.deepEqual(index, { codec: 'ffv1', width: 320, height: 180, tbn: 1000, ticks: [0, 33, 67], keyframes: [true, false, false] });
  const ts = parseShowinfoIndex([TS_STREAM, frameLine(28500, true, '1280x720')]);
  assert.equal(ts?.codec, 'mpeg2video'); assert.equal(ts?.tbn, 90000); assert.deepEqual(ts?.ticks, [28500]);
  assert.equal(parseShowinfoIndex(['no video here']), null);
});

test('buildExtractArgs seeks only when asked and filters by exact ticks', () => {
  const args = buildExtractArgs('/in', '/out', 31500, 2, 0.025);
  assert.deepEqual(args.slice(0, 4), ['-hide_banner', '-copyts', '-ss', '0.025000']);
  assert.ok(args.includes('select=gte(pts\\,31500),showinfo'));
  assert.ok(!buildExtractArgs('/in', '/out', 0, 1, null).includes('-ss'));
});

test('extractionMatchesIndex requires an exact ordered prefix of the index', () => {
  const ticks = [0, 33, 67, 100];
  assert.equal(extractionMatchesIndex([33, 67, 100], ticks, 1, 2), true);
  assert.equal(extractionMatchesIndex([34, 67], ticks, 1, 2), false);
  assert.equal(extractionMatchesIndex([33], ticks, 1, 2), false);
  assert.equal(extractionMatchesIndex([33, 67], ticks, 3, 2), false);
});

// --- real WASM decode against the repository's sample files ---

const require = createRequire(import.meta.url);
async function loadNodeCore() {
  (globalThis as Record<string, unknown>).self ??= globalThis;
  (globalThis as Record<string, unknown>).location ??= { href: new URL('./', import.meta.url).href };
  const coreDir = new URL('../node_modules/@ffmpeg/core/dist/umd/', import.meta.url);
  const factory = require(require.resolve('./ffmpeg-core.js', { paths: [coreDir.pathname] })) as { default?: FFmpegCoreFactory } & FFmpegCoreFactory;
  const create = factory.default ?? factory;
  const wasmBinary = await readFile(new URL('ffmpeg-core.wasm', coreDir));
  return { create, wasmBinary };
}
async function openSample(name: string) {
  const { create, wasmBinary } = await loadNodeCore();
  const data = await readFile(new URL(`../../resources/video/${name}`, import.meta.url));
  const file = new File([data], name);
  return openFFmpegMedia(file, () => create({ wasmBinary }));
}

test('WASM fallback indexes and decodes an FFV1 Matroska sample frame-exactly', async () => {
  const source = await openSample('ffv1_yuv422p_8bit.mkv');
  try {
    assert.equal(source.info.codec, 'ffv1');
    assert.equal(source.info.decoder, 'ffmpeg-wasm');
    assert.equal(source.info.width, 320); assert.equal(source.info.height, 180);
    assert.ok(Math.abs(source.info.durationUs - 2000000) <= 2000);
    const first = await source.frameAt(0);
    assert.equal(first.ptsUs, 0); assert.equal(first.sourcePtsUs, 0);
    const mid = await source.frameAt(33999);
    assert.equal(mid.ptsUs, 33000); assert.equal(mid.durationUs, 34000);
    const after = await source.framesAfter(0, 2);
    assert.deepEqual(after.map(f => f.ptsUs), [33000, 67000]);
    const tail = await source.framesAfter(1934000, 5);
    assert.deepEqual(tail.map(f => f.ptsUs), [1967000]);
    const pixels = (mid as { pixels?: Uint8ClampedArray }).pixels;
    assert.equal(pixels?.length, 320 * 180 * 4);
  } finally { source.dispose(); }
});

test('WASM fallback handles an MPEG-2 TS sample mediabunny cannot demux', async () => {
  const source = await openSample('mpeg2_10s_1280x720.ts');
  try {
    assert.equal(source.info.codec, 'mpeg2video');
    assert.equal(source.info.width, 1280); assert.equal(source.info.height, 720);
    assert.equal(source.info.firstPtsUs, 316667);
    // Per-frame µs rounding accumulates; allow a few µs around the exact 10 s.
    assert.ok(Math.abs(source.info.durationUs - 10000000) <= 10);
    const first = await source.frameAt(0);
    assert.equal(first.ptsUs, 0); assert.equal(first.sourcePtsUs, 316667);
    const after = await source.framesAfter(0, 2);
    assert.equal(after.length, 2);
    assert.ok(Math.abs(after[0].ptsUs - 16667) <= 2 && Math.abs(after[1].ptsUs - 33333) <= 2);
  } finally { source.dispose(); }
});

test('WASM fallback still rejects H.266/VVC with the FFmpeg 5.1 core', async () => {
  await assert.rejects(openSample('h266_10s_1920x1080.mp4'));
});

test('openMedia falls back to WASM decoding for tracks WebCodecs cannot handle', async () => {
  // Node has no WebCodecs, so the native path declines early here; in the
  // browser the same fallback is reached when mediabunny exposes no decodable
  // track (FFV1) or the browser cannot decode it. The fallback loader is
  // injected because the default browser loader fetches bundled ?url assets.
  const { create, wasmBinary } = await loadNodeCore();
  const data = await readFile(new URL('../../resources/video/ffv1_yuv422p10le.mkv', import.meta.url));
  const source = await openMedia(new File([data], 'ffv1_yuv422p10le.mkv'), f => openFFmpegMedia(f, () => create({ wasmBinary })));
  try {
    assert.equal(source.info.decoder, 'ffmpeg-wasm');
    assert.equal(source.info.codec, 'ffv1');
    const frame = await source.frameAt(0);
    assert.equal((frame as { pixels?: Uint8ClampedArray }).pixels?.length, source.info.width * source.info.height * 4);
  } finally { source.dispose(); }
});
