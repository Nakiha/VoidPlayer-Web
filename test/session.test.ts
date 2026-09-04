import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReviewSession } from '../src/session.ts';
import { regionValue, stepTarget, timeUs } from '../src/model.ts';
import { reviewTools } from '../src/agent.ts';
import type { MediaSource } from '../src/media.ts';

function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => resolve = r); return { promise, resolve }; }
function media(name = 'A', starts = [0, 40000, 120000, 160000]) {
  let closed = 0, disposed = 0;
  const source: MediaSource = {
    info: { id: name, name, size: 10, lastModified: 0, codec: 'test', width: 10, height: 10, firstPtsUs: 300000, durationUs: 200000 },
    async frameAt(time) {
      const i = Math.max(0, starts.findLastIndex(t => t <= time));
      return { ptsUs: starts[i], sourcePtsUs: starts[i] + 300000, durationUs: (starts[i + 1] ?? 200000) - starts[i], draw() {}, close() { closed++; } };
    },
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
  assert.equal(m.closed, 4);
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
  await get('step_review').execute({ slot: 'A', direction: 1 });
  assert.equal((get('export_review').execute({}) as { version: number }).version, 1);
  await session.dispose();
});

test('invalid inputs cannot create ambiguous frame anchors', () => {
  for (const value of [-1, 0.3, NaN, Infinity, '10']) assert.throws(() => timeUs(value));
  assert.throws(() => regionValue({ left: .9, top: 0, width: .2, height: .1 }));
  assert.throws(() => stepTarget({ ptsUs: 0, sourcePtsUs: 0, durationUs: 0 }, 1, 200000));
});

test('30 fps stepping crosses the fractional microsecond boundary', () => {
  const target = stepTarget({ ptsUs: 1000000, sourcePtsUs: 1000000, durationUs: 33333 }, 1, 3000000);
  assert.ok(target / 1e6 > 31 / 30);
});

test('backward step aligns both tracks to the chosen reference frame start', async () => {
  const session = new ReviewSession(() => {});
  await session.load('A', async () => media('A').source);
  await session.load('B', async () => media('B', [0, 30000, 60000, 90000, 120000, 150000]).source);
  await session.seek(120000); await session.step(-1);
  const state = session.getState();
  assert.equal(state.positionUs, 40000);
  assert.deepEqual(state.tracks.map(t => t.frame?.ptsUs), [40000, 30000]);
  await session.dispose();
});
