import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReviewSession } from '../src/session.ts';
import { minFrameDurationUs, planBackwardStep, planForwardStep, regionValue, timeUs } from '../src/model.ts';
import { reviewTools } from '../src/agent.ts';
import type { MediaSource } from '../src/media.ts';

function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => resolve = r); return { promise, resolve }; }
function media(name = 'A', starts = [0, 40000, 120000, 160000], end = 200000) {
  let closed = 0, disposed = 0;
  const frame = (pts: number) => ({
    ptsUs: pts, sourcePtsUs: pts + 300000, durationUs: (starts[starts.indexOf(pts) + 1] ?? end) - pts,
    kind: 'video-sample' as const, width: 10, height: 10, byteSize: 400, close() { closed++; },
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

test('drawing-only annotations retain frame and source anchors in detached exports', async () => {
  const session = new ReviewSession(() => {});
  await session.load('A', async () => media('drawing-source').source);
  await session.seek(40000);
  const drawings = [{ tool: 'ellipse', points: [{ x: .1, y: .2 }, { x: .8, y: .9 }] }];
  const mark = session.addMark({ slot: 'A', text: '', drawings });
  assert.equal(mark.frame.ptsUs, 40000);
  drawings[0].points[0].x = .9;
  assert.equal(session.exportReview().marks[0].drawings![0].points[0].x, .1);
  await session.load('A', async () => media('replacement').source);
  assert.equal(session.exportReview().marks[0].mediaId, 'drawing-source');
  assert.throws(() => session.addMark({ slot: 'A', text: '' }));
  assert.throws(() => session.addMark({ slot: 'A', text: 'note', drawings: [{ tool: 'bad' }] }));
  await session.dispose();
});

test('VFR stepping uses frame boundaries rather than an assumed frame rate', async () => {
  const session = new ReviewSession(() => {}); const m = media();
  await session.load('A', async () => m.source);
  await session.step(1); assert.equal(session.getState().tracks[0].frame?.ptsUs, 40000);
  await session.step(1); assert.equal(session.getState().tracks[0].frame?.ptsUs, 120000);
  await session.step(-1); assert.equal(session.getState().tracks[0].frame?.ptsUs, 40000);
  assert.equal(m.closed, 6);
  await session.dispose(); assert.equal(m.disposed, 1);
});

test('bad media replacement preserves the active source and frame', async () => {
  const session = new ReviewSession(() => {}); const good = media(); const bad = media('bad');
  await session.load('A', async () => good.source);
  bad.source.frameAt = async () => { throw new Error('unsupported codec'); };
  await assert.rejects(session.load('A', async () => bad.source), /unsupported/);
  assert.equal(session.getState().tracks[0].id, 'A'); assert.equal(good.disposed, 0); assert.equal(bad.disposed, 1);
  await session.dispose();
});

test('a failed second-track decode releases the first frame and commits neither', async () => {
  const drawn: number[] = [];
  const session = new ReviewSession((_, frame) => drawn.push(frame.ptsUs));
  const a = media(), b = media('B');
  await session.load('A', async () => a.source); await session.load('B', async () => b.source);
  const closed = a.closed; const drawCount = drawn.length;
  b.source.frameAt = async () => { throw new Error('decode error'); };
  await assert.rejects(session.seek(120000), /decode error/);
  assert.equal(a.closed, closed + 1); assert.equal(drawn.length, drawCount);
  assert.equal(session.getState().positionUs, 0);
  await session.dispose();
});

test('new seek supersedes a pending seek without drawing its stale frames', async () => {
  const drawn: number[] = []; const session = new ReviewSession((_, frame) => drawn.push(frame.ptsUs)); const a = media();
  await session.load('A', async () => a.source);
  const started = deferred<void>(); const release = deferred<void>(); const original = a.source.frameAt;
  a.source.frameAt = async time => { if (time === 40000) { started.resolve(); await release.promise; } return original(time); };
  const first = session.seek(40000); const rejection = assert.rejects(first, /取消|取代/);
  await started.promise;
  const second = session.seek(120000); release.resolve();
  await Promise.all([rejection, second]);
  assert.deepEqual(drawn, [0, 120000]); assert.equal(session.getState().busy, false);
  await session.dispose();
});

test('pause cancels an in-flight seek and preserves mark anchor', async () => {
  const session = new ReviewSession(() => {}); const a = media(); await session.load('A', async () => a.source);
  const started = deferred<void>(), release = deferred<void>(); const original = a.source.frameAt;
  a.source.frameAt = async time => { started.resolve(); await release.promise; return original(time); };
  const seek = session.seek(120000); const rejection = assert.rejects(seek, /取消|取代/);
  await started.promise; session.pause();
  const mark = session.addMark({ slot: 'A', text: 'Paused frame' });
  assert.equal(mark.frame.ptsUs, 0); release.resolve(); await rejection;
  assert.equal(session.getState().tracks[0].frame?.ptsUs, 0);
  await session.dispose();
});

test('review export keeps original media lineage after replacement and returns a detached copy', async () => {
  const session = new ReviewSession(() => {}); await session.load('A', async () => media('original').source);
  await session.seek(45000);
  const mark = session.addMark({ slot: 'A', text: '  banding  ', severity: 4, region: { left: .1, top: .2, width: .3, height: .4 } });
  assert.equal(mark.frame.ptsUs, 40000); assert.equal(mark.frame.sourcePtsUs, 340000);
  await session.load('A', async () => media('replacement').source);
  const doc = session.exportReview(); assert.equal(doc.media.length, 2); assert.equal(doc.marks[0].mediaId, 'original');
  doc.marks[0].text = 'mutated'; assert.equal(session.exportReview().marks[0].text, 'banding');
  session.deleteMark(mark.id); assert.equal(session.getState().marks.length, 0);
  await session.dispose();
});

test('WebMCP tool contracts validate inputs and use the same session state', async () => {
  const session = new ReviewSession(() => {}); await session.load('A', async () => media().source);
  const tools = reviewTools(session); const get = (name: string) => tools.find(t => t.name === name)!;
  assert.deepEqual(tools.map(t => t.name), ['benchmark_review', 'get_review_session', 'seek_review', 'step_review', 'reorder_review_tracks', 'remove_review_track', 'set_review_track_offset', 'pause_review', 'add_review_mark', 'update_review_mark', 'export_review', 'get_review_logs', 'list_review_log_sessions', 'list_library', 'load_library_item']); assert.equal(get('get_review_session').annotations.readOnlyHint, true);
  await get('seek_review').execute({ ptsUs: 45000 });
  assert.equal(session.getState().tracks[0].frame?.ptsUs, 40000);
  get('add_review_mark').execute({ slot: 'A', text: 'Agent note' });
  assert.equal(session.getState().marks[0].origin, 'agent');
  for (const input of [{ ptsUs: -1 }, { ptsUs: '40000' }, { ptsUs: 1, extra: true }, {}]) {
    assert.throws(() => get('seek_review').execute(input));
  }
  assert.throws(() => get('add_review_mark').execute({ slot: 'C', text: 'no' }));
  assert.equal(session.getState().marks.length, 1);
  get('pause_review').execute({});
  await get('step_review').execute({ direction: 1 });
  assert.throws(() => get('step_review').execute({ slot: 'A', direction: 1 }));
  assert.equal((get('export_review').execute({}) as { version: number }).version, 1);
  await session.dispose();
});

test('invalid inputs cannot create ambiguous frame anchors', () => {
  for (const value of [-1, 0.3, NaN, Infinity, '10']) assert.throws(() => timeUs(value));
  assert.throws(() => regionValue({ left: .9, top: 0, width: .2, height: .1 }));
});

test('forward planner prefers the target that steps the most tracks', () => {
  const a = { currentUs: 0, durationUs: 33333, nextUs: 33333, nextNextUs: 66667 };
  const b = { currentUs: 0, durationUs: 41667, nextUs: 41667, nextNextUs: 83334 };
  assert.equal(planForwardStep([a, b]), 41667);
});

test('forward planner never skips a track\'s intermediate frame', () => {
  const a = { currentUs: 0, durationUs: 100, nextUs: 100, nextNextUs: 150 };
  const b = { currentUs: 0, durationUs: 200, nextUs: 200, nextNextUs: 250 };
  assert.equal(planForwardStep([a, b]), 100);
});

test('forward planner rejects targets that jump a suspicious gap', () => {
  const a = { currentUs: 0, durationUs: 1000000, nextUs: 1000000, nextNextUs: null };
  const b = { currentUs: 0, durationUs: 33333, nextUs: 33333, nextNextUs: 66667 };
  assert.equal(planForwardStep([a, b]), 33333);
});

test('forward planner may land past a last frame without a next-next successor', () => {
  const a = { currentUs: 0, durationUs: 100, nextUs: 100, nextNextUs: null };
  const b = { currentUs: 0, durationUs: 200, nextUs: 200, nextNextUs: 300 };
  assert.equal(planForwardStep([a, b]), 200);
  assert.equal(planForwardStep([{ currentUs: 0, durationUs: 33333, nextUs: null, nextNextUs: null }]), null);
});

test('backward planner steps the most tracks and rejects targets below a predecessor', () => {
  assert.equal(planBackwardStep([{ currentUs: 120000, previousUs: 40000 }, { currentUs: 120000, previousUs: 90000 }]), 90000);
  assert.equal(planBackwardStep([{ currentUs: 120000, previousUs: 110000 }, { currentUs: 120000, previousUs: 90000 }]), 110000);
  assert.equal(planBackwardStep([{ currentUs: 0, previousUs: null }]), null);
});

test('min frame duration falls back when no current duration is trustworthy', () => {
  assert.equal(minFrameDurationUs([33333, 41667]), 33333);
  assert.equal(minFrameDurationUs([100000]), 100000);
  assert.equal(minFrameDurationUs([100001, 0]), 33333);
});

test('forward step moves every track the fair target can advance', async () => {
  const session = new ReviewSession(() => {});
  await session.load('A', async () => media('A', [0, 33333, 66667, 100000, 133333]).source);
  await session.load('B', async () => media('B', [0, 41667, 83334, 125000, 166667]).source);
  await session.step(1);
  const state = session.getState();
  assert.equal(state.positionUs, 41667);
  assert.deepEqual(state.tracks.map(t => t.frame?.ptsUs), [33333, 41667]);
  await session.dispose();
});

test('mixed 60/30 fps stepping advances after seek and backward steps at millisecond-rounded PTS', async () => {
  const session = new ReviewSession(() => {});
  const fast = Array.from({length:120}, (_, i) => Math.floor(i * 1000 / 60) * 1000);
  const slow = Array.from({length:60}, (_, i) => Math.round(i * 1000 / 30) * 1000);
  try {
    await session.load('A', async () => media('A', fast, 2000000).source);
    await session.load('B', async () => media('B', slow, 2000000).source);
    await session.seek(1483000);
    await session.step(1);
    assert.equal(session.getState().positionUs, 1500000);
    await session.step(-1);
    const back = session.getState().positionUs;
    await session.step(1); assert.ok(session.getState().positionUs > back);
    while (session.getState().positionUs < fast.at(-1)!) {
      const before = session.getState();
      await session.step(1);
      const after = session.getState();
      assert.ok(after.positionUs > before.positionUs, `forward step stalled at ${before.positionUs}`);
      for (const [i, starts] of [fast, slow].entries()) {
        const oldIndex = starts.indexOf(before.tracks[i].frame!.ptsUs);
        const newIndex = starts.indexOf(after.tracks[i].frame!.ptsUs);
        assert.ok(newIndex === oldIndex || newIndex === oldIndex + 1, 'no intermediate frame skipped');
      }
    }
    const last = session.getState().positionUs;
    await session.step(1); assert.equal(session.getState().positionUs, last);
  } finally { await session.dispose(); }
});

test('forward step keeps a track whose next frame lies across a gap', async () => {
  const session = new ReviewSession(() => {});
  await session.load('A', async () => media('A', [0, 1000000], 2000000).source);
  await session.load('B', async () => media('B', [0, 33333, 66667, 100000], 2000000).source);
  await session.step(1);
  const state = session.getState();
  assert.equal(state.positionUs, 33333);
  assert.deepEqual(state.tracks.map(t => t.frame?.ptsUs), [0, 33333]);
  await session.dispose();
});

test('stepping past the last frame is a no-op, not an error', async () => {
  const session = new ReviewSession(() => {});
  await session.load('A', async () => media('A', [0, 40000], 80000).source);
  await session.step(1); assert.equal(session.getState().tracks[0].frame?.ptsUs, 40000);
  await session.step(1); assert.equal(session.getState().tracks[0].frame?.ptsUs, 40000);
  assert.equal(session.getState().positionUs, 40000);
  await session.step(-1); assert.equal(session.getState().tracks[0].frame?.ptsUs, 0);
  await session.step(-1); assert.equal(session.getState().tracks[0].frame?.ptsUs, 0);
  await session.dispose();
});

test('backward step picks the target that steps the most tracks and keeps the rest', async () => {
  const session = new ReviewSession(() => {});
  await session.load('A', async () => media('A').source);
  await session.load('B', async () => media('B', [0, 30000, 60000, 90000, 120000, 150000]).source);
  await session.seek(120000); await session.step(-1);
  let state = session.getState();
  assert.equal(state.positionUs, 90000);
  assert.deepEqual(state.tracks.map(t => t.frame?.ptsUs), [40000, 90000]);
  await session.step(-1);
  state = session.getState();
  assert.equal(state.positionUs, 60000);
  assert.deepEqual(state.tracks.map(t => t.frame?.ptsUs), [40000, 60000]);
  await session.dispose();
});

test('playback draws sequential frames in order and closes every one', async () => {
  const drawn: number[] = [];
  const session = new ReviewSession((_, frame) => drawn.push(frame.ptsUs));
  const m = media('A', [0, 40000, 80000], 120000);
  await session.load('A', async () => m.source);
  await session.play();
  for (let i = 0; i < 100 && session.getState().playing; i++) await new Promise(r => setTimeout(r, 25));
  const state = session.getState();
  assert.equal(state.playing, false);
  assert.equal(state.positionUs, 119999);
  // Consecutive duplicates are the current frame re-anchored at playback start.
  assert.deepEqual(drawn.filter((v, i) => i === 0 || v !== drawn[i - 1]), [0, 40000, 80000]);
  assert.ok(m.closed >= 4, 'every decoded frame is closed');
  await session.dispose();
});

test('pause during playback stops drawing and keeps the last frame', async () => {
  const drawn: number[] = [];
  const session = new ReviewSession((_, frame) => drawn.push(frame.ptsUs));
  const m = media('A', [0, 40000, 80000, 120000, 160000], 400000);
  await session.load('A', async () => m.source);
  await session.play();
  await new Promise(r => setTimeout(r, 70));
  session.pause();
  const count = drawn.length;
  await new Promise(r => setTimeout(r, 70));
  assert.equal(drawn.length, count);
  assert.equal(session.getState().playing, false);
  await session.dispose();
});

test('slow decode cannot finish playback before the final frame is drawn', async () => {
  const starts = Array.from({ length: 10 }, (_, i) => i * 20000);
  const m = media('A', starts, 200000);
  m.source.framesFrom = async function* () {
    for (const pts of starts) {
      await new Promise(r => setTimeout(r, 55));
      yield await m.source.frameAt(pts);
    }
  };
  const session = new ReviewSession(() => {});
  await session.load('A', async () => m.source);
  await session.play();
  for (let i = 0; i < 100 && session.getState().playing; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(session.getState().playing, false);
  assert.equal(session.getState().tracks[0].frame?.ptsUs, 180000);
  await session.dispose();
});

test('pause while a decode is pending rejects late presentation and releases the iterator', async () => {
  const m = media(); const started = deferred<void>(); const release = deferred<void>();
  let returned = false; let draws = 0;
  m.source.framesFrom = async function* () {
    try {
      yield await m.source.frameAt(0);
      started.resolve(); await release.promise;
      yield await m.source.frameAt(40000);
    } finally { returned = true; }
  };
  const session = new ReviewSession(() => draws++);
  await session.load('A', async () => m.source); await session.play();
  await started.promise; session.pause(); const count = draws; release.resolve();
  await new Promise(r => setTimeout(r, 30));
  assert.equal(draws, count);
  assert.equal(returned, true);
  await session.dispose();
});

test('both track producers start independently and paused sleep releases their queues', async () => {
  const a = media('A'), b = media('B');
  const release = deferred<void>(); let bStarted = false;
  a.source.framesFrom = async function* () { await release.promise; yield await a.source.frameAt(0); };
  const original = b.source.framesFrom;
  b.source.framesFrom = async function* (pts) { bStarted = true; yield* original(pts); };
  const session = new ReviewSession(() => {});
  await session.load('A', async () => a.source); await session.load('B', async () => b.source);
  await session.play(); await new Promise(r => setTimeout(r, 10));
  assert.equal(bStarted, true, 'B is not blocked by an unresolved A decode');
  session.pause(); release.resolve(); await session.dispose();
});

test('visual reordering retains source identity, frame anchors and playback position', async () => {
  const draws: string[] = [];
  const session = new ReviewSession(slot => draws.push(slot));
  const a = media('alpha'), b = media('beta');
  await session.load('A', async () => a.source); await session.load('B', async () => b.source);
  await session.seek(120000);
  const mark = session.addMark({ slot: 'A', text: 'anchor' });
  const before = session.getState(), count = draws.length;
  session.reorderTracks(['B', 'A']);
  const after = session.getState();
  assert.deepEqual(after.tracks.map(t => t.id), ['beta', 'alpha']);
  assert.equal(after.positionUs, before.positionUs);
  assert.deepEqual(after.marks[0], mark);
  assert.equal(draws.length, count);
  assert.equal(a.disposed + b.disposed, 0);
  assert.throws(() => session.reorderTracks(['A', 'A']), /排序/);
  assert.throws(() => session.reorderTracks(['B']), /排序/);
  await session.step(1);
  assert.deepEqual(session.getState().tracks.map(t => t.frame?.ptsUs), [160000, 160000]);
  await session.dispose();
});

test('new annotations snapshot the current actor without rewriting earlier authors', async () => {
  const session = new ReviewSession(() => {}); await session.load('A', async () => media().source);
  const actor = { id: 'tester.one', name: 'tester.one' };
  session.setActor(actor); const first = session.addMark({ slot: 'A', text: 'first' });
  actor.name = 'changed'; session.setActor({ id: 'tester.two', name: 'tester.two' });
  const second = session.addMark({ slot: 'A', text: 'second', origin: 'agent' });
  assert.equal(first.author?.id, 'tester.one'); assert.equal(second.author?.id, 'tester.two');
  assert.equal(session.exportReview().marks[0].author?.name, 'tester.one');
  session.setActor(null); assert.equal(session.addMark({ slot: 'A', text: 'local' }).author, undefined);
  await session.dispose();
});

test('closing a track releases only its decoder, retains annotation lineage and resets an empty session', async () => {
  const session = new ReviewSession(() => {}), a = media('close-a'), b = media('close-b');
  await session.load('A', async () => a.source); await session.load('B', async () => b.source);
  await session.seek(40000); session.addMark({ slot: 'A', text: 'retain this note' });
  const before = session.getState().tracks.find(t => t.slot === 'B')!.frame;
  await session.removeTrack('A');
  assert.equal(a.disposed, 1); assert.equal(b.disposed, 0);
  assert.deepEqual(session.getState().tracks.map(t => t.slot), ['B']);
  assert.deepEqual(session.getState().tracks[0].frame, before);
  assert.equal(session.getState().positionUs, 40000);
  assert.equal(session.exportReview().marks[0].mediaId, 'close-a');
  await session.removeTrack('A'); assert.equal(a.disposed, 1);
  await reviewTools(session).find(t => t.name === 'remove_review_track')!.execute({ slot: 'B' });
  assert.equal(b.disposed, 1); assert.equal(session.getState().durationUs, 0); assert.equal(session.getState().positionUs, 0);
  await session.dispose(); assert.equal(b.disposed, 1);
});

test('closing cancels an in-flight replacement before disposing the current track', async () => {
  const session = new ReviewSession(() => {}), original = media('original'), incoming = media('incoming');
  await session.load('A', async () => original.source);
  const started = deferred<void>(), opened = deferred<MediaSource>();
  const loading = session.load('A', () => { started.resolve(); return opened.promise; });
  const rejected = assert.rejects(loading, { name: 'AbortError' });
  await started.promise;
  const closing = session.removeTrack('A'); opened.resolve(incoming.source);
  await rejected; await closing;
  assert.equal(original.disposed, 1); assert.equal(incoming.disposed, 1);
  assert.equal(session.getState().tracks.length, 0);
  await session.dispose();
});


test('four tracks share seeks, frame stepping and annotations across reorder and removal', async () => {
  const drawn: string[] = [];
  const session = new ReviewSession(slot => { drawn.push(slot); });
  const sources = ['A','B','C','D'].map(name => media(name));
  for (const [i, slot] of (['A','B','C','D'] as const).entries()) await session.load(slot, async () => sources[i].source);
  await session.seek(40000);
  assert.equal(session.getState().tracks.length, 4);
  assert.ok(session.getState().tracks.every(t => t.frame?.ptsUs === 40000));
  const mark = session.addMark({ slot: 'C', text: 'four-way comparison' });
  assert.equal(mark.comparison.length, 4);
  session.reorderTracks(['D','B','C','A']);
  assert.deepEqual(session.getState().tracks.map(t => t.slot), ['D','B','C','A']);
  assert.equal(session.getState().marks[0].slot, 'C');
  await session.step(1);
  assert.ok(session.getState().tracks.every(t => t.frame?.ptsUs === 120000));
  await session.step(-1);
  assert.ok(session.getState().tracks.every(t => t.frame?.ptsUs === 40000));
  await session.removeTrack('C');
  assert.equal(sources[2].disposed, 1);
  assert.equal(session.exportReview().marks[0].mediaId, 'C');
  assert.deepEqual(session.getState().tracks.map(t => t.slot), ['D','B','A']);
  assert.ok(drawn.includes('D'));
  await assert.rejects(session.load('E' as never, async () => media().source), /轨道/);
  await session.dispose();
  assert.ok(sources.every(s => s.disposed === 1));
});


test('duplicate library sources are rejected centrally and release the uncommitted decoder', async () => {
  const session = new ReviewSession(() => {});
  const a = media('first'), b = media('other'), duplicate = media('duplicate');
  a.source.info.source = duplicate.source.info.source = {kind:'library',id:'same-library-id',url:'/api/media/same-library-id'};
  b.source.info.source = {kind:'library',id:'other-library-id',url:'/api/media/other-library-id'};
  await session.load('A', async () => a.source);
  await session.load('B', async () => b.source);
  await session.seek(40000);
  await assert.rejects(session.load('B', async () => duplicate.source), /重复添加/);
  assert.equal(duplicate.disposed, 1);
  assert.equal(b.disposed, 0);
  assert.equal(session.getState().tracks[1].id, 'other');
  assert.equal(session.getState().positionUs, 40000);
  await session.dispose();
});


test('manual alignment maps normalized frames without double-applying nonzero source PTS', async () => {
  const session=new ReviewSession(()=>{}); const starts=[0,40000,80000,120000,160000];
  await session.load('A',async()=>media('A',starts,200000).source);
  await session.load('B',async()=>media('B',starts,200000).source);
  const offsetTool=reviewTools(session).find(t=>t.name==='set_review_track_offset')!;
  await offsetTool.execute({slot:'B',offsetUs:40000}); await session.seek(80000);
  let state=session.getState(); assert.deepEqual(state.tracks.map(t=>t.frame?.ptsUs),[80000,40000]);
  assert.equal(state.tracks[1].frame?.sourcePtsUs,340000);
  await session.step(1);assert.equal(session.getState().positionUs,120000);assert.deepEqual(session.getState().tracks.map(t=>t.frame?.ptsUs),[120000,80000]);
  await session.step(-1);assert.equal(session.getState().positionUs,80000);
  await session.seek(40000);await session.step(-1);assert.equal(session.getState().positionUs,0);
  await session.setTrackOffset('B',-40000);await session.seek(80000);
  const mark=session.addMark({slot:'B',text:'aligned'});
  assert.equal(mark.frame.ptsUs,120000);assert.equal(mark.frame.sourcePtsUs,420000);assert.equal(mark.offsetUs,-40000);assert.equal(mark.sessionPtsUs,80000);
  assert.equal(session.getState().durationUs,200000);
  assert.equal(session.exportReview().alignment.find(t=>t.slot==='B')?.offsetUs,-40000);
  await session.seek(0);assert.deepEqual(session.getState().tracks.map(t=>t.frame?.ptsUs),[0,40000]);
  const before=session.getState();await assert.rejects(session.setTrackOffset('B',-200000));
  assert.deepEqual(session.getState().tracks,before.tracks);
  await session.load('B',async()=>media('replacement',starts,200000).source);assert.equal(session.getState().tracks[1].offsetUs,0);
  await session.dispose();
});

test('offset playback queues use local timestamps and finish at the adjusted shared end', async () => {
  const session=new ReviewSession(()=>{}); const starts=[0,20000,40000,60000,80000,100000,120000,140000];
  await session.load('A',async()=>media('A',starts,160000).source);
  await session.load('B',async()=>media('B',starts,160000).source);
  await session.setTrackOffset('B',-40000);await session.play();
  for(let i=0;i<60&&session.getState().playing;i++)await new Promise(r=>setTimeout(r,10));
  const state=session.getState();assert.equal(state.playing,false);assert.equal(state.error,null);assert.equal(state.positionUs,159999);
  assert.deepEqual(state.tracks.map(t=>t.frame?.ptsUs),[140000,140000]);
  assert.ok(state.playback!.maxFrameSkewUs<=20000);
  await session.dispose();
});

test('editing saved annotations preserves anchors and rejects another frame through the shared Agent API', async () => {
  const session = new ReviewSession(() => {});
  await session.load('A', async () => media('editable').source);
  const original = session.addMark({ slot: 'A', text: 'before', drawings: [{ tool: 'text', id: 'text', text: 'before', points: [{ x: .2, y: .3 }] }] });
  const update = reviewTools(session).find(t => t.name === 'update_review_mark')!;
  const drawings = [{ tool: 'text', id: 'text', text: 'after', color: '#abcdef', points: [{ x: .4, y: .5 }] }];
  await update.execute({ id: original.id, text: 'after', drawings });
  drawings[0].points[0].x = .9;
  const changed = session.getState().marks[0];
  assert.equal(changed.id, original.id); assert.deepEqual(changed.frame, original.frame);
  assert.equal(changed.createdAt, original.createdAt); assert.equal(changed.drawings![0].points[0].x, .4);
  await session.seek(40000);
  assert.throws(() => session.updateMark(original.id, { text: 'wrong frame' }), /对应的画面/);
  assert.equal(session.getState().marks[0].text, 'after');
  await session.dispose();
});

test('shared timeline reaches the longest end and short tracks hold their last frame through seek and steps', async () => {
  const session = new ReviewSession(() => {});
  try {
    await session.load('A', async () => media('long', [0,40000,80000,120000,160000,200000,240000], 280000).source);
    await session.load('B', async () => media('short', [0,40000,80000], 120000).source);
    assert.equal(session.getState().durationUs, 280000);
    await session.seek(160000);
    assert.deepEqual(session.getState().tracks.map(t => t.frame?.ptsUs), [160000,80000]);
    await session.step(1); assert.equal(session.getState().positionUs, 200000);
    await session.step(-1); assert.equal(session.getState().positionUs, 160000);
    assert.deepEqual(session.getState().tracks.map(t => t.frame?.ptsUs), [160000,80000]);
    await session.seek(999999);
    assert.equal(session.getState().positionUs, 279999);
    assert.deepEqual(session.getState().tracks.map(t => t.frame?.ptsUs), [240000,80000]);
    await session.removeTrack('A');
    assert.equal(session.getState().durationUs, 120000);
    assert.equal(session.getState().positionUs, 119999);
    assert.equal(session.getState().tracks[0].frame?.ptsUs, 80000);
    await session.setTrackOffset('B', 40000);
    assert.equal(session.getState().durationUs, 160000);
  } finally { await session.dispose(); }
});

test('playback continues after a short track ends and publishes actual progress between full snapshots', async () => {
  const drawn = new Map<string, number[]>();
  const session = new ReviewSession((slot, f) => { const pts = drawn.get(slot) ?? []; pts.push(f.ptsUs); drawn.set(slot, pts); });
  try {
    await session.load('A', async () => media('long', Array.from({length:20}, (_, i) => i * 20000), 400000).source);
    await session.load('B', async () => media('short', [0,20000,40000,60000], 80000).source);
    let snapshots = 0; const positions: number[] = [];
    session.subscribe(() => { snapshots++; });
    const unsubscribe = session.subscribeProgress((pts, duration) => {
      assert.equal(duration, 400000);
      assert.equal(pts, session.getState().positionUs);
      positions.push(pts);
    });
    await session.play();
    for (let i = 0; i < 100 && session.getState().playing; i++) await new Promise(r => setTimeout(r, 10));
    const state = session.getState();
    assert.equal(state.playing, false); assert.equal(state.error, null);
    assert.equal(state.positionUs, 399999);
    assert.deepEqual(state.tracks.map(t => t.frame?.ptsUs), [380000,60000]);
    assert.equal(drawn.get('B')!.at(-1), 60000);
    assert.ok(new Set(positions).size > snapshots * 2, 'progress is not limited by the 100ms full snapshot throttle');
    assert.ok(positions.every((p, i) => i === 0 || p >= positions[i - 1]));
    assert.ok(state.playback!.maxFrameLagUs < 40000, 'intentional last-frame hold is not measured as decoder lag');
    session.pause(); const count = positions.length;
    await new Promise(r => setTimeout(r, 30)); assert.equal(positions.length, count);
    unsubscribe();
  } finally { await session.dispose(); }
});
