import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import { RangeReader } from '../src/range-reader.ts';
import { readMp4Configurations } from '../src/mp4-config.ts';
import { createRangeBridge } from '../src/range-bridge.ts';
import { WorkerRpc } from '../src/ffmpeg-media.ts';
import { Mp4Engine } from '../src/mp4-engine.ts';
import { mp4BoundaryFixture } from '../scripts/mp4-boundary-fixture.ts';

const fixture = await mp4BoundaryFixture();
test('only top-level mdat overstatement is recoverable, with every video sample still in actual media bytes', async () => {
  for (const mode of ['valid', 'oversized', 'missing-sample', 'bad-moov', 'bad-child']) {
    const bytes = Buffer.from(mode === 'valid' ? fixture.valid : fixture.oversized);
    if (mode === 'bad-moov') bytes.writeUInt32BE(bytes.length + 100, fixture.moov);
    if (mode === 'bad-child') bytes.writeUInt32BE(bytes.length + 100, fixture.moov + 8);
    const input = mode === 'missing-sample' ? bytes.subarray(0, bytes.length - 1000) : bytes;
    const reader = new RangeReader({ file: new Blob([input]) });
    try {
      if (['bad-moov', 'bad-child', 'missing-sample'].includes(mode)) await assert.rejects(readMp4Configurations(reader, 1), /越界|样本缺失/);
      else {
        const config = await readMp4Configurations(reader, 1);
        assert.equal(config.sampleSizes!.length, 20);
        assert.equal(!!config.warning, mode === 'oversized');
        assert.ok(config.sampleOffsets!.every((p, i) => p >= fixture.mdat + 16 && p + config.sampleSizes![i] <= bytes.length));
      }
    } finally { reader.close(); }
  }
});

test('real packet decoding retains a usable overdeclared mdat and exposes its warning', async () => {
  const engine = new Mp4Engine({ file: new Blob([fixture.oversized]) });
  try {
    const info = await engine.open(new URL('../public/vendor/voidplayer-core/voidplayer-core.js', import.meta.url).href,
      await readFile(new URL('../public/vendor/voidplayer-core/voidplayer-core.wasm', import.meta.url)));
    assert.match(info.indexWarning!, /mdat/); assert.equal(info.width, 160);
    for (const pts of [0, 1500000, 0]) {
      const frame = await engine.at(pts); assert.equal(frame.pts, pts); assert.equal(frame.pixels!.byteLength, 160 * 96 * 4);
    }
  } finally { engine.close(); }
});

for (const variant of ['valid', 'oversized'] as const) test(`real FFmpeg Range AVIO opens 9 MiB moov, ${variant} mdat and seeks`, { timeout: 30000 }, async t => {
  const bytes = fixture[variant]; let requests = 0;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, options: RequestInit) => {
    const [, a, b] = /^bytes=(\d+)-(\d+)$/.exec((options.headers as Record<string, string>).Range)!;
    assert.ok(+b - +a + 1 <= 256 * 1024); requests++;
    return new Response(bytes.subarray(+a, +b + 1), { status: 206, headers: { 'Content-Range': `bytes ${a}-${b}/${bytes.length}` } });
  });
  const worker = new Worker(new URL('../src/ffmpeg-worker.ts', import.meta.url));
  const bridge = createRangeBridge(worker as unknown as globalThis.Worker, 'https://test.invalid/video', bytes.length);
  const rpc = new WorkerRpc(worker as unknown as globalThis.Worker, () => bridge.close());
  try {
    const info = await rpc.call<{ ctx: number; ticks: number[] }>('init', {
      glueURL: new URL('../public/vendor/voidplayer-core/voidplayer-core.js', import.meta.url).href,
      wasmBinary: await readFile(new URL('../public/vendor/voidplayer-core/voidplayer-core.wasm', import.meta.url)), range: { shared: bridge.shared, size: bytes.length },
    });
    assert.equal(info.ticks.length, 20);
    for (const index of [0, 15, 19, 0]) {
      const frame = await rpc.call<{ pixels: ArrayBuffer }>('extract', { ctx: info.ctx, index });
      assert.equal(frame.pixels.byteLength, 160 * 96 * 4);
    }
    assert.ok(requests > 0);
  } finally { rpc.terminate(); }
});
