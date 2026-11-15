import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { liveHeap } from '../../shared/wasm/core.ts';
import { checkedHeap } from '../../src/media/decoding/flv-decoder.ts';
import { preparePacketThreads } from '../../src/media/policy/packet-threads.ts';
import { fallbackDecodeThreads, reserveFallbackThreads } from '../../src/media/decoding/fallback-runtime.ts';
import { decodeThreadsForCodec, setVvcFrameContextCount, setVvcThreadCount } from '../../src/media/policy/wasm-threads.ts';

test('fallback reservations recover released headroom and roll back failed or disposed growth', t => {
  t.mock.getter(Navigator.prototype, 'hardwareConcurrency', () => 8);
  const old = reserveFallbackThreads('auto'), incoming = reserveFallbackThreads('auto');
  try {
    assert.equal(incoming.threads.general, 1);
    assert.equal(incoming.grow(), undefined, 'a live old source still owns its budget');
    old.release();
    const failed = incoming.grow()!;
    assert.equal(failed.threads.general, 4);
    assert.equal(failed.threads.vvc, 6);
    failed.rollback(); failed.rollback();
    assert.equal(incoming.threads.general, 1);
    const restored = incoming.grow()!;
    assert.equal(restored.threads.general, 4);
    assert.equal(incoming.grow(), undefined, 'successful growth is not reserved a second time');
    incoming.release();
    restored.rollback();
    const fresh = reserveFallbackThreads('auto');
    assert.equal(fresh.threads.general, 4, 'late rollback cannot resurrect a disposed reservation');
    fresh.release();
    assert.equal(incoming.grow(), undefined);
    const single = reserveFallbackThreads('single-thread');
    assert.equal(single.grow(), undefined);
    single.release();
  } finally { old.release(); incoming.release(); }
});

test('a lightweight track releases surplus capacity and can only recover up to two threads', t => {
  t.mock.getter(Navigator.prototype, 'hardwareConcurrency', () => 8);
  const first = reserveFallbackThreads('auto'), incoming = reserveFallbackThreads('auto');
  try {
    incoming.limitToLightSource();
    assert.equal(incoming.threads.vvc, 1);
    first.limitToLightSource();
    assert.deepEqual(incoming.grow()?.threads, { general: 2, vvc: 2, vvcFrameContexts: 2 });
    first.release();
    assert.equal(incoming.grow(), undefined);
    const other = reserveFallbackThreads('auto');
    try { assert.equal(other.threads.vvc, 3); } finally { other.release(); }
  } finally { first.release(); incoming.release(); }
});

test('light playback uses cadence, initial layout and one slice and reuses its packet read', async () => {
  // 960×540 x264 High SPS/PPS and a length-prefixed IDR slice header.
  const description = Buffer.from('0164001fffe1001a6764001facd940f0117ef0110000030001000003003c0f18319601000668eae3cb22c0fdf8f800', 'hex');
  const slice = Buffer.from('000000026580', 'hex');
  const packets = [0, 33333].map((pts, i) => ({ pts, dts: pts, offset: i * slice.length, size: slice.length, key: !i }));
  const index = { codec: 'h264' as const, description, packets, durations: [33333,33333], order: [0,1], duration: 66666, firstPts: 0 };
  const manual = { general: 4, vvc: 5, vvcFrameContexts: 3 };
  const auto = { ...manual, selectForSource: true, vvcTuning: { threads: 8, contexts: 8 } };
  let reads = 0;
  const read = async () => { reads++; return slice; };
  const plan = await preparePacketThreads(index, true, auto, read);
  assert.deepEqual(plan.budget, { general: 2, vvc: 2, vvcFrameContexts: 2 });
  assert.equal(await plan.read(packets[0]), slice);
  assert.equal(reads, 1);
  assert.equal((await preparePacketThreads(index, true, manual, read)).budget, manual);
  const prefix = await preparePacketThreads(index, false, auto, read);
  assert.equal(prefix.singleSliceLayout, true);
  assert.equal(prefix.lightweight, false);
  assert.equal((await preparePacketThreads({ ...index, durations: [16667,16667] }, true, auto, read)).lightweight, false);
  assert.equal((await preparePacketThreads({ ...index, configurations: [description, description] }, true, auto, read)).lightweight, false);
  assert.equal(reads, 2);
  const multi = await preparePacketThreads(index, true, auto, async () => Buffer.concat([slice, slice]));
  assert.equal(multi.lightweight, false);
});

test('fallback growth shares free CPU headroom without shrinking or borrowing another live reservation', t => {
  t.mock.getter(Navigator.prototype, 'hardwareConcurrency', () => 12);
  const old = reserveFallbackThreads('auto'), peer = reserveFallbackThreads('auto'), incoming = reserveFallbackThreads('auto');
  try {
    assert.equal(incoming.threads.general, 1);
    old.release();
    const growth = incoming.grow()!;
    assert.equal(growth.threads.general, 4);
    assert.equal(peer.threads.general, 4);
    assert.ok(peer.threads.vvc + growth.threads.vvc <= 10, 'two presentation CPU cores remain outside the shared budget');
  } finally { old.release(); peer.release(); incoming.release(); }
});

test('VVC automatic settings share CPU headroom and explicit tuning bypasses the automatic limits', t => {
  const cpu = t.mock.getter(Navigator.prototype, 'hardwareConcurrency', () => 12);
  setVvcThreadCount('auto');
  const first = reserveFallbackThreads(), second = reserveFallbackThreads();
  try {
    assert.equal(decodeThreadsForCodec(first.threads, 'vvc'), 6);
    assert.equal(decodeThreadsForCodec(first.threads, 'hevc'), 4);
    assert.equal(decodeThreadsForCodec(second.threads, 'vvc'), 4);
    assert.equal(first.threads.vvcFrameContexts, 6);
  } finally { first.release(); second.release(); }
  setVvcThreadCount('14');
  setVvcFrameContextCount('18');
  const manual = reserveFallbackThreads('manual');
  try {
    manual.limitToLightSource();
    assert.equal(decodeThreadsForCodec(manual.threads, 'vvc'), 14);
    assert.equal(manual.threads.vvcFrameContexts, 18);
  } finally { manual.release(); }
  for (const mode of ['auto', 'auto-grow', 'single-thread'] as const) {
    const reservation = reserveFallbackThreads(mode);
    const expected = mode === 'single-thread' ? 1 : 6;
    try {
      assert.equal(reservation.threads.vvc, expected);
      assert.equal(reservation.threads.vvcFrameContexts, expected);
    } finally { reservation.release(); }
  }
  setVvcThreadCount('auto');
  setVvcFrameContextCount('auto');
  cpu.mock.mockImplementation(() => 4);
  const lowCpu = reserveFallbackThreads();
  try {
    assert.equal(decodeThreadsForCodec(lowCpu.threads, 'vvc'), 2);
    assert.equal(lowCpu.threads.vvcFrameContexts, 2);
    const growing = fallbackDecodeThreads(lowCpu.threads, 'voidplayer-core-mt.js', 'auto-grow');
    assert.deepEqual(growing, { ...lowCpu.threads, vvcTuning: { contexts: 12, threads: 4 } });
    assert.equal(fallbackDecodeThreads(lowCpu.threads, 'voidplayer-core.js', 'auto-grow'), 1);
    assert.equal(fallbackDecodeThreads(lowCpu.threads, 'voidplayer-core-mt.js', 'auto'), lowCpu.threads);
  }
  finally { lowCpu.release(); setVvcThreadCount('auto'); }
  cpu.mock.mockImplementation(() => 2);
  const growing = reserveFallbackThreads('auto-grow'), replacement = reserveFallbackThreads('auto-grow');
  try {
    assert.deepEqual([growing.threads.vvc, growing.threads.vvcFrameContexts], [2, 2]);
    assert.deepEqual([replacement.threads.vvc, replacement.threads.vvcFrameContexts], [2, 2]);
  } finally { growing.release(); replacement.release(); }
});

for (const shared of [false, true]) test(`live WASM heap survives ${shared ? 'other-thread shared' : 'detached nonshared'} memory growth`, async () => {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 4, shared });
  const heap = liveHeap(memory), old = heap(); old[16] = 42;
  if (shared) {
    const worker = new Worker("const {parentPort,workerData}=require('node:worker_threads'); workerData.grow(2); parentPort.postMessage('grown');", { eval: true, workerData: memory });
    try { await new Promise<void>((resolve, reject) => { worker.once('message', () => resolve()); worker.once('error', reject); }); }
    finally { await worker.terminate(); }
    assert.equal(old.byteLength, 65536); // Valid but too short, just like stale Module.HEAPU8.
  } else { memory.grow(2); assert.equal(old.byteLength, 0); }
  assert.equal(heap().byteLength, 3*65536); assert.equal(heap()[16], 42);
  checkedHeap(heap(), 2*65536, 4, '测试写入').set([1,2,3,4], 2*65536);
  assert.deepEqual([...new Uint8Array(memory.buffer, 2*65536, 4)], [1,2,3,4]);
  assert.throws(() => checkedHeap(heap(), 3*65536, 1, '越界'), /内存范围无效/);
});
