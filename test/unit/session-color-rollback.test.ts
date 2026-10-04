import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReviewSession } from '../../src/session.ts';
import { getColorMode, getReferenceDecode, setColorMode, setReferenceDecode, type ColorMode, type ReferenceDecode } from '../../src/color-mode.ts';
import { getPresentationChannel, setPresentationChannel } from '../../src/presentation-channel.ts';
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

test('workspace opener and presentation rollback failures retain both causes and isolate retained tracks', async () => {
  await sessionTest(async session => {
    const source = fixture('restore-presentation');
    await session.load('A', async () => source.source);
    await session.seek(40000); session.addMark({ slot: 'A', text: 'keep restore anchor' });
    const before = session.getState(), workspace = session.exportWorkspace('http://localhost/');
    workspace.comparison!.colorMode = 'reference';
    const original = new Error('original source open failed'), rollback = new Error('rollback presenter failed');
    let calls = 0;
    session.onColorModeChange = async () => { if (++calls === 2) throw rollback; };
    const cursor = getLogEvents({ limit: 2000 }).lastSeq;
    await assert.rejects(session.restoreWorkspace(workspace, async () => { throw original; }), error => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors[0], original); assert.equal(error.errors[1].cause, rollback);
      return true;
    });
    const after = session.getState();
    assert.equal(after.colorMode, 'browser'); assert.deepEqual(after.referenceDecode, initialDecode);
    assert.match(after.tracks[0].failure?.message ?? '', /rollback presenter failed/);
    assert.match(after.error ?? '', /original source open failed.*rollback presenter failed/);
    assert.equal(after.tracks[0].id, before.tracks[0].id); assert.deepEqual(after.marks, before.marks);
    assert.equal(after.positionUs, before.positionUs); assert.equal(source.disposed, 1);
    assert.equal(after.resources.totalBytes, 0);
    assert.ok(getLogEvents({ sinceSeq: cursor, limit: 2000 }).events.some(event => event.msg === '工作区回滚失败' && (event.data as { phase?: string }).phase === 'presentation'));
    const frameCalls = source.calls.frame;
    await assert.rejects(session.seek(120000), /停用/); assert.equal(source.calls.frame, frameCalls, 'failed source is not decoded again');
    await assert.rejects(session.play(), /停用/);
    await session.load('A', async () => fixture('replacement').source);
    assert.equal(session.getState().tracks[0].failure, undefined);
  });
});

test('workspace rollback redraw failure aggregates the import error and isolates only the affected track', async () => {
  await sessionTest(async session => {
    const broken = fixture('restore-redraw'), healthy = fixture('restore-peer');
    await session.load('A', async () => broken.source); await session.load('B', async () => healthy.source);
    await session.setTrackOffset('B', 10000); await session.seek(50000);
    session.addMark({ slot: 'B', text: 'healthy anchor' });
    const before = session.getState(), workspace = session.exportWorkspace('http://localhost/');
    workspace.comparison!.colorMode = 'reference';
    const original = new Error('import preparation failed'), redraw = new Error('rollback redraw failed');
    broken.source.frameAt = async () => { throw redraw; };
    await assert.rejects(session.restoreWorkspace(workspace, async () => { throw original; }), error => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors[0], original); assert.equal(error.errors[1].cause, redraw);
      return true;
    });
    const after = session.getState();
    assert.match(after.tracks[0].failure?.message ?? '', /rollback redraw failed/);
    assert.equal(after.tracks[1].failure, undefined); assert.equal(healthy.disposed, 0);
    assert.equal(broken.disposed, 1); assert.equal(after.resources.totalBytes, 0);
    assert.equal(after.positionUs, before.positionUs); assert.deepEqual(after.marks, before.marks);
    const frameCalls = broken.calls.frame;
    await session.seek(120000); assert.equal(broken.calls.frame, frameCalls);
    assert.equal(session.getState().tracks[1].frame?.ptsUs, 110000);
    await session.setColorMode('reference'); assert.equal(healthy.mode, 'reference');
  });
});

test('ordinary workspace import failure restores old frames, marks, offsets and presentation channel', async () => {
  await sessionTest(async session => {
    const source = fixture('restore-healthy'), previousChannel = getPresentationChannel();
    setPresentationChannel('y');
    await session.load('A', async () => source.source); await session.seek(40000);
    session.addMark({ slot: 'A', text: 'ordinary rollback' });
    const before = session.getState(), workspace = session.exportWorkspace('http://localhost/');
    workspace.comparison!.colorMode = 'reference'; workspace.viewport.channel = 'u';
    let calls = 0; session.onColorModeChange = async () => { calls++; };
    const original = new Error('ordinary import failure');
    await assert.rejects(session.restoreWorkspace(workspace, async () => { throw original; }), error => error === original);
    const after = session.getState();
    assert.equal(calls, 2); assert.equal(source.disposed, 0); assert.equal(getPresentationChannel(), 'y');
    setPresentationChannel(previousChannel);
    assert.deepEqual(after.tracks, before.tracks); assert.deepEqual(after.marks, before.marks);
    assert.equal(after.positionUs, before.positionUs); assert.equal(after.colorMode, before.colorMode);
    assert.equal(after.resources.totalBytes, 0);
    await session.seek(120000); assert.equal(session.getState().tracks[0].frame?.ptsUs, 120000);
  });
});

test('new seek interrupts workspace rollback redraw; its late frame closes without overwriting new intent', async () => {
  await sessionTest(async (session, drawn) => {
    const source = fixture('restore-cancel-redraw');
    await session.load('A', async () => source.source); await session.seek(40000);
    const workspace = session.exportWorkspace('http://localhost/');
    const entered = deferred<void>(), pending = deferred<DecodedFrame>(), original = source.source.frameAt;
    let hold = true;
    source.source.frameAt = async ptsUs => {
      if (hold) { entered.resolve(); return pending.promise; }
      return original(ptsUs);
    };
    const restoring = session.restoreWorkspace(workspace, async () => { throw new Error('import failure before redraw'); });
    const rejected = assert.rejects(restoring, /import failure before redraw/);
    await entered.promise; hold = false;
    await session.seek(120000); await rejected;
    const count = drawn.length, closed = source.closed;
    pending.resolve(source.frame(40000)); await turn();
    assert.equal(drawn.length, count); assert.equal(source.closed, closed + 1);
    assert.equal(session.getState().positionUs, 120000);
    assert.equal(session.getState().tracks[0].failure, undefined);
    assert.equal(session.getState().resources.totalBytes, 0);
  });
});

test('cancelled workspace preparation closes a late frame, disposes its source, and retains old anchors', async () => {
  await sessionTest(async (session, drawn) => {
    const old = fixture('restore-old'), late = fixture('restore-late');
    await session.load('A', async () => old.source); await session.seek(40000);
    session.addMark({ slot: 'A', text: 'cancelled restore anchor' });
    const before = session.getState(), workspace = session.exportWorkspace('http://localhost/');
    workspace.comparison!.colorMode = 'reference';
    const entered = deferred<void>(), pending = deferred<DecodedFrame>();
    late.source.frameAt = async () => { entered.resolve(); return pending.promise; };
    const restoring = session.restoreWorkspace(workspace, async () => late.source);
    const rejected = assert.rejects(restoring, { name: 'AbortError' });
    await entered.promise; session.pause(); await rejected;
    await session.seek(120000);
    const count = drawn.length;
    pending.resolve(late.frame(80000)); await turn();
    assert.equal(drawn.length, count); assert.equal(late.closed, 1); assert.equal(late.disposed, 1);
    assert.equal(old.disposed, 0); assert.equal(session.getState().tracks[0].failure, undefined);
    assert.equal(session.getState().positionUs, 120000); assert.deepEqual(session.getState().marks, before.marks);
    assert.equal(session.getState().colorMode, 'browser'); assert.equal(session.getState().resources.totalBytes, 0);
  });
});

test('review export shares current comparison conditions without inventing historical mark conditions', async () => {
  await sessionTest(async session => {
    const source = fixture('export-color');
    await session.load('A', async () => source.source);
    session.addMark({ slot: 'A', text: 'created under browser mode' });
    const marks = session.getState().marks;
    for (const [mode, decode] of [
      ['browser', initialDecode],
      ['reference', { decoder: 'hardware', depth: 8 }],
      ['reference', { decoder: 'software', depth: 4 }],
      ['browser', { decoder: 'software', depth: 4 }],
    ] as const) {
      await session.setColorMode(mode, decode);
      const review = session.exportReview(), state = session.getState(), workspace = session.exportWorkspace('http://localhost/');
      assert.equal(review.schema, 'voidplayer-web-review'); assert.equal(review.version, 1);
      assert.equal(review.color, state.color); assert.deepEqual(review.comparison, workspace.comparison);
      assert.equal(review.comparison.colorMode, state.colorMode); assert.deepEqual(review.comparison.referenceDecode, state.referenceDecode);
      assert.equal(review.comparisonScope, 'export-time'); assert.equal(review.markComparisonConditions, 'not-recorded');
      assert.deepEqual(review.marks, marks, 'mode changes never rewrite old annotation evidence');
      review.comparison.referenceDecode.depth = 1; review.marks[0].text = 'mutated export'; review.media[0].name = 'mutated media';
      assert.deepEqual(session.getState().marks, marks); assert.equal(session.getState().referenceDecode.depth, decode.depth);
      assert.equal(session.getState().tracks[0].name, 'export-color');
    }
    const legacy = session.exportWorkspace('http://localhost/'); delete legacy.comparison;
    await session.restoreWorkspace(legacy, async () => fixture('legacy-source').source);
    assert.deepEqual(session.exportReview().marks, marks); assert.equal(session.exportReview().markComparisonConditions, 'not-recorded');
  });
});

test('workspace failure releases prepared candidates while rollback leaves failed and unavailable tracks untouched', async () => {
  await sessionTest(async session => {
    const retained = fixture('retained'), prepared = fixture('prepared'), missing = fixture('missing');
    await session.load('A', async () => retained.source); await session.load('B', async () => missing.source);
    const saved = session.exportWorkspace('http://localhost/');
    await session.restoreWorkspace(saved, async info => {
      if (info.id === missing.source.info.id) throw new Error('missing reference');
      return fixture('survivor').source;
    }, { allowUnavailable: true });
    const unavailable = session.getState().tracks[1];
    await assert.rejects(session.restoreWorkspace(saved, async info => {
      if (info.id === missing.source.info.id) throw new Error('later import failure');
      return prepared.source;
    }), /later import failure/);
    assert.equal(prepared.closed, 1); assert.equal(prepared.disposed, 1);
    assert.deepEqual(session.getState().tracks[1], unavailable);
    assert.equal(session.getState().tracks[0].failure, undefined);
    assert.equal(session.getState().resources.totalBytes, 0);
  });
});

test('workspace presentation rollback errors remain observable without active tracks', async () => {
  await sessionTest(async session => {
    const workspace = session.exportWorkspace('http://localhost/');
    let calls = 0;
    const original = new Error('empty presenter preparation failed'), rollback = new Error('empty presenter rollback failed');
    session.onColorModeChange = async () => { throw ++calls === 1 ? original : rollback; };
    await assert.rejects(session.restoreWorkspace(workspace, async () => { throw new Error('no source should open'); }), error => {
      assert.ok(error instanceof AggregateError); assert.equal(error.errors[0], original);
      assert.equal(error.errors[1].cause, rollback); return true;
    });
    assert.equal(session.getState().tracks.length, 0); assert.equal(session.getState().resources.totalBytes, 0);
  });
});

test('workspace rollback releases old playback readers before repainting the retained session', async () => {
  await sessionTest(async session => {
    const source = fixture('restore-buffered');
    await session.load('A', async () => source.source);
    await session.play(); await turn(); session.pause();
    assert.ok(session.getState().resources.totalBytes > 0, 'paused playback retains a buffered frame');
    const workspace = session.exportWorkspace('http://localhost/');
    await assert.rejects(session.restoreWorkspace(workspace, async () => { throw new Error('buffered import failed'); }), /buffered import failed/);
    assert.equal(session.getState().resources.totalBytes, 0, 'rollback must not reuse old presentation queues');
    assert.equal(session.getState().tracks[0].failure, undefined);
    await session.seek(120000); assert.equal(session.getState().tracks[0].frame?.ptsUs, 120000);
  });
});

for (const waiting of [true, false]) test(`workspace rollback resynchronizes a retained ${waiting ? 'index-wait' : 'catching-up'} track before immediate annotation`, async () => {
  await sessionTest(async session => {
    const healthy = fixture('sync-ready'), delayed = fixture('sync-delayed'), gate = deferred<void>();
    delayed.source.info.indexState = 'building'; delayed.source.info.indexWaiting = true;
    delayed.source.framesFrom = async function* (ptsUs) { await gate.promise; yield delayed.frame(ptsUs); };
    try {
      await session.load('A', async () => healthy.source); await session.load('B', async () => delayed.source);
      await session.play(); await new Promise(resolve => setTimeout(resolve, 70));
      if (!waiting) {
        assert.equal(session.getState().tracks[1].syncState, 'index-wait');
        delayed.source.info.indexWaiting = false; await new Promise(resolve => setTimeout(resolve, 40));
      }
      session.pause();
      const before = session.getState(), workspace = session.exportWorkspace('http://localhost/');
      assert.equal(before.tracks[1].syncState, waiting ? 'index-wait' : 'catching-up');
      assert.throws(() => session.addMark({ slot: 'B', text: 'old stale frame' }), /尚未同步/);
      await assert.rejects(session.restoreWorkspace(workspace, async () => { throw new Error('restore preparation failed'); }), /restore preparation failed/);
      const after = session.getState();
      assert.equal(after.positionUs, before.positionUs); assert.equal(after.tracks[1].id, before.tracks[1].id);
      assert.equal(after.tracks[1].failure, undefined); assert.equal(after.tracks[1].syncState, undefined);
      assert.equal(after.tracks[1].frame?.ptsUs, before.positionUs, 'rollback has drawn the current session position');
      const mark = session.addMark({ slot: 'B', text: 'immediate annotation after rollback' });
      assert.equal(mark.frame.ptsUs, before.positionUs);
      session.updateMark(mark.id, { text: 'immediate edit after rollback' });
      assert.equal(session.getState().marks[0].text, 'immediate edit after rollback');
      assert.equal(session.getState().resources.frames, 0);
      gate.resolve(); await turn();
      assert.equal(delayed.closed, 3, 'load, rollback and late old reader frames each close once');
      assert.equal(session.getState().resources.totalBytes, 0);
    } finally { gate.resolve(); }
  });
});
