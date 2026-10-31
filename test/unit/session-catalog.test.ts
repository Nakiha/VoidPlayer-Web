import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReviewSession } from '../../src/session.ts';
import { rgbaDescription } from '../../shared/media/frame-description.ts';
import type { MediaSource } from '../../src/media/contract.ts';

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

test('partial workspace restoration logs the full unavailable source reason without losing marks', async () => {
  const { getLogEvents } = await import('../../src/logging/log.ts');
  const source = new ReviewSession(() => {}), restored = new ReviewSession(() => {});
  try {
    await source.load('A', async () => media('clip').source);
    source.addMark({ slot: 'A', text: 'preserve' });
    const document = source.exportWorkspace('http://localhost/');
    const cursor = getLogEvents({ limit: 2000 }).lastSeq;
    await restored.restoreWorkspace(document, async () => { throw new Error('persistent local file access is unsupported'); }, { allowUnavailable: true });
    const state = restored.getState();
    assert.equal(state.tracks[0].pendingRelink, true);
    assert.equal(state.tracks[0].frame, null);
    assert.deepEqual(state.marks, document.marks);
    const failure = getLogEvents({ sinceSeq: cursor, limit: 2000 }).events.find(event => event.msg === '工作区片源恢复失败，保留轨道待重新关联');
    assert.equal(failure?.level, 'warn');
    assert.equal((failure?.data as { error: string }).error, 'persistent local file access is unsupported');
    assert.equal((failure?.data as { sourceKind: string }).sourceKind, 'local');
  } finally { await source.dispose(); await restored.dispose(); }
});

test('empty workspace restore publishes slots immediately and frames independently without disposing live sources', async () => {
  const original = new ReviewSession(() => {}), restored = new ReviewSession(() => {});
  const a = media('A'), b = media('B');
  let release!: () => void, reached!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), waiting = new Promise<void>(resolve => { reached = resolve; });
  try {
    await original.load('A', async () => media('A').source);
    await original.load('B', async () => media('B').source);
    await original.setTrackOffset('B', 40000);
    original.addMark({ slot: 'A', text: 'retained' });
    const document = original.exportWorkspace('http://localhost/');
    const restore = restored.restoreWorkspace(document, async (info, _signal, progress) => {
      progress('inspect');
      assert.equal(restored.getState().tracks.length, 2, 'all saved slots exist before opening the first file');
      if (info.id === 'B') { reached(); await gate; return b.source; }
      return a.source;
    }, { allowUnavailable: true, progressive: true });
    await waiting;
    const partial = restored.getState();
    assert.equal(partial.busy, true); assert.ok(partial.tracks[0].frame);
    assert.equal(partial.tracks[1].pendingRelink, true);
    assert.equal(partial.mediaLoad?.slot, 'B'); assert.equal(partial.mediaLoad?.state, 'loading');
    assert.deepEqual(partial.marks, document.marks); assert.equal(a.disposed, 0);
    release(); await restore;
    assert.ok(restored.getState().tracks.every(track => track.frame && !track.pendingRelink));
    assert.equal(restored.getState().tracks[1].offsetUs, 40000);
    assert.equal(a.disposed, 0); assert.equal(b.disposed, 0);
    await restored.seek(80000);
  } finally { release?.(); await original.dispose(); await restored.dispose(); }
  assert.equal(a.disposed, 1); assert.equal(b.disposed, 1);
});

test('cancelling progressive restoration preserves presented peers and disposes a late source', async () => {
  const original = new ReviewSession(() => {}), restored = new ReviewSession(() => {});
  const a = media('A'), late = media('B');
  let release!: () => void, reached!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), waiting = new Promise<void>(resolve => { reached = resolve; });
  try {
    await original.load('A', async () => media('A').source); await original.load('B', async () => media('B').source);
    const restoring = restored.restoreWorkspace(original.exportWorkspace('http://localhost/'), async info => {
      if (info.id === 'B') { reached(); await gate; return late.source; } return a.source;
    }, { allowUnavailable: true, progressive: true });
    const rejected = assert.rejects(restoring, error => error instanceof Error && error.name === 'AbortError');
    await waiting; restored.cancelLoad(); await rejected;
    assert.ok(restored.getState().tracks[0].frame); assert.equal(a.disposed, 0);
    assert.equal(restored.getState().mediaLoad?.state, 'cancelled');
    release(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(late.disposed, 1); assert.equal(restored.getState().tracks[1].pendingRelink, true);
    await restored.seek(40000);
  } finally { release?.(); await original.dispose(); await restored.dispose(); }
});
