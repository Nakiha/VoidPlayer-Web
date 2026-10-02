import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openFFmpegContainerFromUrl } from '../src/ffmpeg-media.ts';
import { rgbaDescription } from '../src/frame-description.ts';

const description = rgbaDescription(1, 1);
const originTicks = 90_000;
const frame = (pts: number, duration = 3_600) => ({
  pts, duration, description, pixels: new Uint8Array([1, 2, 3, 255]).buffer,
});

class DelayedIndexWorker {
  listeners = new Map<string, Set<(event: { data: any }) => void>>();
  initId = 0;
  terminated = false;
  extractRequests = 0;
  indexActions: string[] = [];
  firstDuration: number;
  constructor(firstDuration = 3_600) { this.firstDuration = firstDuration; }

  addEventListener(type: string, listener: (event: { data: any }) => void) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: { data: any }) => void) {
    this.listeners.get(type)?.delete(listener);
  }

  postMessage(message: any) {
    if (message.type === 'index-input') {
      this.indexActions.push(message.action);
    } else if (message.type === 'init') {
      this.initId = message.id;
      queueMicrotask(() => this.emit({
        id: message.id, type: 'ready', data: {
          ctx: 1, path: '/fake.ts', ticks: [originTicks], durations: [this.firstDuration],
          firstPts: originTicks, firstFrame: frame(originTicks, this.firstDuration), tbNum: 1, tbDen: 90_000,
          width: 1, height: 1, codec: 'mpeg2video', indexSource: 'server', indexPending: true,
          indexIdentity: { kind: 'ffmpeg', streamKey: 'video:0', schemaVersion: 2, indexerBuild: 'a'.repeat(40) },
        },
      }));
    } else if (message.type === 'extract') {
      this.extractRequests++;
      this.emit({ id: message.id, ok: true, data: frame(message.index === 0 ? originTicks : originTicks + 3_600) });
    }
  }

  emit(data: any) {
    for (const listener of this.listeners.get('message') ?? []) listener({ data });
  }

  failWorker(message = 'simulated worker crash') {
    for (const listener of this.listeners.get('error') ?? []) listener({ message } as any);
  }

  failIndex(message = 'simulated index failure') {
    this.emit({ id: this.initId, type: 'index-error', data: { error: message } });
  }

  reportScanProgress(progress = { packets: 1024, scannedBytes: 8192, totalBytes: 1_000 }) {
    this.emit({ id: this.initId, type: 'index-progress', data: progress });
  }

  finishIndex() {
    this.emit({
      id: this.initId, type: 'index-complete', data: {
        ctx: 1, path: '/fake.ts', ticks: [originTicks, originTicks + 3_600],
        durations: [3_600, 3_600], tbNum: 1, tbDen: 90_000,
        width: 1, height: 1, codec: 'mpeg2video', indexMs: 10,
        indexSource: 'server', localIndexBuildCalls: 0, seekAnchorCount: 2,
      },
    });
  }

  publishBatch(ticks = [originTicks + 3_600], stableCoverageUs = 80_000) {
    this.emit({ id: this.initId, type: 'index-batch', data: {
      ctx: 1, ticks, durations: ticks.map(() => 3_600), stableCoverageUs, seekAnchorCount: 1,
      buildId: '11111111-1111-4111-8111-111111111111',
    } });
  }

  terminate() { this.terminated = true; }
}

function openWith(worker: DelayedIndexWorker) {
  return openFFmpegContainerFromUrl(
    'http://localhost/api/media/' + 'a'.repeat(24) + '?v=1',
    { name: 'clip.ts', size: 1_000, lastModified: 0 },
    {
      glueURL: 'https://player.test/core.js',
      wasmBinary: new Uint8Array([0]),
      workerFactory: () => worker as unknown as Worker,
    },
  );
}

test('FFmpeg source presents its first frame before index completion and keeps its timeline origin', async () => {
  const worker = new DelayedIndexWorker();
  const source = await openWith(worker);
  try {
    assert.equal(source.info.indexState, 'building');
    assert.equal(source.info.firstPtsUs, 1_000_000);

    const first = await source.frameAt(0);
    assert.equal(first.ptsUs, 0);
    assert.equal(first.sourcePtsUs, 1_000_000);
    first.close();

    let settled = false;
    const waiting = source.ensureIndexed!(50_000).then(() => { settled = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false);

    worker.finishIndex();
    await waiting;
    assert.equal(source.info.indexState, 'complete');
    assert.equal(source.info.firstPtsUs, 1_000_000);

    const afterIndex = await source.frameAt(0);
    assert.equal(afterIndex.ptsUs, 0);
    assert.equal(afterIndex.sourcePtsUs, 1_000_000);
    afterIndex.close();
  } finally {
    source.dispose();
  }
});

test('a primed first frame remains replayable after a witness read while the index is building', async () => {
  const worker = new DelayedIndexWorker();
  const source = await openWith(worker);
  try {
    assert.equal(source.info.indexState, 'building');

    // Reference admission reads frame zero before deciding whether to keep
    // WebCodecs. The selected software source must still serve the display.
    const witness = await source.frameAt(0);
    const witnessPixels = Array.from(witness.pixels ?? []);
    witness.close();
    assert.equal(worker.extractRequests, 0);

    // A later indexed frame may recycle its output buffer into the worker.
    worker.publishBatch();
    const later = await source.frameAt(50_000);
    assert.equal(later.ptsUs, 40_000);
    later.close();
    assert.equal(worker.extractRequests, 1);

    const display = await source.frameAt(0);
    assert.equal(display.ptsUs, 0);
    assert.deepEqual(Array.from(display.pixels ?? []), witnessPixels);
    assert.equal(worker.extractRequests, 1, 'frame zero must come from the retained primed frame');
    assert.equal(source.info.indexState, 'building');
    display.close();
  } finally {
    source.dispose();
  }
});

test('disposing a partially indexed FFmpeg source releases target-index waiters', async () => {
  const worker = new DelayedIndexWorker();
  const source = await openWith(worker);
  const waiting = source.ensureIndexed!(50_000);
  source.dispose();
  await assert.rejects(waiting, /媒体已释放/);
  assert.equal(worker.terminated, true);
});

test('a worker crash after early ready marks the index failed and releases coverage waiters', async () => {
  const worker = new DelayedIndexWorker();
  const source = await openWith(worker);
  const waiting = source.ensureIndexed!(50_000);
  await new Promise(resolve => setImmediate(resolve));

  worker.failWorker();

  await assert.rejects(waiting, /simulated worker crash/);
  assert.equal(source.info.indexState, 'error');
  assert.match(source.info.indexError ?? '', /simulated worker crash/);
  source.dispose();
});

test('framesFrom propagates a background index failure instead of reporting EOF', async () => {
  const worker = new DelayedIndexWorker();
  const source = await openWith(worker);
  const frames = source.framesFrom(0);
  const first = await frames.next();
  assert.equal(first.done, false);
  first.value!.close();

  worker.failIndex('scan stopped');
  await assert.rejects(frames.next(), /scan stopped/);
  assert.equal(source.info.indexState, 'error');
  source.dispose();
});

test('an unknown first-frame duration exposes only its timestamp as stable seek coverage', async () => {
  const worker = new DelayedIndexWorker(0);
  const source = await openWith(worker);
  try {
    assert.equal(source.info.durationUs, 40_000);
    assert.equal(source.info.stableCoverageUs, 1);

    const first = await source.frameAt(0);
    first.close();

    let settled = false;
    const waiting = source.ensureIndexed!(20_000).then(() => { settled = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false);

    worker.finishIndex();
    await waiting;
    assert.equal(source.info.stableCoverageUs, 80_000);
  } finally {
    source.dispose();
  }
});

test('server scan progress reaches the media source info after early ready', async () => {
  const worker = new DelayedIndexWorker();
  const source = await openWith(worker);
  try {
    worker.reportScanProgress({ packets: 7_500, scannedBytes: 12_345, totalBytes: 99_000 });
    assert.deepEqual(source.info.indexProgress, { packets: 7_500, scannedBytes: 12_345, totalBytes: 99_000 });
  } finally {
    source.dispose();
  }
});

test('a stable FFmpeg record batch advances seek coverage before index completion', async () => {
  const worker = new DelayedIndexWorker();
  const source = await openWith(worker);
  try {
    let settled = false;
    const waiting = source.ensureIndexed!(50_000).then(() => { settled = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false);

    worker.publishBatch();
    await waiting;
    assert.equal(source.info.indexState, 'building');
    assert.equal(source.info.stableCoverageUs, 80_000);

    const frame = await source.frameAt(50_000);
    assert.equal(frame.sourcePtsUs, 1_040_000);
    frame.close();
  } finally {
    source.dispose();
  }
});

for (const method of ['framesAfter', 'framesFrom'] as const) {
  test(`${method} releases an internal index wait on repeated disposal`, { timeout: 2_000 }, async () => {
    const worker = new DelayedIndexWorker();
    const source = await openWith(worker);
    try {
      const iterator = method === 'framesFrom' ? source.framesFrom(0) : undefined;
      if (iterator) (await iterator.next()).value!.close();
      const pending = iterator ? iterator.next() : source.framesAfter(0, 1);
      const rejected = assert.rejects(pending, /媒体已释放/);
      await new Promise(resolve => setImmediate(resolve));
      source.dispose();
      source.dispose();
      await rejected;
      assert.equal(worker.terminated, true);
    } finally { source.dispose(); }
  });
}

const streamBuildId = '11111111-1111-4111-8111-111111111111';
function indexStreamEvents() {
  const identity = { kind: 'ffmpeg', streamKey: 'video:0', schemaVersion: 2, indexerBuild: 'a'.repeat(40) };
  const records = new Uint8Array(80);
  const view = new DataView(records.buffer);
  for (let i = 0; i < 2; i++) {
    const offset = i * 40;
    view.setBigInt64(offset, BigInt(originTicks + i * 3_600), true);
    view.setBigInt64(offset + 8, BigInt(originTicks + i * 3_600), true);
    view.setBigInt64(offset + 16, 3_600n, true);
    view.setBigInt64(offset + 24, BigInt(i * 188), true);
    view.setInt32(offset + 32, 188, true);
    view.setUint32(offset + 36, i === 0 ? 3 : 1, true);
  }
  return [
    { type: 'manifest', protocol: 2, epoch: 1, kind: 'ffmpeg', encoding: 'ffmpeg-records-base64',
      state: 'streaming', buildId: streamBuildId, identity, recordBytes: 40, lastSeq: -1,
      metadata: { schema: 2, kind: 'ffmpeg-container', size: 1000, codec: 'mpeg2video', timeBaseNum: 1,
        timeBaseDen: 90_000, width: 1, height: 1, streamIndex: 0, indexerBuild: identity.indexerBuild,
        firstPts: String(originTicks), originVerified: true, recordBytes: 40 } },
    { type: 'batch', buildId: streamBuildId, seq: 0, count: 2, safePresentationUs: 40_000,
      data: Buffer.from(records).toString('base64') },
  ];
}

for (const outcome of ['acknowledge', 'reset', 'error', 'dispose'] as const) {
  test(`transport coverage waits for decoder import (${outcome})`, { timeout: 2_000 }, async () => {
    const originalFetch = globalThis.fetch;
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
      start(value) { controller = value; },
    }), { headers: { 'content-type': 'application/x-ndjson' } })) as typeof fetch;
    const worker = new DelayedIndexWorker(0);
    const source = await openWith(worker);
    try {
      for (const event of indexStreamEvents()) controller.enqueue(new TextEncoder().encode(JSON.stringify(event) + '\n'));
      await new Promise(resolve => setImmediate(resolve));
      let settled = false;
      const pending = source.frameAt(20_000);
      const observed = pending.then(value => { settled = true; return value; }, error => { settled = true; throw error; });
      // A macrotask must continue to run while HTTP coverage is ahead of worker import.
      await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(settled, false, 'transport receipt must not expose unimported coverage');
      assert.equal(source.info.stableCoverageUs, 1);
      if (outcome === 'reset') {
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ type: 'reset', buildId: '22222222-2222-4222-8222-222222222222' }) + '\n'));
        await new Promise(resolve => setImmediate(resolve));
        assert.ok(worker.indexActions.includes('fallback'));
        worker.publishBatch();
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(settled, false, 'the abandoned stream must not unlock a replacement build');
        worker.finishIndex();
        (await observed).close();
      } else if (outcome === 'acknowledge') {
        worker.emit({ id: worker.initId, type: 'index-batch', data: { ctx: 1, ticks: [originTicks + 3_600],
          durations: [3_600], stableCoverageUs: 80_000, seekAnchorCount: 1,
          buildId: '22222222-2222-4222-8222-222222222222' } });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(settled, false, 'acknowledgement from another build must not unlock this session');
        worker.publishBatch();
        const decoded = await observed;
        assert.equal(source.info.stableCoverageUs, 80_000);
        assert.equal(decoded.ptsUs, 0);
        decoded.close();
        const later = await source.frameAt(50_000);
        assert.equal(later.ptsUs, 40_000);
        later.close();
      } else {
        const rejected = assert.rejects(observed, outcome === 'dispose' ? /媒体已释放/ : /import failed/);
        if (outcome === 'dispose') source.dispose(); else worker.failIndex('import failed');
        await rejected;
        worker.publishBatch();
        assert.equal(source.info.stableCoverageUs, 1, 'late acknowledgement must not resurrect failed/disposed coverage');
      }
    } finally {
      source.dispose();
      // A reset cancels and closes the response body before local fallback.
      try { controller.close(); } catch {}
      globalThis.fetch = originalFetch;
    }
  });
}


test('a rejected complete index releases session coverage waiters', async () => {
  const worker = new DelayedIndexWorker();
  const source = await openWith(worker);
  try {
    const rejected = assert.rejects(source.ensureIndexed!(90_000), /首帧时间轴/);
    worker.emit({ id: worker.initId, type: 'index-complete', data: { ctx: 1, ticks: [0], durations: [3_600] } });
    await rejected;
    assert.equal(source.info.indexState, 'error');
  } finally { source.dispose(); }
});
