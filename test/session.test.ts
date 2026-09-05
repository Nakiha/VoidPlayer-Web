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
    draw() {}, close() { closed++; },
  });
  const source: MediaSource = {
    info: { id: name, name, size: 10, lastModified: 0, codec: 'test', width: 10, height: 10, firstPtsUs: 300000, durationUs: end },
    async frameAt(time) {
      const i = Math.max(0, starts.findLastIndex(t => t <= time));
      return frame(starts[i]);
    },
    async framesAfter(pts, count) { return starts.filter(t => t > pts).slice(0, count).map(frame); },
    dispose() { disposed++; },
  };
  return { source, get closed() { return closed; }, get disposed() { return disposed; } };
}

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
  assert.equal(tools.length, 6); assert.equal(get('get_review_session').annotations.readOnlyHint, true);
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
  const a = { currentUs: 0, nextUs: 33333, nextNextUs: 66667 };
  const b = { currentUs: 0, nextUs: 41667, nextNextUs: 83334 };
  assert.equal(planForwardStep([a, b], minFrameDurationUs([33333, 41667])), 41667);
});

test('forward planner never skips a track\'s intermediate frame', () => {
  const a = { currentUs: 0, nextUs: 100, nextNextUs: 150 };
  const b = { currentUs: 0, nextUs: 200, nextNextUs: 250 };
  assert.equal(planForwardStep([a, b], 100), 100);
});

test('forward planner rejects targets that jump a suspicious gap', () => {
  const a = { currentUs: 0, nextUs: 1000000, nextNextUs: null };
  const b = { currentUs: 0, nextUs: 33333, nextNextUs: 66667 };
  assert.equal(planForwardStep([a, b], minFrameDurationUs([1000000, 33333])), 33333);
});

test('forward planner may land past a last frame without a next-next successor', () => {
  const a = { currentUs: 0, nextUs: 100, nextNextUs: null };
  const b = { currentUs: 0, nextUs: 200, nextNextUs: 300 };
  assert.equal(planForwardStep([a, b], 100), 200);
  assert.equal(planForwardStep([{ currentUs: 0, nextUs: null, nextNextUs: null }], 33333), null);
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
