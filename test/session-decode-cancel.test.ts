import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReviewSession } from '../src/session.ts';
import { rgbaDescription } from '../src/frame-description.ts';
import type { MediaSource } from '../src/media.ts';

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

function media(name = 'A', starts = [0, 40000, 120000, 160000], end = 200000) {
  let closed = 0, disposed = 0;
  const frame = (pts: number) => ({
    ptsUs: pts, sourcePtsUs: pts + 300000, durationUs: (starts[starts.indexOf(pts) + 1] ?? end) - pts,
    description: rgbaDescription(10, 10), kind: 'video-sample' as const, width: 10, height: 10, byteSize: 400, close() { closed++; },
  });
  const source: MediaSource = {
    info: { id: name, name, size: 10, lastModified: 0, codec: 'test', decoder: 'webcodecs', width: 10, height: 10, firstPtsUs: 300000, durationUs: end },
    async frameAt(time) {
      const i = Math.max(0, starts.findLastIndex(t => t <= time));
      return frame(starts[i]);
    },
    async framesAfter(pts, count) { return starts.filter(t => t > pts).slice(0, count).map(frame); },
    async *framesFrom(pts) {
      for (let i = Math.max(0, starts.findLastIndex(t => t <= pts)); i < starts.length; i++) yield frame(starts[i]);
    },
    dispose() { disposed++; },
  };
  return { source, get closed() { return closed; }, get disposed() { return disposed; } };
}

test('REVIEW-03: 旧 seek 阻塞时，无需解码的 removeTrack 能先启动并完成', async () => {
  const session = new ReviewSession(() => {});
  const a = media('A');
  const b = media('B');
  await session.load('A', async () => a.source);
  await session.load('B', async () => b.source);
  await session.seek(40000);

  const releaseOld = deferred<void>();
  let oldCalls = 0;
  const origA = a.source.frameAt.bind(a.source);
  const origB = b.source.frameAt.bind(b.source);
  a.source.frameAt = async time => {
    if (time === 120000) { oldCalls++; await releaseOld.promise; }
    return time === 120000 ? origA(time) : origA(time);
  };
  b.source.frameAt = async time => {
    if (time === 120000) { oldCalls++; await releaseOld.promise; }
    return origB(time);
  };

  const oldSeek = session.seek(120000);
  const oldRejected = assert.rejects(oldSeek, /取消|取代/);
  // 等旧解码进入等待
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(oldCalls >= 1);

  // 删除 B 后时长仍覆盖当前位置，无需重新解码，应能先启动
  let removeStarted = false;
  const origDispose = b.source.dispose.bind(b.source);
  b.source.dispose = () => { removeStarted = true; origDispose(); };
  const remove = session.removeTrack('B');
  // 新操作应不等旧解码释放就进入工作区（队列已让出）
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(removeStarted, true);
  await remove;
  assert.deepEqual(session.getState().tracks.map(t => t.slot), ['A']);

  releaseOld.resolve();
  await oldRejected;
  // 旧迟到帧不得覆盖新状态：位置仍为删除后的有效值，旧帧已 close
  assert.ok(a.closed >= 1);
  await session.dispose();
});

test('REVIEW-03: 旧 seek 阻塞时，新 seek 可中止旧等待并提交新位置', async () => {
  const drawn: number[] = [];
  const session = new ReviewSession((_, f) => drawn.push(f.ptsUs));
  const m = media('A');
  await session.load('A', async () => m.source);
  const releaseOld = deferred<void>();
  const orig = m.source.frameAt.bind(m.source);
  let lateClosed = 0;
  m.source.frameAt = async time => {
    if (time === 40000) {
      await releaseOld.promise;
      const f = await orig(time);
      const origClose = f.close.bind(f);
      f.close = () => { lateClosed++; origClose(); };
      return f;
    }
    return orig(time);
  };

  const first = session.seek(40000);
  const firstRejected = assert.rejects(first, /取消|取代/);
  await new Promise(resolve => setTimeout(resolve, 10));
  const second = await session.seek(120000);
  assert.equal(second.positionUs, 120000);
  assert.ok(drawn.includes(120000));
  assert.ok(!drawn.includes(40000) || drawn.at(-1) === 120000);
  releaseOld.resolve();
  await firstRejected;
  // 迟到旧帧必须 close，且不得覆盖新位置
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(session.getState().positionUs, 120000);
  assert.ok(lateClosed >= 1);
  await session.dispose();
});

test('REVIEW-03: 前后逐帧的探测等待同样可被新意图中止', async () => {
  const session = new ReviewSession(() => {});
  const m = media('A', [0, 40000, 80000, 120000], 160000);
  await session.load('A', async () => m.source);
  await session.seek(40000);
  const releaseProbe = deferred<void>();
  const origAfter = m.source.framesAfter.bind(m.source);
  m.source.framesAfter = async (pts, count) => {
    await releaseProbe.promise;
    return origAfter(pts, count);
  };
  const stepping = session.step(1);
  const stepRejected = assert.rejects(stepping, /取消|取代/);
  await new Promise(resolve => setTimeout(resolve, 10));
  // 新 seek 应能中止旧 step 的探测等待
  const seeked = await session.seek(0);
  assert.equal(seeked.positionUs, 0);
  releaseProbe.resolve();
  await stepRejected;
  await session.dispose();
});
