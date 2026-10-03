import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReviewSession } from '../../src/session.ts';
import { getColorMode, getReferenceDecode, setColorMode, setReferenceDecode, type ColorMode, type ReferenceDecode } from '../../src/color-mode.ts';
import { rgbaDescription } from '../../src/frame-description.ts';
import { getLogEvents } from '../../src/log.ts';
import type { DecodedFrame, MediaSource } from '../../src/media.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
const initialDecode: ReferenceDecode = { decoder: 'software', depth: 2 };
function fixture(name: string) {
  let mode: ColorMode = 'browser', disposed = 0, closed = 0;
  const calls = { frame: 0, reconfigure: [] as ColorMode[] };
  const frame = (ptsUs: number): DecodedFrame => ({
    ptsUs, sourcePtsUs: ptsUs + 300000, durationUs: 40000,
    description: rgbaDescription(10, 10), kind: 'video-sample', width: 10, height: 10, byteSize: 400,
    close() { closed++; },
  });
  const source: MediaSource = {
    info: { id: name, name, size: 10, lastModified: 0, codec: 'test', decoder: 'webcodecs', width: 10, height: 10, firstPtsUs: 300000, durationUs: 200000 },
    async reconfigureColorMode(next) {
      calls.reconfigure.push(next);
      if (disposed) throw new Error('disposed source was reconfigured');
      mode = next; source.info.decoder = next === 'reference' ? 'ffmpeg-wasm' : 'webcodecs';
    },
    async frameAt(ptsUs) {
      calls.frame++;
      if (disposed) throw new Error('disposed source was decoded');
      return frame(ptsUs);
    },
    async framesAfter() { return []; },
    async *framesFrom(ptsUs) { yield await source.frameAt(ptsUs); },
    dispose() { disposed++; },
  };
  return { source, frame, calls, get mode() { return mode; }, get disposed() { return disposed; }, get closed() { return closed; } };
}
async function sessionTest(work: (session: ReviewSession, drawn: Array<{ slot: string; ptsUs: number }>) => Promise<void>) {
  const previousMode = getColorMode(), previousDecode = getReferenceDecode();
  setColorMode('browser'); setReferenceDecode(initialDecode);
  const drawn: Array<{ slot: string; ptsUs: number }> = [];
  const session = new ReviewSession((slot, frame) => drawn.push({ slot, ptsUs: frame.ptsUs }));
  try { await work(session, drawn); }
  finally { await session.dispose(); setColorMode(previousMode); setReferenceDecode(previousDecode); }
}

for (const reconfigurable of [true, false]) test(`failed ${reconfigurable ? 'in-place' : 'reopened'} tracks do not block healthy color/decode changes or lose failure/annotation anchors`, async () => {
  await sessionTest(async session => {
    const failed = fixture('failed'), healthy = fixture('healthy');
    if (!reconfigurable) delete failed.source.reconfigureColorMode;
    let failedOpens = 0;
    await session.load('A', async () => { failedOpens++; return failed.source; });
    await session.load('B', async () => healthy.source);
    await session.setTrackOffset('B', 10000); await session.seek(50000);
    session.addMark({ slot: 'B', text: 'keep color anchor' });
    failed.source.ensureIndexed = async () => { throw new Error('synthetic track failure'); };
    await session.seek(50000);
    const before = session.getState(), failedCalls = structuredClone(failed.calls);
    assert.equal(failed.disposed, 1);
    await session.setColorMode('reference', { decoder: 'software', depth: 4 });
    await session.setReferenceDecode({ decoder: 'hardware', depth: 8 });
    await session.setColorMode('browser');
    const after = session.getState();
    assert.deepEqual(failed.calls, failedCalls, 'disposed failed source is never called again');
    assert.equal(failedOpens, 1, 'a failed track is not implicitly reopened by color settings');
    assert.deepEqual(after.tracks[0], before.tracks[0]);
    assert.equal(after.positionUs, before.positionUs);
    assert.equal(after.tracks[1].offsetUs, 10000);
    assert.equal(after.tracks[1].id, before.tracks[1].id);
    assert.deepEqual(after.marks, before.marks);
    assert.equal(healthy.mode, after.colorMode);
    assert.equal(after.resources.totalBytes, 0);
  });
});

test('source rollback failure is diagnosed and isolated while peers restore and can switch again', async () => {
  await sessionTest(async session => {
    const broken = fixture('broken-rollback'), healthy = fixture('prepare-failure');
    let failPrepare = true;
    const configureBroken = broken.source.reconfigureColorMode!;
    broken.source.reconfigureColorMode = async (...args) => {
      if (args[0] === 'browser') throw new Error('synthetic rollback failure');
      return configureBroken(...args);
    };
    const configureHealthy = healthy.source.reconfigureColorMode!;
    healthy.source.reconfigureColorMode = async (...args) => {
      if (args[0] === 'reference' && failPrepare) throw new Error('synthetic prepare failure');
      return configureHealthy(...args);
    };
    await session.load('A', async () => broken.source);
    await session.load('B', async () => healthy.source);
    await session.seek(40000); session.addMark({ slot: 'B', text: 'rollback anchor' });
    const before = session.getState(), cursor = getLogEvents({ limit: 2000 }).lastSeq;
    await assert.rejects(session.setColorMode('reference'), /synthetic prepare failure/);
    const after = session.getState();
    assert.equal(after.colorMode, 'browser'); assert.deepEqual(after.referenceDecode, initialDecode);
    assert.match(after.tracks[0].failure?.message ?? '', /synthetic rollback failure/);
    assert.match(after.error ?? '', /synthetic rollback failure/);
    assert.equal(broken.disposed, 1); assert.equal(healthy.disposed, 0);
    assert.equal(healthy.mode, 'browser'); assert.equal(after.tracks[1].decoder, 'webcodecs');
    assert.equal(after.tracks[1].failure, undefined);
    assert.equal(after.positionUs, before.positionUs); assert.deepEqual(after.marks, before.marks);
    assert.equal(after.resources.totalBytes, 0);
    const events = getLogEvents({ sinceSeq: cursor, limit: 2000 }).events;
    assert.ok(events.some(event => event.msg === '色彩模式回滚失败' && (event.data as { slot?: string }).slot === 'A'));
    failPrepare = false; await session.setColorMode('reference');
    assert.equal(healthy.mode, 'reference'); assert.equal(broken.disposed, 1);
  });
});

test('rollback redraw failure disables only the broken source and closes prepared frames', async () => {
  await sessionTest(async session => {
    const broken = fixture('redraw-failure'), healthy = fixture('redraw-peer');
    await session.load('A', async () => broken.source);
    await session.load('B', async () => healthy.source);
    broken.source.frameAt = async () => {
      if (broken.mode === 'reference') throw new Error('synthetic prepare decode failure');
      throw new Error('synthetic rollback redraw failure');
    };
    const cursor = getLogEvents({ limit: 2000 }).lastSeq;
    await assert.rejects(session.setColorMode('reference'), /synthetic prepare decode failure/);
    const state = session.getState();
    assert.match(state.tracks[0].failure?.message ?? '', /synthetic rollback redraw failure/);
    assert.equal(state.tracks[1].failure, undefined); assert.equal(healthy.disposed, 0);
    assert.equal(broken.disposed, 1); assert.equal(state.resources.totalBytes, 0);
    assert.ok(getLogEvents({ sinceSeq: cursor, limit: 2000 }).events.some(event => event.msg === '色彩模式回滚失败'));
  });
});

test('presentation rollback errors still restore sources and explicitly isolate affected tracks', async () => {
  await sessionTest(async session => {
    const source = fixture('presentation-rollback');
    await session.load('A', async () => source.source);
    let calls = 0;
    session.onColorModeChange = async () => { throw new Error(++calls === 1 ? 'presentation prepare failure' : 'presentation rollback failure'); };
    await assert.rejects(session.setColorMode('reference'), /presentation prepare failure/);
    const state = session.getState();
    assert.equal(state.colorMode, 'browser'); assert.equal(source.mode, 'browser');
    assert.match(state.tracks[0].failure?.message ?? '', /presentation rollback failure/);
    assert.equal(source.disposed, 1); assert.equal(state.resources.totalBytes, 0);
    assert.equal(source.closed, 2, 'load and prepared frames each close once');
  });
});

test('cancelled prepared frames close late without overwriting a subsequent color switch', async () => {
  await sessionTest(async (session, drawn) => {
    const old = fixture('old'), late = fixture('late'), fresh = fixture('fresh');
    delete old.source.reconfigureColorMode; delete late.source.reconfigureColorMode; delete fresh.source.reconfigureColorMode;
    const entered = deferred<void>(), pending = deferred<DecodedFrame>();
    late.source.frameAt = async () => { entered.resolve(); return pending.promise; };
    let opens = 0;
    await session.load('A', async () => [old, late, fresh][opens++].source);
    await session.seek(40000); session.addMark({ slot: 'A', text: 'late frame anchor' });
    const before = session.getState();
    const switching = session.setColorMode('reference'), rejected = assert.rejects(switching, { name: 'AbortError' });
    await entered.promise; session.pause(); await rejected;
    await session.setColorMode('reference');
    const count = drawn.length;
    pending.resolve(late.frame(120000)); await turn();
    assert.equal(drawn.length, count); assert.equal(late.closed, 1); assert.equal(late.disposed, 1);
    const after = session.getState();
    assert.equal(after.positionUs, before.positionUs); assert.deepEqual(after.marks, before.marks);
    assert.equal(after.tracks[0].id, before.tracks[0].id); assert.equal(after.resources.totalBytes, 0);
  });
});

test('new seek cancels a rollback redraw wait and a late old frame never commits', async () => {
  await sessionTest(async (session, drawn) => {
    const source = fixture('cancel-redraw');
    await session.load('A', async () => source.source);
    await session.seek(40000);
    const entered = deferred<void>(), pending = deferred<DecodedFrame>();
    source.source.reconfigureColorMode = async mode => { if (mode === 'reference') throw new Error('prepare failure before redraw'); };
    const original = source.source.frameAt;
    let hold = true;
    source.source.frameAt = async ptsUs => {
      if (ptsUs === 40000 && hold) { entered.resolve(); return pending.promise; }
      return original(ptsUs);
    };
    const switching = session.setColorMode('reference'), rejected = assert.rejects(switching, /prepare failure/);
    await entered.promise; hold = false;
    const seek = session.seek(120000);
    const early = await Promise.race([seek.then(() => true), turn().then(() => false)]);
    const count = drawn.length;
    pending.resolve(source.frame(40000)); await rejected; await seek; await turn();
    assert.equal(early, true, 'rollback redraw must release the queue on a newer intent');
    assert.equal(drawn.length, count, 'late rollback frame is closed rather than painted');
    assert.equal(session.getState().positionUs, 120000);
    assert.equal(session.getState().tracks[0].failure, undefined);
    assert.equal(session.getState().resources.totalBytes, 0);
  });
});


test('missing references retain their failure and anchors until relinking under the new color settings', async () => {
  await sessionTest(async session => {
    const missing = fixture('missing'), healthy = fixture('healthy-relink');
    await session.load('A', async () => missing.source);
    await session.load('B', async () => healthy.source);
    await session.setTrackOffset('A', 10000); await session.seek(50000);
    session.addMark({ slot: 'A', text: 'missing reference anchor' });
    const workspace = session.exportWorkspace('http://localhost/');
    const survivor = fixture('healthy-relink');
    await session.restoreWorkspace(workspace, async info => {
      if (info.id === missing.source.info.id) throw new Error('missing file');
      return survivor.source;
    }, { allowUnavailable: true });
    const before = session.getState();
    await session.setColorMode('reference', { decoder: 'software', depth: 4 });
    assert.deepEqual(session.getState().tracks[0], before.tracks[0]);
    const restored = fixture('missing');
    await session.relinkTrack('A', async () => {
      assert.equal(getColorMode(), 'reference');
      assert.deepEqual(getReferenceDecode(), { decoder: 'software', depth: 4 });
      await restored.source.reconfigureColorMode!('reference', getReferenceDecode());
      return restored.source;
    });
    const after = session.getState();
    assert.equal(after.tracks[0].failure, undefined); assert.equal(after.tracks[0].pendingRelink, undefined);
    assert.equal(after.tracks[0].id, before.tracks[0].id); assert.equal(after.tracks[0].offsetUs, 10000);
    assert.equal(after.positionUs, before.positionUs); assert.deepEqual(after.marks, before.marks);
    assert.equal(restored.mode, after.colorMode); assert.equal(after.resources.totalBytes, 0);
  });
});
