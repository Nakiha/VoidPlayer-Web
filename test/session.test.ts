import { rgbaDescription } from '../src/frame-description.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReviewSession } from '../src/session.ts';
import {getColorMode,setColorMode,getReferenceDecode,setReferenceDecode} from '../src/color-mode.ts';
import { minFrameDurationUs, planBackwardStep, planForwardStep, regionValue, timeUs, SLOTS } from '../src/model.ts';
import { reviewTools } from '../src/agent.ts';
import type { MediaSource } from '../src/media.ts';

function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => resolve = r); return { promise, resolve }; }
test('reference decoder changes reload tracks and roll back failed depth changes',async()=>{
 const previous=getColorMode(),decode=getReferenceDecode();setColorMode('reference');setReferenceDecode({decoder:'software',depth:2});
 const session=new ReviewSession(()=>{});let fail=false,opens=0;
 try{
  await session.load('A',async()=>{opens++;if(fail)throw Error('copy failed');return media('decoder').source;});
  await session.seek(40000);session.addMark({slot:'A',text:'keep'});const before=session.getState();
  await session.setReferenceDecode({decoder:'hardware',depth:4});const after=session.getState();
  assert.equal(opens,2);assert.equal(after.positionUs,before.positionUs);assert.equal(after.tracks[0].id,before.tracks[0].id);assert.deepEqual(after.marks,before.marks);
  assert.deepEqual(after.referenceDecode,{decoder:'hardware',depth:4});
  fail=true;await assert.rejects(session.setReferenceDecode({decoder:'hardware',depth:8}),/copy failed/);
  assert.deepEqual(getReferenceDecode(),{decoder:'hardware',depth:4});assert.deepEqual(session.getState().tracks,after.tracks);
  await assert.rejects(session.setReferenceDecode({decoder:'hardware',depth:3 as 2}),/无效/);
 }finally{await session.dispose();setColorMode(previous);setReferenceDecode(decode);}
});
test('color mode reload preserves identity, marks and offset; failed replacement rolls back',async()=>{
 const previous=getColorMode();setColorMode(null);
 const session=new ReviewSession(()=>{});let count=0,fail=false;
 try{
  await session.load('A',async()=>{if(fail)throw Error('unsupported color resource');return media(`version-${++count}`).source;});
  await session.setTrackOffset('A',10000);await session.seek(50000);session.addMark({slot:'A',text:'color check'});
  const before=session.getState();await session.setColorMode('browser');const after=session.getState();
  assert.equal(after.tracks[0].id,before.tracks[0].id);assert.equal(after.tracks[0].offsetUs,10000);assert.equal(after.positionUs,before.positionUs);assert.deepEqual(after.marks,before.marks);
  fail=true;await assert.rejects(session.setColorMode('reference'),/unsupported/);assert.equal(getColorMode(),'browser');assert.deepEqual(session.getState().tracks,after.tracks);
 }finally{await session.dispose();setColorMode(previous);}
});
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

test('a failed second-track seek quarantines only that source and commits healthy frames', async () => {
  const drawn: number[] = [];
  const session = new ReviewSession((_, frame) => drawn.push(frame.ptsUs));
  const a = media(), b = media('B');
  await session.load('A', async () => a.source); await session.load('B', async () => b.source);
  const closed = a.closed; const drawCount = drawn.length;
  b.source.frameAt = async () => { throw new Error('decode error'); };
  await session.seek(120000);
  assert.equal(a.closed, closed + 1); assert.equal(drawn.length, drawCount + 1);
  assert.equal(session.getState().positionUs, 120000);
  assert.match(session.getState().tracks.find(t => t.slot === 'B')!.failure!.message, /decode error/);
  assert.equal(b.disposed, 1);
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
  assert.deepEqual(tools.map(t => t.name), ['list_frame_indexes', 'clear_frame_indexes', 'benchmark_review', 'get_review_session', 'set_review_color_mode', 'set_reference_decode', 'seek_review', 'step_review', 'reorder_review_tracks', 'remove_review_track', 'set_review_track_offset', 'pause_review', 'cancel_review_load', 'add_review_mark', 'update_review_mark', 'export_review', 'get_review_logs', 'list_review_log_sessions', 'list_library', 'load_library_item']); assert.equal(get('get_review_session').annotations.readOnlyHint, true);
  assert.equal(get('list_frame_indexes').annotations.readOnlyHint, true);
  assert.equal(get('clear_frame_indexes').annotations.readOnlyHint, false);
  for (const input of [{}, { scope: 'other' }, { scope: 'media' }, { scope: 'all', id: 'unexpected' }]) assert.throws(() => get('clear_frame_indexes').execute(input));
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

test('pause retains a pending decode without late presentation; dispose releases it', async () => {
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
  assert.equal(returned, false);
  await session.dispose();
  await new Promise(r => setTimeout(r, 0));
  assert.equal(returned, true);
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


test('eight tracks share seeks, frame stepping and annotations across reorder and removal', async () => {
  const drawn: string[] = [];
  const session = new ReviewSession(slot => { drawn.push(slot); });
  const sources = SLOTS.map(name => media(name));
  for (const [i, slot] of SLOTS.entries()) await session.load(slot, async () => sources[i].source);
  await session.seek(40000);
  assert.equal(session.getState().tracks.length, 8);
  assert.ok(session.getState().tracks.every(t => t.frame?.ptsUs === 40000));
  const mark = session.addMark({ slot: 'C', text: 'eight-way comparison' });
  assert.equal(mark.comparison.length, 8);
  session.reorderTracks(['H','G','F','E','D','C','B','A']);
  assert.deepEqual(session.getState().tracks.map(t => t.slot), ['H','G','F','E','D','C','B','A']);
  assert.equal(session.getState().marks[0].slot, 'C');
  await session.step(1);
  assert.ok(session.getState().tracks.every(t => t.frame?.ptsUs === 120000));
  await session.step(-1);
  assert.ok(session.getState().tracks.every(t => t.frame?.ptsUs === 40000));
  await session.removeTrack('C');
  assert.equal(sources[2].disposed, 1);
  assert.equal(session.exportReview().marks[0].mediaId, 'C');
  assert.deepEqual(session.getState().tracks.map(t => t.slot), ['H','G','F','E','D','B','A']);
  assert.ok(drawn.includes('H'));
  await assert.rejects(session.load('I' as never, async () => media().source), /轨道/);
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

test('workspace round trip retains track order, offsets, media anchors and mark identities', async () => {
  const session = new ReviewSession(() => {}); const a = media('workspace-A'), b = media('workspace-B');
  await session.load('A', async () => a.source); await session.load('B', async () => b.source);
  await session.setTrackOffset('B', 40000); await session.seek(120000);
  const mark = session.addMark({ slot: 'A', text: 'retain me' }); session.reorderTracks(['B','A']);
  const document = session.exportWorkspace('http://localhost:5180/');
  const reopened = [] as ReturnType<typeof media>[];
  await session.restoreWorkspace(document, async info => { const m = media('new-decoder-id'); reopened.push(m); return m.source; });
  const state = session.getState();
  assert.deepEqual(state.tracks.map(t => [t.slot,t.id,t.offsetUs]), [['B','workspace-B',40000],['A','workspace-A',0]]);
  assert.equal(state.positionUs,120000); assert.equal(state.playing,false); assert.deepEqual(state.marks,[{...mark,drawings:[]}]);
  assert.equal(a.disposed,1); assert.equal(b.disposed,1); assert.ok(reopened.every(m=>m.closed===1));
  await session.dispose(); assert.ok(reopened.every(m=>m.disposed===1));
});

test('workspace decode failure and cancellation preserve the prior session and release prepared sources', async () => {
  const session = new ReviewSession(() => {}); const original = media('original');
  await session.load('A',async()=>original.source); await session.seek(40000); const mark=session.addMark({slot:'A',text:'keep'});
  const document=session.exportWorkspace('http://localhost/');
  document.media.push({...document.media[0],id:'second'}); document.tracks.push({slot:'B',mediaId:'second',offsetUs:0});
  const good=media('new'), bad=media('bad');bad.source.frameAt=async()=>{throw new Error('decode failed');};
  await assert.rejects(session.restoreWorkspace(document,async info=>info.id==='second'?bad.source:good.source),/decode failed/);
  assert.equal(good.disposed,1);assert.equal(bad.disposed,1);assert.equal(good.closed,1);assert.equal(original.disposed,0);
  assert.equal(session.getState().positionUs,40000);assert.deepEqual(session.getState().marks,[mark]);
  const pending=deferred<MediaSource>(), cancelled=media('cancelled');
  const operation=session.restoreWorkspace(document,()=>pending.promise);await new Promise(r=>setTimeout(r,0));session.pause();pending.resolve(cancelled.source);
  await assert.rejects(operation,{name:'AbortError'});assert.equal(cancelled.disposed,1);assert.equal(original.disposed,0);
  await session.dispose();
});

test('replacing a hung load immediately frees the queue and disposes its late source', { timeout: 2000 }, async () => {
  const session = new ReviewSession(() => {}), late = media('late'), next = media('next');
  const started = deferred<void>(), pending = deferred<MediaSource>();
  let signal!: AbortSignal;
  const loading = session.load('A', value => { signal = value; started.resolve(); return pending.promise; });
  const rejected = assert.rejects(loading, { name: 'AbortError' });
  await started.promise;
  await session.load('A', async () => next.source);
  await rejected;
  assert.equal(signal.aborted, true);
  assert.equal(session.getState().tracks[0].id, 'next');
  assert.equal(session.getState().error, null);
  pending.resolve(late.source);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(late.disposed, 1);
  session.pause();
  assert.equal(next.disposed, 0, 'pause must not dispose a committed track');
  await session.dispose();
});

test('cancelling while showing the first frame releases the incoming decoder exactly once', { timeout: 2000 }, async () => {
  const session = new ReviewSession(() => {}), incoming = media('incoming');
  const started = deferred<void>(), released = deferred<void>();
  const dispose = incoming.source.dispose;
  incoming.source.dispose = () => { dispose(); released.resolve(); };
  incoming.source.frameAt = async () => { started.resolve(); await released.promise; throw new Error('decoder stopped'); };
  const loading = session.load('A', async () => incoming.source);
  const rejected = assert.rejects(loading, { name: 'AbortError' });
  await started.promise;
  session.cancelLoad();
  await rejected;
  assert.equal(incoming.disposed, 1);
  assert.equal(session.getState().error, null);
  await session.load('A', async () => media('recovered').source);
  await session.dispose();
});

test('shared load status reports stages and terminal results, ignoring progress from a cancelled load', { timeout: 2000 }, async () => {
  const session = new ReviewSession(() => {}), pending = deferred<MediaSource>(), started = deferred<void>();
  let report!: import('../src/media-progress.ts').MediaOpenProgress;
  const loading = session.load('A', async (_, progress) => { report = progress; progress('index'); started.resolve(); return pending.promise; }, 'capture.ts');
  const rejected = assert.rejects(loading, { name: 'AbortError' });
  assert.equal(session.getState().mediaLoad?.stage, 'queued');
  assert.equal(session.getState().mediaLoad?.state, 'loading');
  await started.promise;
  assert.equal(session.getState().mediaLoad?.name, 'capture.ts');
  assert.equal(session.getState().mediaLoad?.stage, 'index');
  assert.equal(session.getState().mediaLoad?.state, 'loading');
  session.cancelLoad();
  await rejected;
  assert.equal(session.getState().mediaLoad?.state, 'cancelled');
  assert.ok(session.getState().mediaLoad?.finishedAt);
  await session.load('A', async () => media('next').source, 'next');
  report('decoder');
  assert.equal(session.getState().mediaLoad?.name, 'next');
  assert.equal(session.getState().mediaLoad?.state, 'complete');
  await assert.rejects(session.load('A', async (_, progress) => { progress('decoder'); throw new Error('broken core'); }, 'bad.ts'));
  assert.equal(session.getState().mediaLoad?.stage, 'decoder');
  assert.equal(session.getState().mediaLoad?.state, 'error');
  assert.equal(session.getState().mediaLoad?.error, 'broken core');
  assert.equal(session.getState().tracks[0].name, 'next');
  pending.resolve(media('late').source);
  await session.dispose();
});

test('removing a track cancels a seek waiting on background indexing immediately', { timeout: 2000 }, async () => {
  const session = new ReviewSession(() => {}), sample = media();
  sample.source.info.indexState = 'building';
  let started!: () => void;
  const ready = new Promise<void>(r => { started = r; });
  sample.source.ensureIndexed = async pts => { if (pts! > 0) { started(); await new Promise<void>(() => {}); } };
  await session.load('A', async () => sample.source);
  const seeking = session.seek(1000000), rejected = assert.rejects(seeking, { name: 'AbortError' });
  await ready;
  await session.removeTrack('A'); await rejected;
  assert.equal(session.getState().tracks.length, 0);
  await session.dispose();
});

test('pause/resume reuses both decoders with no random seek, while seek invalidates them', async () => {
  const session = new ReviewSession(() => {});
  let seeks = 0, iterators = 0, returned = 0;
  for (const slot of ['A', 'B'] as const) {
    const m = media(slot, Array.from({ length: 100 }, (_, i) => i * 40000), 4000000);
    const at = m.source.frameAt, from = m.source.framesFrom;
    m.source.frameAt = async pts => { seeks++; return at(pts); };
    m.source.framesFrom = async function* (pts) { iterators++; try { yield* from(pts); } finally { returned++; } };
    await session.load(slot, async () => m.source);
  }
  const initialSeeks = seeks;
  await session.play(); await new Promise(r => setTimeout(r, 30));
  for (let i = 0; i < 5; i++) { session.pause(); await session.play(); }
  await new Promise(r => setTimeout(r, 30));
  session.pause();
  assert.equal(seeks, initialSeeks); assert.equal(iterators, 2); assert.equal(returned, 0);
  await session.seek(400000); await new Promise(r => setTimeout(r, 0));
  assert.equal(returned, 2);
  await session.play(); await new Promise(r => setTimeout(r, 0));
  assert.equal(iterators, 4);
  await session.dispose(); await new Promise(r => setTimeout(r, 0));
  assert.equal(returned, 4);
});

test('adding/reopening another track does not seek an existing frame already at session zero', async () => {
  const first = media('first'), session = new ReviewSession(() => {});
  await session.load('A', async () => first.source);
  first.source.frameAt = async () => { throw new Error('random access cannot reproduce the pre-roll first frame'); };
  await session.load('B', async () => media('second').source);
  await session.removeTrack('B');
  await session.load('B', async () => media('second-again').source);
  assert.equal(session.getState().tracks.length,2);assert.equal(session.getState().tracks[0].frame?.ptsUs,0);
  await session.dispose();
});

for (const paused of [false, true]) test(`removing A ${paused ? 'while paused' : 'while playing'} keeps B's producer and buffered frames`, async () => {
  const session = new ReviewSession(() => {});
  const stats = { A: { started: 0, returned: 0, seeks: 0 }, B: { started: 0, returned: 0, seeks: 0 } };
  for (const slot of ['A', 'B'] as const) {
    const m = media(slot, Array.from({ length: 100 }, (_, i) => i * 40000), 4000000);
    const from = m.source.framesFrom, at = m.source.frameAt;
    m.source.frameAt = async pts => { stats[slot].seeks++; return at(pts); };
    m.source.framesFrom = async function* (pts) { stats[slot].started++; try { yield* from(pts); } finally { stats[slot].returned++; } };
    await session.load(slot, async () => m.source);
  }
  try {
    await session.play(); await new Promise(r => setTimeout(r, 90));
    if (paused) session.pause();
    const before = session.getState().tracks.find(t => t.slot === 'B')!.frame!.ptsUs;
    const seeks = stats.B.seeks;
    await session.removeTrack('A'); await new Promise(r => setTimeout(r, 0));
    assert.equal(stats.A.returned, 1); assert.equal(stats.B.returned, 0);
    await session.play(); await new Promise(r => setTimeout(r, 90)); session.pause();
    assert.equal(stats.B.started, 1); assert.equal(stats.B.seeks, seeks);
    assert.ok(session.getState().tracks[0].frame!.ptsUs > before);
  } finally { await session.dispose(); }
  await new Promise(r => setTimeout(r, 0)); assert.equal(stats.B.returned, 1);
});

test('removal that clamps the clock invalidates surviving producers before repositioning', async () => {
  const session = new ReviewSession(() => {}), a = media('long', [0, 40000, 120000], 200000), b = media('short', [0, 40000], 80000);
  let seeks = 0; const at = b.source.frameAt;
  b.source.frameAt = async pts => { seeks++; return at(pts); };
  try {
    await session.load('A', async () => a.source); await session.load('B', async () => b.source);
    await session.seek(120000); const before = seeks;
    await session.removeTrack('A');
    assert.equal(session.getState().positionUs, 79999); assert.equal(seeks, before + 1);
    await session.play(); await new Promise(r => setTimeout(r, 0)); session.pause();
    assert.equal(session.getState().tracks[0].frame!.ptsUs, 0, 'replay starts at zero after reaching the shorter end');
  } finally { await session.dispose(); }
});

test('playback failure records queue and track snapshots before releasing readers', async () => {
  const { getLogEvents } = await import('../src/log.ts');
  const fixture = media('failure-snapshot');
  fixture.source.framesFrom = async function* () {
    yield await fixture.source.frameAt(0);
    throw new Error('synthetic queue failure');
  };
  const session = new ReviewSession(() => {});
  try {
    await session.load('A', async () => fixture.source);
    const cursor = getLogEvents({ limit: 2000 }).lastSeq;
    await session.play();
    for (let i = 0; i < 100 && !session.getState().error; i++) await new Promise(r => setTimeout(r, 5));
    assert.match(session.getState().error!, /所有轨道/);
    assert.match(session.getState().tracks[0].failure!.message, /synthetic queue failure/);
    const events = getLogEvents({ sinceSeq: cursor, limit: 2000 }).events;
    const snapshot = events.find(e => e.msg === '故障现场：播放队列');
    assert.ok(snapshot);
    assert.ok((snapshot.data as any).queue, 'reader still exists at capture time');
    assert.ok(events.some(e => e.msg === '故障现场：轨道' && (e.data as any).mediaId === 'failure-snapshot'));
    assert.ok(events.findIndex(e => e.msg === '故障现场：会话') < events.findIndex(e => e.msg === '播放中断'));
  } finally { await session.dispose(); }
});

test('a failed playback track no longer blocks healthy playback, seek, stepping or replacement', async () => {
  const a = media('healthy', Array.from({ length: 50 }, (_, i) => i * 40000), 2000000), b = media('broken');
  b.source.framesFrom = async function* () { yield await b.source.frameAt(0); throw new Error('broken source'); };
  const session = new ReviewSession(() => {});
  try {
    await session.load('A', async () => a.source); await session.load('B', async () => b.source);
    await session.play(); await new Promise(r => setTimeout(r, 100));
    const state = session.getState(); assert.equal(state.playing, true); assert.ok(state.positionUs > 40000);
    assert.equal(state.error, null); assert.match(state.tracks[1].failure!.message, /broken source/);
    session.pause(); await session.seek(80000); await session.step(1);
    assert.ok(session.getState().positionUs > 80000);
    assert.throws(() => session.addMark({ slot: 'B', text: 'stale' }), /有效画面/);
    assert.equal(session.addMark({ slot: 'A', text: 'valid' }).comparison.length, 1);
    const replacement = media('replacement'); await session.load('B', async () => replacement.source);
    assert.equal(session.getState().tracks[1].failure, undefined);
  } finally { await session.dispose(); }
});

test('background index rejection is isolated before seek without poisoning other sources', async () => {
  const session = new ReviewSession(() => {}), a = media('indexed'), b = media('bad-index');
  b.source.ensureIndexed = async () => { throw new Error('index broken'); };
  try {
    await session.load('A', async () => a.source); await session.load('B', async () => b.source);
    await session.seek(80000);
    assert.equal(session.getState().positionUs, 80000);
    assert.match(session.getState().tracks[1].failure!.message, /index broken/);
  } finally { await session.dispose(); }
});


test('a track waiting for an index lets healthy clocks advance and rejoins after catching up', async () => {
  const session = new ReviewSession(() => {}), gate = deferred<void>();
  const starts = Array.from({ length: 50 }, (_, i) => i * 20000);
  const a = media('ready', starts, 1000000), b = media('indexing', starts, 1000000);
  b.source.info.indexState = 'building'; b.source.info.indexWaiting = true;
  const frames = b.source.framesFrom.bind(b.source);
  b.source.framesFrom = async function* (pts) { await gate.promise; yield* frames(pts); };
  try {
    await session.load('A', async () => a.source); await session.load('B', async () => b.source);
    await session.play(); await new Promise(resolve => setTimeout(resolve, 120));
    assert.ok(session.getState().positionUs > 40000, 'healthy A advances while B has no index data');
    assert.equal(session.getState().tracks[1].syncState, 'index-wait');
    session.pause(); assert.throws(() => session.addMark({ slot: 'B', text: 'stale image' }), /尚未同步/);
    b.source.info.indexWaiting = false; b.source.info.indexState = 'complete'; gate.resolve();
    await session.play(); await new Promise(resolve => setTimeout(resolve, 160));
    assert.equal(session.getState().tracks[1].syncState, undefined);
    assert.ok(session.getState().tracks[1].frame!.ptsUs > 40000);
    assert.equal(session.getState().error, null);
  } finally { gate.resolve(); await session.dispose(); }
});

test('forward stepping requests the current prefix, never the entire unfinished index', async () => {
  const session = new ReviewSession(() => {}), fixture = media();
  const requested: (number | undefined)[] = [];
  fixture.source.info.indexState = 'building';
  fixture.source.ensureIndexed = async pts => { requested.push(pts); if (pts === undefined || pts === Infinity) throw new Error('full index requested'); };
  try { await session.load('A', async () => fixture.source); await session.step(1); assert.ok(requested.every(Number.isFinite)); assert.equal(session.getState().positionUs, 40000); }
  finally { await session.dispose(); }
});


test('adding at a VFR observation time seeks only the incoming track and keeps existing frame and offsets', async () => {
  const draws: string[] = [], session = new ReviewSession((slot, frame) => draws.push(`${slot}:${frame.ptsUs}`));
  const a = media('A'), b = media('B'); let aSeeks = 0;
  const original = a.source.frameAt; a.source.frameAt = async pts => { aSeeks++; return original(pts); };
  try {
    await session.load('A', async () => a.source); await session.setTrackOffset('A', 20000); await session.seek(65000);
    const before = session.getState(), count = aSeeks, drawCount = draws.length;
    const bTargets: number[] = [], bFrame = b.source.frameAt;
    b.source.frameAt = async pts => { bTargets.push(pts); return bFrame(pts); };
    await session.load('B', async () => b.source);
    const after = session.getState();
    assert.equal(after.positionUs, 65000); assert.equal(aSeeks, count);
    assert.deepEqual(after.tracks[0].frame, before.tracks[0].frame); assert.equal(after.tracks[0].offsetUs, 20000);
    assert.equal(draws.length, drawCount + 1); assert.deepEqual(bTargets, [65000]);
    assert.equal(after.tracks[1].frame!.ptsUs, 40000, 'seek returns the display frame covering the VFR target');
  } finally { await session.dispose(); }
});

test('incoming short tracks hold their last frame without shortening the observation time', async () => {
  const session = new ReviewSession(() => {}), short = media('short', [0, 20000, 40000], 60000);
  try {
    await session.load('A', async () => media('long').source); await session.seek(160000);
    await session.load('B', async () => short.source);
    assert.equal(session.getState().positionUs, 160000);
    assert.equal(session.getState().tracks[1].frame!.ptsUs, 40000);
    assert.equal(session.getState().tracks[0].frame!.ptsUs, 160000);
  } finally { await session.dispose(); }
});

test('waiting for an incoming index keeps the old replacement and clock usable, and cancel is local', async () => {
  const session = new ReviewSession(() => {}), gate = deferred<void>(), entered = deferred<void>();
  const starts = Array.from({ length: 100 }, (_, i) => i * 20000);
  const old = media('old', starts, 2000000), incoming = media('incoming', starts, 2000000);
  incoming.source.info.durationUs = 40000; incoming.source.info.indexState = 'building';
  incoming.source.ensureIndexed = async target => { assert.ok(target! > 40000); entered.resolve(); await gate.promise; incoming.source.info.durationUs = 2000000; };
  try {
    await session.load('A', async () => old.source); await session.seek(100000); await session.play();
    const load = session.load('A', async () => incoming.source); const rejected = assert.rejects(load, { name: 'AbortError' });
    await entered.promise; const at = session.getState().positionUs;
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(session.getState().positionUs > at); assert.equal(session.getState().busy, false);
    assert.equal(session.getState().tracks[0].id, 'old'); assert.equal(old.disposed, 0);
    assert.equal(session.getState().mediaLoad!.stage, 'index');
    await reviewTools(session).find(t => t.name === 'cancel_review_load')!.execute({}); await rejected;
    assert.equal(session.getState().playing, true); assert.equal(incoming.disposed, 1); assert.equal(old.disposed, 0);
  } finally { gate.resolve(); await session.dispose(); }
});

test('pausing transport during index preparation retains the load and joins exactly at the paused target', async () => {
  const session = new ReviewSession(() => {}), gate = deferred<void>(), entered = deferred<void>();
  const starts = Array.from({ length: 100 }, (_, i) => i * 20000);
  const a = media('A', starts, 2000000), b = media('B', starts, 2000000);
  b.source.info.durationUs = 40000; b.source.info.indexState = 'building';
  b.source.ensureIndexed = async () => { entered.resolve(); await gate.promise; b.source.info.durationUs = 2000000; };
  try {
    await session.load('A', async () => a.source); await session.seek(100000); await session.play();
    const load = session.load('B', async () => b.source); await entered.promise;
    await new Promise(resolve => setTimeout(resolve, 60)); session.pause(); const target = session.getState().positionUs;
    assert.equal(session.getState().mediaLoad!.state, 'loading'); gate.resolve(); await load;
    assert.equal(session.getState().positionUs, target); assert.equal(session.getState().playing, false);
    const f = session.getState().tracks[1].frame!; assert.ok(f.ptsUs <= target && f.ptsUs + f.durationUs > target);
    assert.equal(session.getState().tracks[1].indexState, 'building', 'joining does not require a finished index');
  } finally { gate.resolve(); await session.dispose(); }
});

test('joining during playback retains the surviving decoder iterator and advancing clock', async () => {
  const session = new ReviewSession(() => {}), starts = Array.from({ length: 100 }, (_, i) => i * 20000);
  const a = media('A', starts, 2000000), b = media('B', starts, 2000000);
  let seeks = 0, generators = 0; const originalFrame = a.source.frameAt, originalFrames = a.source.framesFrom;
  a.source.frameAt = async pts => { seeks++; return originalFrame(pts); };
  a.source.framesFrom = pts => { generators++; return originalFrames(pts); };
  try {
    await session.load('A', async () => a.source); await session.seek(100000); await session.play();
    await new Promise(resolve => setTimeout(resolve, 80)); const before = session.getState().positionUs, count = seeks;
    await session.load('B', async () => b.source);
    assert.ok(session.getState().positionUs >= before); assert.equal(session.getState().playing, true);
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.ok(session.getState().positionUs > before); assert.equal(seeks, count); assert.equal(generators, 1);
    assert.ok(session.getState().tracks[1].frame!.ptsUs >= before - 20000);
    assert.equal(session.getState().error, null);
  } finally { await session.dispose(); }
});

test('failed synchronization preserves the old nonzero frame and releases a late cancelled seek result', async () => {
  const session = new ReviewSession(() => {}), old = media('old'), bad = media('bad'), late = media('late');
  const gate = deferred<Awaited<ReturnType<MediaSource['frameAt']>>>(), entered = deferred<void>();
  try {
    await session.load('A', async () => old.source); await session.seek(120000);
    bad.source.frameAt = async () => { throw new Error('target decode failed'); };
    await assert.rejects(session.load('A', async () => bad.source), /target decode failed/);
    assert.equal(session.getState().positionUs, 120000); assert.equal(session.getState().tracks[0].frame!.ptsUs, 120000); assert.equal(old.disposed, 0);
    late.source.frameAt = async () => { entered.resolve(); return gate.promise; };
    const pending = session.load('A', async () => late.source), rejected = assert.rejects(pending, { name: 'AbortError' });
    await entered.promise; session.cancelLoad(); await rejected;
    let closed = 0; const frame = await old.source.frameAt(120000); gate.resolve({ ...frame, close() { closed++; frame.close(); } });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(closed, 1); assert.equal(late.disposed, 1);
    assert.equal(session.getState().tracks[0].id, 'old');
  } finally { await session.dispose(); }
});
