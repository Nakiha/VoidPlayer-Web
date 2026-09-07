import { packetFixture } from './packet-fixture.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { RangeReader } from '../src/range-reader.ts';
import { openFFmpegMedia, openFFmpegMediaFromUrl } from '../src/ffmpeg-media.ts';
import { MediaOpenError } from '../src/media-errors.ts';

const core = new URL('../public/vendor/voidplayer-core/', import.meta.url);
const deps = async () => ({ glueURL: new URL('voidplayer-core.js', core).href, wasmBinary: await readFile(new URL('voidplayer-core.wasm', core)) });
const hash = (bytes: Uint8ClampedArray) => createHash('sha256').update(bytes).digest('hex');
async function serve(bytes: Uint8Array, size = bytes.length) {
  const requests: { start: number; end: number }[] = [];
  const server = createServer((req, res) => {
    const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '');
    if (!match) { res.writeHead(400); res.end(); return; }
    const start = Number(match[1]), end = Number(match[2]); requests.push({ start, end });
    assert.ok(end < size && end - start < 256 * 1024);
    const data = new Uint8Array(end - start + 1);
    if (start < bytes.length) data.set(bytes.subarray(start, Math.min(end + 1, bytes.length)));
    res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': data.length, ETag: '"unchanged"' }); res.end(data);
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/video`, requests,
    async close() { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); } };
}

test('Range reads cache blocks, reject invalid responses before consuming bodies, and cancel in-flight IO', async () => {
  const data = new Uint8Array(1024 * 1024).map((_, i) => i % 251), host = await serve(data);
  const reader = new RangeReader({ url: host.url, size: data.length });
  try {
    assert.deepEqual(await reader.read(260000, 10000), data.slice(260000, 270000));
    await reader.read(262145, 2); assert.equal(host.requests.length, 2);
    reader.close(); await assert.rejects(reader.read(0, 1), /取消/);
  } finally { reader.close(); await host.close(); }
  for (const mode of ['whole', 'wrong-range', 'changed', 'truncated', 'overflow', 'cancel']) {
    let count = 0, notify!: () => void;
    const started = new Promise<void>(r => { notify = r; });
    const server = createServer((req, res) => {
      count++; notify();
      if (mode === 'cancel') return;
      if (mode === 'whole') { res.writeHead(200, { 'Content-Length': '10000000000' }); res.write('x'); return; }
      const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range!)!, start = +match[1], end = +match[2];
      res.writeHead(206, { 'Content-Range': `bytes ${mode === 'wrong-range' ? 99 : start}-${end}/1048576`, ETag: mode === 'changed' && count > 1 ? '"new"' : '"old"' });
      res.end(new Uint8Array(end - start + 1 + (mode === 'truncated' ? -1 : mode === 'overflow' ? 1 : 0)));
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const reader = new RangeReader({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, size: 1048576 });
    try {
      if (mode === 'changed') await reader.read(0, 1);
      const request = reader.read(mode === 'changed' ? 524288 : 0, 1);
      const rejected = assert.rejects(request, e => e instanceof MediaOpenError && e.stage === 'input');
      if (mode === 'cancel') { await started; reader.close(); }
      await rejected;
    } finally { reader.close(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
  }
});

for (const name of ['h266_10s_1920x1080.mp4', 'h264_high422p_1s_320x180.mp4', 'hevc-packet-1080p.mp4', 'ffv1_yuv422p_8bit.mkv', 'mpeg2_10s_1280x720.ts']) {
  test(`Remote WASM ${name}: bounded Range IO and frame-exact random/forward/backward/tail decoding`, { timeout: 120000 }, async () => {
    const bytes = await packetFixture(name), host = await serve(bytes);
    const coreDeps = await deps();
    const reference = await openFFmpegMedia(new File([bytes], name), coreDeps);
    let source;
    try {
      source = await openFFmpegMediaFromUrl(host.url, { name, size: bytes.length, lastModified: 0 }, coreDeps);
      assert.equal(source.info.decoder, 'ffmpeg-wasm'); assert.equal(source.info.codec, reference.info.codec);
      assert.equal(source.info.width, reference.info.width); assert.equal(source.info.pixelFormat, reference.info.pixelFormat);
      if (name.startsWith('h266')) {
        const received = host.requests.reduce((n, r) => n + r.end - r.start + 1, 0);
        assert.ok(received < bytes.length / 2, `first-frame load must not scan mdat: ${received}/${bytes.length}`);
      }
      for (const pts of [0, 166667, Math.floor(source.info.durationUs * .6), 0, source.info.durationUs - 1]) {
        const expected = await reference.frameAt(pts), actual = await source.frameAt(pts);
        try { assert.ok(Math.abs(actual.ptsUs - expected.ptsUs) <= 1); assert.equal(hash(actual.pixels!), hash(expected.pixels!), `pixels at ${pts}`); }
        finally { actual.close(); expected.close(); }
      }
      const frames = await source.framesAfter(0, 3); assert.equal(frames.length, 3); frames.forEach(f => f.close());
      assert.deepEqual(await source.framesAfter(source.info.durationUs, 3), []);
    } finally { source?.dispose(); reference.dispose(); await host.close(); }
  });
}

test('MP4 metadata can address a source larger than 4 GiB without downloading its padding', { timeout: 60000 }, async () => {
  const bytes = await readFile(new URL('../fixtures/video/h264_high422p_1s_320x180.mp4', import.meta.url));
  // A valid size-zero free box extends to EOF. No huge allocation or fixture.
  const padded = new Uint8Array(bytes.length + 8); padded.set(bytes); padded.set([0, 0, 0, 0, 102, 114, 101, 101], bytes.length);
  const size = 5 * 1024 ** 3, host = await serve(padded, size);
  let source;
  try {
    source = await openFFmpegMediaFromUrl(host.url, { name: 'large.mp4', size, lastModified: 0 }, await deps());
    const frame = await source.frameAt(0); frame.close();
    assert.equal(source.info.size, size);
    assert.ok(host.requests.reduce((n, r) => n + r.end - r.start + 1, 0) < 2 * 1024 ** 2);
  } finally { source?.dispose(); await host.close(); }
});
