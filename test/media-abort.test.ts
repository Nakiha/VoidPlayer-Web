import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { abortableWait } from '../src/media-abort.ts';
import { firstDecodableSample, MediaOpenError } from '../src/media.ts';
import type { VideoSample } from 'mediabunny';
import { openFFmpegMedia } from '../src/ffmpeg-media.ts';
import { openPacketMedia } from '../src/packet-media.ts';

// A capture can begin in a GOP: its first packet timestamp need not have a frame.
test('first-frame probing accepts the first actual frame after a timestamp gap and closes the iterator', async () => {
  const frame = { timestamp: 4.2 } as VideoSample;
  let returned = false;
  const actual = await firstDecodableSample({
    async getSample(time) { assert.ok(time > 4 && time < 4.000001); return null; },
    async *samples(start) { assert.equal(start, 4); try { yield frame; } finally { returned = true; } },
  }, 4);
  assert.equal(actual, frame);
  assert.equal(actual.timestamp, 4.2);
  assert.equal(returned, true);
});

test('first-frame probing preserves a decodable frame without opening a second decoder', async () => {
  const frame = { timestamp: 4 } as VideoSample;
  assert.equal(await firstDecodableSample({
    async getSample() { return frame; },
    async *samples() { assert.fail('must reuse the decoded frame'); },
  }, 4), frame);
});

test('an empty decoded stream fails within the decode stage eligible for WASM fallback', async () => {
  await assert.rejects(firstDecodableSample({
    async getSample() { return null; }, async *samples() {},
  }, 0), error => error instanceof MediaOpenError && error.stage === 'decode');
});

for (const backend of ['ffmpeg', 'packet'] as const) {
  test(`${backend}: aborting stalled initialization terminates its worker without waiting for the timeout`, { timeout: 2000 }, async () => {
    const controller = new AbortController();
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    let terminated = 0, created = 0;
    const worker = { addEventListener() {}, postMessage() { started(); }, terminate() { terminated++; } };
    const deps = { signal: controller.signal, glueURL: 'file:///unused/voidplayer-core.js', workerFactory() { created++; return worker as unknown as Worker; } };
    const file = new File(['not read by the stalled worker'], 'capture.ts');
    const loading = backend === 'ffmpeg' ? openFFmpegMedia(file, deps) : openPacketMedia('mp4', { file }, file, deps);
    const rejected = assert.rejects(loading, { name: 'AbortError' });
    await ready;
    controller.abort();
    await rejected;
    assert.equal(terminated, 1);
    assert.equal(created, 1, 'cancellation must not initialize another core');
  });
}


test('a frame yielded just before iterator cancellation is released when cleanup fails', async () => {
  let closed = 0;
  const frame = { timestamp: 1, close() { closed++; } } as VideoSample;
  await assert.rejects(firstDecodableSample({
    async getSample() { return null; },
    async *samples() { try { yield frame; } finally { throw new DOMException('cancelled', 'AbortError'); } },
  }, 0), { name: 'AbortError' });
  assert.equal(closed, 1);
});

test('B3: abortableWait 成功/失败/取消都清理监听器，不累积', async () => {
  const controller = new AbortController();
  const before = getEventListeners(controller.signal, 'abort').length;
  for (let i = 0; i < 1000; i++) {
    assert.equal(await abortableWait(Promise.resolve(i), controller.signal), i);
  }
  assert.equal(getEventListeners(controller.signal, 'abort').length, before);
  for (let i = 0; i < 50; i++) {
    await assert.rejects(abortableWait(Promise.reject(new Error(`boom-${i}`)), controller.signal), /boom/);
  }
  assert.equal(getEventListeners(controller.signal, 'abort').length, before);
});

test('B3: abortableWait 预取消/执行中取消/迟到拒绝', async () => {
  // 预取消：不挂监听器，直接按 reason 拒绝。
  const pre = new AbortController();
  pre.abort(new DOMException('定位已取消。', 'AbortError'));
  const preListeners = getEventListeners(pre.signal, 'abort').length;
  await assert.rejects(abortableWait(Promise.resolve(1), pre.signal), { name: 'AbortError' });
  assert.equal(getEventListeners(pre.signal, 'abort').length, preListeners);
  // 执行中取消：旧反查不得继续，监听器清理。
  const mid = new AbortController();
  let release!: (v: number) => void;
  const gate = new Promise<number>(resolve => { release = resolve; });
  const pending = abortableWait(gate, mid.signal);
  assert.equal(getEventListeners(mid.signal, 'abort').length, 1);
  mid.abort(new DOMException('定位已取消。', 'AbortError'));
  await assert.rejects(pending, { name: 'AbortError' });
  release(1);
  await Promise.resolve();
  assert.equal(getEventListeners(mid.signal, 'abort').length, 0);
  // 取消后迟到的后端拒绝不产生未处理拒绝（已有 catch 即不抛）。
  const late = new AbortController();
  let rejectLate!: (e: unknown) => void;
  const lateCall = new Promise<number>((_, reject) => { rejectLate = reject; });
  const waited = abortableWait(lateCall, late.signal).then(
    () => assert.fail('应已取消'),
    error => error,
  );
  late.abort(new DOMException('定位已取消。', 'AbortError'));
  const abortReason = await waited;
  assert.equal((abortReason as Error).name, 'AbortError');
  rejectLate(new Error('late-backend-failure'));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(getEventListeners(late.signal, 'abort').length, 0);
});
