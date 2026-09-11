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
test('only top-level mdat overstatement is recoverable; missing suffix samples are excluded', async () => {
  for (const mode of ['valid', 'oversized', 'missing-sample', 'bad-moov', 'bad-child']) {
    const bytes = Buffer.from(mode === 'valid' ? fixture.valid : fixture.oversized);
    if (mode === 'bad-moov') bytes.writeUInt32BE(bytes.length + 100, fixture.moov);
    if (mode === 'bad-child') bytes.writeUInt32BE(bytes.length + 100, fixture.moov + 8);
    const input = mode === 'missing-sample' ? bytes.subarray(0, bytes.length - 1000) : bytes;
    const reader = new RangeReader({ file: new Blob([input]) });
    try {
      if (['bad-moov', 'bad-child'].includes(mode)) await assert.rejects(readMp4Configurations(reader, 1), /越界|样本缺失/);
      else {
        const config = await readMp4Configurations(reader, 1);
        assert.equal(config.sampleSizes!.length, 20);
        assert.equal(!!config.warning, mode !== 'valid');
        const available = config.availableSamples!;
        assert.equal(available < 20, mode === 'missing-sample');
        assert.ok(config.sampleOffsets!.slice(0, available).every((p, i) => p >= fixture.mdat + 16 && p + config.sampleSizes![i] <= input.length));
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
      const frame = await engine.at(pts); assert.equal(frame.pts, pts); assert.equal(frame.pixels!.byteLength, 160 * 96 * 1.5);
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
      assert.equal(frame.pixels.byteLength, 160 * 96 * 1.5);
    }
    assert.ok(requests > 0);
  } finally { rpc.terminate(); }
});


test('truncated MP4 indexes and decodes only complete samples, including repeat seeks', async () => {
  const reader = new RangeReader({ file: new Blob([fixture.valid]) });
  const table = await readMp4Configurations(reader, 1); reader.close();
  // Cut halfway through sample 13; neither that packet nor the suffix may be read.
  const bytes = fixture.valid.subarray(0, table.sampleOffsets![13] + Math.floor(table.sampleSizes![13] / 2));
  const engine = new Mp4Engine({ file: new Blob([bytes]) });
  try {
    const info = await engine.open(new URL('../public/vendor/voidplayer-core/voidplayer-core.js', import.meta.url).href,
      await readFile(new URL('../public/vendor/voidplayer-core/voidplayer-core.wasm', import.meta.url)));
    assert.match(info.indexWarning!, /前 13 个完整视频包/);
    assert.equal(info.durationUs, 1300000);
    for (const pts of [0, 1200000, 500000, 0]) {
      const frame = await engine.at(pts);
      assert.equal(frame.pts, pts); assert.equal(frame.pixels!.byteLength, 160 * 96 * 1.5);
    }
  } finally { engine.close(); }
});

test('truncation recovery rejects arbitrary offsets and an empty video prefix without fallback', async () => {
  for (const mode of ['outside-mdat', 'empty']) {
    const bytes = Buffer.from(fixture.oversized);
    if (mode === 'outside-mdat') {
      const at = bytes.indexOf(Buffer.from('stco'));
      bytes.writeUInt32BE(1, at + 12); // First chunk points into the file header.
    }
    const reader = new RangeReader({ file: new Blob([mode === 'empty' ? bytes.subarray(0, fixture.mdat + 16) : bytes]) });
    try {
      await assert.rejects(readMp4Configurations(reader, 1), (error: any) => error.stage === 'input' && /无法安全恢复/.test(error.message));
    } finally { reader.close(); }
  }
});


test('co64 with B-frame reordering keeps decode-order prefix and presentation timestamps', async () => {
  const source = await mp4BoundaryFixture(2, true);
  const reader = new RangeReader({ file: new Blob([source.valid]) });
  const table = await readMp4Configurations(reader, 1); reader.close();
  assert.ok(source.valid.includes(Buffer.from('co64')));
  assert.ok(new Set(table.compositionOffsets).size > 1);
  const bytes = source.valid.subarray(0, table.sampleOffsets![13] + 1);
  const engine = new Mp4Engine({ file: new Blob([bytes]) });
  try {
    const info = await engine.open(new URL('../public/vendor/voidplayer-core/voidplayer-core.js', import.meta.url).href,
      await readFile(new URL('../public/vendor/voidplayer-core/voidplayer-core.wasm', import.meta.url)));
    assert.match(info.indexWarning!, /前 13 个完整视频包/);
    assert.equal(info.times.length, 13);
    assert.ok(info.durationUs < 2000000);
    for (const pts of [...info.times, 0, info.times.at(-1)!]) {
      const frame = await engine.at(pts + info.firstPtsUs);
      assert.equal(frame.pts, pts + info.firstPtsUs);
      assert.equal(frame.pixels!.byteLength, 160 * 96 * 1.5);
    }
  } finally { engine.close(); }
});
