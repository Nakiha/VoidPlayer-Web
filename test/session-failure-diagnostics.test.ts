import { rgbaDescription } from '../src/frame-description.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReviewSession } from '../src/session.ts';
import type { MediaSource } from '../src/media.ts';

// 与 session.test.ts 相同的轻量片源替身。
function media(name = 'A', starts = [0, 40000, 120000, 160000], end = 200000) {
  const frame = (pts: number) => ({
    ptsUs: pts, sourcePtsUs: pts + 300000, durationUs: (starts[starts.indexOf(pts) + 1] ?? end) - pts,
    description: rgbaDescription(10, 10), kind: 'video-sample' as const, width: 10, height: 10, byteSize: 400, close() {},
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
    dispose() {},
  };
  return { source };
}

test('track failure snapshot carries failure message and pendingRelink', async () => {
  const { getLogEvents } = await import('../src/log.ts');
  const fixture = media('failure-diagnostics');
  fixture.source.framesFrom = async function* () {
    yield await fixture.source.frameAt(0);
    throw new Error('synthetic mid-stream failure');
  };
  const session = new ReviewSession(() => {});
  try {
    await session.load('A', async () => fixture.source);
    const cursor = getLogEvents({ limit: 2000 }).lastSeq;
    await session.play();
    for (let i = 0; i < 100 && !session.getState().tracks[0]?.failure; i++) await new Promise(r => setTimeout(r, 5));
    assert.match(session.getState().tracks[0].failure!.message, /synthetic mid-stream failure/);
    const events = getLogEvents({ sinceSeq: cursor, limit: 2000 }).events;
    const snapshot = events.find(e => e.msg === '故障现场：轨道')?.data as Record<string, unknown>;
    assert.ok(snapshot, 'failure captures a per-track snapshot');
    assert.match(String((snapshot.failure as { message: string } | null)?.message), /synthetic mid-stream failure/,
      '快照必须带上未被截断的失败原因，供事后定位');
    assert.equal(snapshot.pendingRelink, false, '快照必须区分播放中途失败与待重新关联');
  } finally { await session.dispose(); }
});
