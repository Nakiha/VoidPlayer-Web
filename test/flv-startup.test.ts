import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demuxFlv, scanFlv, FlvReader } from '../src/flv-demux.ts';
import { serializeFlvIndex, parseFlvIndex } from '../src/flv-index-cache.ts';
import { WorkerRpc } from '../src/ffmpeg-media.ts';

import { syntheticFlv } from './flv-fixture.ts';

test('FLV startup stops at one packet; background scan resumes and produces the exact full index', async () => {
  const file = new Blob([syntheticFlv()]); const reader = new FlvReader({ file });
  const checkpoint = await scanFlv(reader, undefined, undefined, true);
  assert.equal(checkpoint.complete, false); assert.equal(checkpoint.index.packets.length, 1);
  assert.ok(checkpoint.nextOffset < 1024);
  const resumed = await scanFlv(reader, undefined, checkpoint); reader.close();
  const fresh = new FlvReader({ file });
  try { assert.deepEqual(resumed.index, await demuxFlv(fresh)); } finally { fresh.close(); }
  assert.equal(resumed.complete, true);
  const document = serializeFlvIndex(resumed.index, file.size);
  assert.deepEqual(parseFlvIndex(document, file.size), resumed.index);
  for (const bad of [{ ...document, schema: 99 }, { ...document, size: file.size + 1 }, { ...document, packets: [[file.size, 100, 0, 0, 1]] }, { ...document, packets: document.packets.slice().reverse() }]) {
    assert.throws(() => parseFlvIndex(bad, file.size));
  }
});

test('index deadlines renew on actual progress; core deadlines remain absolute', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let receive!: (event: { data: unknown }) => void, terminated = 0;
  const worker = { addEventListener(type: string, fn: typeof receive) { if (type === 'message') receive = fn; }, postMessage() {}, terminate() { terminated++; } } as unknown as Worker;
  const rpc = new WorkerRpc(worker);
  const index = rpc.call<number>('prepare', {}, [], 60000, true);
  for (let i = 0; i < 3; i++) { t.mock.timers.tick(59000); receive({ data: { id: 1, type: 'progress', progress: 'index' } }); }
  assert.equal(terminated, 0);
  receive({ data: { id: 1, ok: true, data: 12 } }); assert.equal(await index, 12);
  const init = rpc.call('init', {}, [], 10000); const rejected = assert.rejects(init, /超时/);
  t.mock.timers.tick(9000); receive({ data: { id: 2, type: 'progress', progress: 'decoder' } });
  t.mock.timers.tick(1000); await rejected; assert.equal(terminated, 1);
});

test('remote scan coalesces requests while normal reads stay small and version-pinned', async t => {
  const file = syntheticFlv(), ranges: [number, number][] = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, options: RequestInit) => {
    const [, a, b] = /^bytes=(\d+)-(\d+)$/.exec((options.headers as Record<string, string>).Range)!;
    ranges.push([+a, +b]); return new Response(file.subarray(+a, +b + 1), { status: 206, headers: { 'content-range': `bytes ${a}-${b}/${file.length}`, etag: '"v1"' } });
  });
  const reader = new FlvReader({ url: 'https://example.invalid/a', size: file.length });
  try {
    const checkpoint = await scanFlv(reader, undefined, undefined, true);
    assert.equal(ranges.length, 1); assert.equal(ranges[0][1] - ranges[0][0] + 1, 65536);
    reader.setIndexing(true); const full = await scanFlv(reader, undefined, checkpoint); assert.equal(full.complete, true);
    assert.ok(ranges.every(([a, b]) => b - a + 1 <= 1024 * 1024));
    assert.equal(reader.version.validator, '"v1"');
  } finally { reader.close(); }
});

test('a timed-out multithread decoder reuses the startup checkpoint without restarting inspection', async t => {
  const { openPacketMedia } = await import('../src/packet-media.ts');
  const saved = ['document', 'crossOriginIsolated'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { baseURI: 'https://example.invalid/' } });
  Object.defineProperty(globalThis, 'crossOriginIsolated', { configurable: true, value: true });
  t.after(() => { for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const file = new Blob([syntheticFlv()]), reader = new FlvReader({ file });
  const prepared = { ...await scanFlv(reader, undefined, undefined, true), version: {} }; reader.close();
  const messages: { worker: number; type: string; prepared?: unknown }[] = []; let workers = 0, terminated = 0;
  const factory = () => {
    const worker = ++workers; let receive!: (e: { data: unknown }) => void;
    return { addEventListener(type: string, fn: typeof receive) { if (type === 'message') receive = fn; }, terminate() { terminated++; },
      postMessage(message: { id: number; type: string; prepared?: unknown }) {
        messages.push({ worker, ...message });
        const result = message.type === 'prepare' ? prepared : message.type === 'native' ? null : worker === 2 ? {
          codec: 'h264', decoder: 'ffmpeg-wasm', width: 320, height: 180, firstPtsUs: 0, durationUs: 80000, times: [0, 40000], durations: [40000, 40000], indexState: 'building',
        } : undefined;
        if (result !== undefined) queueMicrotask(() => receive({ data: { id: message.id, ok: true, data: result } }));
      } } as unknown as Worker;
  };
  const loading = openPacketMedia('flv', { file }, { name: 'test.flv', size: file.size, lastModified: 0 }, { workerFactory: factory });
  await new Promise<void>(r => setImmediate(r));
  assert.deepEqual(messages.map(m => m.type), ['prepare', 'native', 'init']);
  t.mock.timers.tick(10000);
  const source = await loading;
  assert.equal(workers, 2); assert.equal(terminated, 1); assert.equal(source.info.coreVariant, 'single-thread');
  assert.deepEqual(messages.at(-1)!.prepared, prepared);
  assert.equal(messages.filter(m => m.type === 'prepare').length, 1);
  source.dispose(); assert.equal(terminated, 2);
});

test('background index failure during a yielded frame rejects playback instead of reporting EOF', async t => {
  const { openPacketMedia } = await import('../src/packet-media.ts');
  const { rgbaDescription } = await import('../src/frame-description.ts');
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { baseURI: 'https://example.invalid/' } });
  t.after(() => { if (saved) Object.defineProperty(globalThis, 'document', saved); else Reflect.deleteProperty(globalThis, 'document'); });
  const file = new Blob([syntheticFlv()]), reader = new FlvReader({ file });
  const prepared = { ...await scanFlv(reader, undefined, undefined, true), version: {} }; reader.close();
  const calls: string[] = [];
  const factory = () => {
    let receive!: (e: { data: unknown }) => void;
    return { addEventListener(type: string, fn: typeof receive) { if (type === 'message') receive = fn; }, terminate() {},
      postMessage(m: { id: number; type: string }) {
        calls.push(m.type);
        const data = m.type === 'prepare' ? prepared : m.type === 'native' ? {
          codec: 'h264', decoder: 'webcodecs', width: 2, height: 2, firstPtsUs: 0, durationUs: 40000, times: [0], durations: [40000], indexState: 'building',
        } : m.type === 'at' ? { pts: 0, width: 2, height: 2, pixels: new ArrayBuffer(16), description: rgbaDescription(2, 2) } : null;
        queueMicrotask(() => receive({ data: m.type === 'complete-index'
          ? { id: m.id, ok: false, stage: 'container', error: 'test corrupt index' }
          : { id: m.id, ok: true, data } }));
      } } as unknown as Worker;
  };
  const source = await openPacketMedia('flv', { file }, { name: 'bad.flv', size: file.size, lastModified: 0 }, { workerFactory: factory });
  try {
    const iterator = source.framesFrom(0);
    const first = await iterator.next(); assert.equal(first.done, false); first.value!.close();
    await assert.rejects(source.ensureIndexed!(), /test corrupt index/);
    assert.equal(source.info.indexState, 'error');
    await assert.rejects(iterator.next(), /test corrupt index/);
    assert.ok(!calls.includes('next'), 'never confuse an incomplete index with decoder EOF');
  } finally { source.dispose(); }
});


test('scanner publishes immutable validated prefixes while the next range is blocked', async () => {
  const file = new Blob([syntheticFlv()]), reader = new FlvReader({ file });
  const startup = await scanFlv(reader, undefined, undefined, true);
  const read = reader.read.bind(reader);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  reader.read = async (offset, size) => { if (offset > 65536) await gate; return read(offset, size); };
  const prefixes: import('../src/flv-demux.ts').FlvCheckpoint[] = [];
  const scan = scanFlv(reader, undefined, startup, false, prefix => prefixes.push(prefix));
  try {
    await new Promise(resolve => setTimeout(resolve, 650));
    assert.equal(prefixes.length, 1);
    assert.equal(prefixes[0].complete, false);
    assert.equal(prefixes[0].index.packets.length, 3);
    assert.ok(prefixes[0].index.duration > startup.index.duration);
    release(); const complete = await scan;
    assert.equal(complete.index.packets.length, 4);
    assert.equal(prefixes[0].index.packets.length, 3, 'future scan must not mutate a published packet array');
  } finally { release(); await scan; reader.close(); }
});
