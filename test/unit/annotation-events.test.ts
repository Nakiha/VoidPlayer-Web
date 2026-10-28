import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AnnotationStore, ANNOTATION_EVENT_RETENTION } from '../../server/annotations.ts';
import { openIndexDatabase } from '../../server/sqlite.ts';
import { mergeAnnotationEvents } from '../../shared/review/annotation-events.ts';
import { applyAnnotationOperation, parseAnnotationOperation } from '../../shared/review/annotation-command.ts';
import type { AnnotationDocument, AnnotationOperation } from '../../shared/review/annotation-record.ts';

const actor = { id: 'reviewer', name: 'Reviewer' };
function document(id = 'mark'): AnnotationDocument {
  return {
    media: [{ id: 'snapshot', name: 'B.mp4', size: 10, lastModified: 1, codec: 'avc1', decoder: 'webcodecs', width: 320, height: 180, durationUs: 1000000, firstPtsUs: -40000, source: { kind: 'library', id: 'source-B', url: 'http://localhost/api/media/source-B?v=v1' } }],
    mark: { id, text: 'Artifact on B', severity: 3, origin: 'agent', createdAt: '2026-10-23', slot: 'H', mediaId: 'snapshot', frame: { ptsUs: 0, sourcePtsUs: -40000, durationUs: 40000 }, comparison: [], region: { left: .2, top: .3, width: .1, height: .1 } },
  };
}
const command = (id = 'mark'): AnnotationOperation => ({ operationId: `create-${id}`, id, revision: 0, action: 'put', client: { kind: 'agent', id: 'quality-scout' }, document: document(id) });

test('shared commands use explicit anchors and do not mutate the caller or require a session', () => {
  const operation = command(), before = structuredClone(operation);
  const result = applyAnnotationOperation(parseAnnotationOperation(operation), null, actor, '2026-10-23T00:00:00Z');
  assert.deepEqual(operation, before);
  assert.equal(result.mark.author?.id, actor.id);
  assert.equal(result.mark.slot, 'H');
  assert.equal(result.mark.frame.sourcePtsUs, -40000);
  for (const bad of [null, {}, { ...operation, revision: -1 }, { ...operation, client: { kind: 'root' } }, { ...operation, client: { kind: 'agent', id: 'bad\nlabel' } }]) {
    assert.throws(() => parseAnnotationOperation(bad), { status: 400 });
  }
});

test('commits retain every operation, deduplicate retries and survive disconnected consumers/restart', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vp-events-')), file = path.join(dir, 'annotations.sqlite');
  let store = new AnnotationStore(file);
  try {
    const create = command();
    const first = store.mutate('default', create, actor, 'request-1');
    assert.deepEqual(store.mutate('default', create, actor, 'lost-response-retry'), first);
    store.mutate('default', { operationId: 'delete', id: 'mark', revision: 1, action: 'delete', client: { kind: 'gui' } }, actor);
    store.mutate('default', { operationId: 'restore', id: 'mark', revision: 2, action: 'restore' }, actor);
    const events = store.events('default', 0);
    assert.deepEqual(events.events.map(event => [event.action, event.revision]), [['put', 1], ['delete', 2], ['restore', 3]]);
    assert.equal(events.events[0].requestId, 'request-1');
    assert.equal(events.events[0].client.id, 'quality-scout');
    assert.deepEqual(events.events[0].target.source, { id: 'source-B', version: 'v1' });
    assert.equal(store.changes('default').entries.length, 1, 'state feed remains coalesced');
    assert.deepEqual(mergeAnnotationEvents(events.events, events), events.events, 'duplicate delivery is inert');
    assert.throws(() => store.mutate('default', { ...create, operationId: 'conflict' }, actor), { code: 'annotation-revision-conflict' });
    assert.equal(store.events('default', 0).events.length, 3, 'rejected writes emit no commit event');
    store.close(); store = new AnnotationStore(file);
    assert.deepEqual(store.events('default', 1).events.map(event => event.revision), [2, 3]);
    assert.equal(store.events('default', 3).events.length, 0);
    assert.equal(store.events('default', 4).reason, 'cursor-ahead');
    assert.equal(store.read('default', 'mark')?.revision, 3);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('bounded history paginates, distinguishes shared-clock gaps, and tells slow consumers to rebuild state', () => {
  const store = new AnnotationStore(':memory:');
  try {
    const other = store.createSpace('other');
    store.mutate(other.id, command('other'), actor);
    const create = command();
    for (let revision = 0; revision < ANNOTATION_EVENT_RETENTION + 2; revision++) {
      store.mutate('default', { ...create, revision, operationId: `op-${revision}` }, actor);
    }
    const reset = store.events('default', 0);
    assert.equal(reset.resetRequired, true); assert.equal(reset.reason, 'history-expired');
    assert.equal(reset.events.length, 0); assert.equal(reset.cursor, ANNOTATION_EVENT_RETENTION + 3);
    assert.equal(reset.snapshotUrl, '/api/annotations/spaces/default?after=0');
    assert.equal(store.changes('default').entries[0].revision, ANNOTATION_EVENT_RETENTION + 2);
    assert.deepEqual(mergeAnnotationEvents(store.events('default').events, reset), []);
    const page = store.events('default', 3);
    assert.equal(page.resetRequired, false); assert.equal(page.events.length, 100); assert.equal(page.more, true);
    assert.equal(page.events[0].sequence, 4); assert.equal(page.cursor, 103);
    const next = store.events('default', page.cursor);
    assert.equal(next.events[0].sequence, 104);
    assert.equal(store.events('default').events.length, 50);
    const empty = store.events(other.id, reset.cursor);
    assert.equal(empty.more, false); assert.equal(empty.resetRequired, false); assert.equal(empty.cursor, reset.cursor);
    assert.throws(() => store.events('default', NaN), { code: 'invalid-event-cursor' });
  } finally { store.close(); }
});

test('event failure rolls back object, clock and idempotency receipt as one transaction', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vp-events-atomic-')), file = path.join(dir, 'annotations.sqlite');
  const store = new AnnotationStore(file), db = openIndexDatabase(file);
  try {
    db.exec("CREATE TRIGGER reject_event BEFORE INSERT ON annotation_events BEGIN SELECT RAISE(ABORT,'event write failed'); END;");
    assert.throws(() => store.mutate('default', command(), actor), /event write failed/);
    assert.equal(store.read('default', 'mark'), null); assert.equal(store.events('default').head, 0);
    db.exec('DROP TRIGGER reject_event');
    assert.equal(store.mutate('default', command(), actor).revision, 1);
    assert.equal(store.events('default').events.length, 1);
  } finally { db.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('v1 databases keep receipts and records while announcing the unavailable event history', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vp-events-migrate-')), file = path.join(dir, 'annotations.sqlite');
  let store = new AnnotationStore(file);
  try {
    const create = command(), first = store.mutate('default', create, actor);
    store.close();
    const db = openIndexDatabase(file);
    db.exec('DROP TABLE annotation_events; DROP TABLE annotation_event_floor; PRAGMA user_version=1;'); db.close();
    store = new AnnotationStore(file);
    assert.deepEqual(store.mutate('default', create, actor), first);
    assert.equal(store.events('default', 0).resetRequired, true);
    assert.equal(store.events('default').events.length, 0);
    store.mutate('default', { ...create, operationId: 'after-upgrade', revision: 1 }, actor);
    assert.equal(store.events('default', 1).events[0].revision, 2);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('candidate/CAMBI-capable database v5 keeps old records/receipts and rejects future schemas',()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'vp-candidate-schema-')),file=path.join(dir,'annotations.sqlite');let store:AnnotationStore|undefined=new AnnotationStore(file);
 try{const op=command(),record=store.mutate('default',op,actor);store.close();store=undefined;let db=openIndexDatabase(file);db.exec('PRAGMA user_version=3');db.close();store=new AnnotationStore(file);assert.deepEqual(store.read('default',record.id),record);assert.deepEqual(store.mutate('default',op,actor),record);store.close();store=undefined;db=openIndexDatabase(file);assert.equal(db.prepare('PRAGMA user_version').get()!.user_version,5);db.exec('PRAGMA user_version=6');db.close();assert.throws(()=>new AnnotationStore(file),/更新的程序/);
 }finally{store?.close();rmSync(dir,{recursive:true,force:true});}
});
