import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openFFmpegContainerFromUrl } from '../src/ffmpeg-media.ts';
import { rgbaDescription } from '../src/frame-description.ts';

const description = rgbaDescription(1, 1);
const originTicks = 90_000;
const frame = (pts: number) => ({
  pts, duration: 3_600, description, pixels: new Uint8Array([1, 2, 3, 255]).buffer,
});

class DelayedIndexWorker {
  listeners = new Map<string, Set<(event: { data: any }) => void>>();
  initId = 0;
  terminated = false;

  addEventListener(type: string, listener: (event: { data: any }) => void) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: { data: any }) => void) {
    this.listeners.get(type)?.delete(listener);
  }

  postMessage(message: any) {
    if (message.type === 'init') {
      this.initId = message.id;
      queueMicrotask(() => this.emit({
        id: message.id, type: 'ready', data: {
          ctx: 1, path: '/fake.ts', ticks: [originTicks], durations: [3_600],
          firstPts: originTicks, firstFrame: frame(originTicks), tbNum: 1, tbDen: 90_000,
          width: 1, height: 1, codec: 'mpeg2video', indexSource: 'server',
        },
      }));
    } else if (message.type === 'extract') {
      this.emit({ id: message.id, ok: true, data: frame(message.index === 0 ? originTicks : originTicks + 3_600) });
    }
  }

  emit(data: any) {
    for (const listener of this.listeners.get('message') ?? []) listener({ data });
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

test('disposing a partially indexed FFmpeg source releases target-index waiters', async () => {
  const worker = new DelayedIndexWorker();
  const source = await openWith(worker);
  const waiting = source.ensureIndexed!(50_000);
  source.dispose();
  await assert.rejects(waiting, /媒体已释放/);
  assert.equal(worker.terminated, true);
});
