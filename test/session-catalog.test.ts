import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReviewSession } from '../src/session.ts';
import { rgbaDescription } from '../src/frame-description.ts';
import type { MediaSource } from '../src/media.ts';

function media(name = 'A', starts = [0, 40000, 120000, 160000], end = 200000) {
  let closed = 0, disposed = 0;
  const frame = (pts: number) => ({
    ptsUs: pts, sourcePtsUs: pts + 300000, durationUs: (starts[starts.indexOf(pts) + 1] ?? end) - pts,
    description: rgbaDescription(10,10), kind: 'video-sample' as const, width: 10, height: 10, byteSize: 400, close() { closed++; },
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

test('export excludes catalog entries no longer referenced by tracks or marks', async () => {
  const session = new ReviewSession(() => {});
  try {
    await session.load('A', async () => media('first').source);
    await session.load('B', async () => media('second').source);
    await session.removeTrack('A');
    assert.deepEqual(session.exportWorkspace('http://localhost/').media.map(m => m.id), ['second']);
    // Replacing a track must also drop the previous media id from the catalog.
    await session.load('B', async () => media('replaced').source);
    assert.deepEqual(session.exportWorkspace('http://localhost/').media.map(m => m.id), ['replaced']);
  } finally { await session.dispose(); }
});

test('closed-track media stays in the export while a mark still references it', async () => {
  const session = new ReviewSession(() => {});
  try {
    await session.load('A', async () => media('annotated').source);
    session.addMark({ slot: 'A', text: 'keep' });
    await session.removeTrack('A');
    assert.deepEqual(session.exportWorkspace('http://localhost/').media.map(m => m.id), ['annotated']);
    session.deleteMark(session.getState().marks[0].id);
    assert.deepEqual(session.exportWorkspace('http://localhost/').media.map(m => m.id), []);
  } finally { await session.dispose(); }
});

test('relink accepts a modified-time change but still rejects size or name mismatch', async () => {
  const source = new ReviewSession(() => {}), restored = new ReviewSession(() => {});
  try {
    await source.load('A', async () => media('clip').source);
    const document = source.exportWorkspace('http://localhost/');
    await restored.restoreWorkspace(document, async () => { throw Error('offline'); }, { allowUnavailable: true });
    assert.equal(restored.getState().tracks[0].pendingRelink, true);
    const bigger = media('clip'); bigger.source.info.size = 11;
    await assert.rejects(restored.relinkTrack('A', async () => bigger.source), /不一致/);
    assert.equal(restored.getState().tracks[0].pendingRelink, true);
    const renamed = media('clip'); renamed.source.info.name = 'other.mp4';
    await assert.rejects(restored.relinkTrack('A', async () => renamed.source), /不一致/);
    const modified = media('clip'); modified.source.info.lastModified = 999;
    await restored.relinkTrack('A', async () => modified.source);
    assert.equal(restored.getState().tracks[0].pendingRelink, undefined);
    assert.equal(restored.getState().tracks[0].id, 'clip');
  } finally { await source.dispose(); await restored.dispose(); }
});
