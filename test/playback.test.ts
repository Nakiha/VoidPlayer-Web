import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FrameQueue } from '../src/playback.ts';
import { assessPlayback } from '../src/benchmark.ts';
import { WorkerRpc } from '../src/ffmpeg-media.ts';
const turn = () => new Promise<void>(r => setTimeout(r, 0));

test('presentation ticks before the next frame cannot bypass queue backpressure', async () => {
  let produced = 0, closed = 0;
  async function* frames() {
    for (let i = 1; i <= 200; i++) {
      produced++;
      yield { ptsUs: i * 100000, sourcePtsUs: i * 100000, durationUs: 100000,
        kind: 'rgba8' as const, width: 1920, height: 1080, byteSize: 1920 * 1080 * 4,
        close() { closed++; } };
    }
  }
  // The display ticks faster than the video's frame rate (also happens while
  // waiting for a slower second track). None of these ticks consumes a frame.
  const q = new FrameQueue(frames());
  try {
    await turn();
    for (let tick = 0; tick < 40; tick++) { assert.equal(q.take(tick * 1000).frame, null); await turn(); }
    assert.equal(produced, 4, 'empty presentation ticks must not allocate more decoded frames');
    assert.equal(q.frames.length, 4);
  } finally { q.stop(); await q.done; }
  assert.equal(closed, produced);
});

test('prefetch is bounded and stopping a full queue releases every frame', async () => {
  let produced = 0, closed = 0, returned = false;
  async function* frames() {
    try { for (let i = 0; i < 100; i++) {
      produced++;
      yield { ptsUs: i, sourcePtsUs: i, durationUs: 1, kind: 'video-sample' as const, width: 10, height: 10, byteSize: 400, close() { closed++; } };
    } } finally { returned = true; }
  }
  const q = new FrameQueue(frames()); await turn();
  assert.equal(produced, 4); assert.equal(q.frames.length, 4);
  const { frame, dropped } = q.take(2); frame!.close();
  assert.equal(dropped, 2);
  await turn(); assert.equal(q.frames.length, 4);
  q.stop(); await q.done;
  assert.equal(closed, produced); assert.equal(returned, true);
});

test('benchmark rejects slow playback and missing or stalled presentation, even with a healthy timeline', () => {
  const healthy = { wallMs: 2000, mediaUs: 2000000, waitingMs: 0, buffers: {}, speed: 1, maxFrameLagUs: 16000, maxFrameSkewUs: 16000,
    tracks: { A: { drawn: 120, dropped: 0, fps: 60, p95GapMs: 17, maxGapMs: 20 } } };
  assert.deepEqual(assessPlayback(healthy, 1, false), []);
  assert.ok(assessPlayback({ ...healthy, speed: .5 }, 1, false).includes('below-realtime'));
  assert.ok(assessPlayback({ ...healthy, maxFrameLagUs: 900000 }, 1, false).includes('frame-lag'));
  assert.ok(assessPlayback({ ...healthy, tracks: {} }, 1, false).includes('no-frames'));
  assert.ok(assessPlayback({ ...healthy, tracks: { A: { ...healthy.tracks.A, maxGapMs: 500 } } }, 1, false).includes('A:presentation-stall'));
  assert.ok(assessPlayback(healthy, 1, true).includes('stale-frame-after-pause'));
});

function workerStub() {
  const listeners: Record<string, (e: unknown) => void> = {};
  let terminated = false;
  const worker = { addEventListener(name: string, fn: (e: unknown) => void) { listeners[name] = fn; }, postMessage() {}, terminate() { terminated = true; } };
  return { rpc: new WorkerRpc(worker as unknown as Worker), get terminated() { return terminated; } };
}
test('a silently wedged worker times out and rejects all pending and future work', async () => {
  const w = workerStub();
  const first = assert.rejects(w.rpc.call('extract', {}, [], 10), /超时/);
  const second = assert.rejects(w.rpc.call('extract', {}, [], 1000), /超时/);
  await Promise.all([first, second]);
  assert.equal(w.terminated, true);
  await assert.rejects(w.rpc.call('extract', {}), /超时/);
});
test('disposing a worker settles outstanding extraction promises', async () => {
  const w = workerStub(); const waiting = assert.rejects(w.rpc.call('extract', {}), /释放/);
  w.rpc.terminate(); await waiting; assert.equal(w.terminated, true);
});

test('frame queue also honors its byte budget, not just the frame count', async () => {
  let produced = 0, closed = 0;
  async function* frames() {
    for (let i = 0; i < 100; i++) {
      produced++;
      yield { ptsUs: i, sourcePtsUs: i, durationUs: 1, kind: 'rgba8' as const, width: 10, height: 10, byteSize: 1000, close() { closed++; } };
    }
  }
  const q = new FrameQueue(frames(), 4, 1000); // 4-frame cap OR 1000 bytes
  await turn();
  assert.equal(produced, 1); // second frame would exceed 1500 bytes
  const { frame } = q.take(0); frame!.close();
  await turn();
  assert.equal(produced, 2);
  q.stop(); await q.done;
  assert.equal(closed, produced);
});
