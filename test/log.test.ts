import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionLog, logData, readLogPage, traceOperation, operationContext, sessionLog, log } from '../src/log.ts';
import type { LogDocument, LogStorage } from '../src/log.ts';
import { retainLogs } from '../src/log-storage.ts';
import { reviewTools } from '../src/agent.ts';
import { ReviewSession } from '../src/session.ts';

function memoryStore() {
  const saved = new Map<string, LogDocument>();
  const storage: LogStorage = { save: async doc => { saved.set(doc.sessionId, structuredClone(doc)); }, list: async () => structuredClone([...saved.values()]) };
  return { storage, saved };
}
test('incremental pages are chronological, nonoverlapping and report retention gaps', () => {
  const journal = new SessionLog(3);
  for (let i = 0; i < 5; i++) journal.append('info', 'session', `event ${i}`);
  const first = journal.read({ limit: 2 });
  assert.deepEqual(first.events.map(e => e.seq), [3, 4]); assert.equal(first.gap, true);
  assert.equal(first.droppedEvents, 2); assert.equal(first.hasMore, true);
  const next = journal.read({ sinceSeq: first.nextSeq, limit: 2 });
  assert.deepEqual(next.events.map(e => e.seq), [5]); assert.equal(next.hasMore, false);
  assert.deepEqual(journal.read({ sinceSeq: next.nextSeq }).events, []);
});
test('level filtering advances the cursor past scanned records without losing eligible events', () => {
  const journal = new SessionLog();
  for (const level of ['info', 'warn', 'debug', 'error', 'info'] as const) journal.append(level, 'session', level);
  const first = journal.read({ level: 'warn', limit: 1 }); assert.equal(first.events[0].seq, 2);
  const next = journal.read({ sinceSeq: first.nextSeq, level: 'warn', limit: 1 });
  assert.equal(next.events[0].seq, 4); assert.equal(next.nextSeq, 5);
  assert.equal(journal.read({ sinceSeq: 5, level: 'error' }).events.length, 0);
});
test('log callers cannot mutate stored payloads, events or export snapshots', () => {
  const journal = new SessionLog(); const data = { nested: { value: 1 } };
  journal.append('info', 'session', 'original', data); data.nested.value = 5;
  const page = journal.read(); page.events[0].msg = 'altered';
  (page.events[0].data as typeof data).nested.value = 3;
  journal.snapshot().events.length = 0;
  assert.equal(journal.read().events[0].msg, 'original');
  assert.deepEqual(journal.read().events[0].data, { nested: { value: 1 } });
});
test('bad cursors and query types are rejected rather than coerced', () => {
  const journal = new SessionLog();
  for (const query of [{ sinceSeq: -1 }, { sinceSeq: 0.5 }, { sinceSeq: 3 }, { limit: 0 }, { limit: 2001 }, { level: '__proto__' }, { level: ['info'] }, { sessionId: '' }, { sessionId: 'different' }]) {
    assert.throws(() => journal.read(query as never));
  }
});
test('payload normalization bounds size, handles cycles and omits note bodies and bytes', () => {
  const cyclic: Record<string, unknown> = { text: 'private note', token: 'private token', bytes: new Uint8Array(10000), huge: 'a'.repeat(100000) }; cyclic.self = cyclic;
  const result = logData(cyclic); const json = JSON.stringify(result);
  assert.ok(json.length < 9000); assert.ok(!json.includes('private note')); assert.ok(!json.includes('private token'));
  assert.match(json, /byteLength/); assert.match(json, /circular/);
  assert.doesNotThrow(() => logData({ get fail() { throw new Error(); } }));
  assert.ok(JSON.stringify(logData(Array.from({ length: 20 }, () => Array.from({ length: 20 }, () => Array(20).fill(123))))).length < 9000);
});
test('saving then creating a new page session preserves prior events under their original id', async () => {
  const { storage } = memoryStore(); const first = new SessionLog();
  await first.attach(storage, { build: 'test' }); first.append('info', 'ui', 'before reload'); await first.flush();
  const second = new SessionLog(); await second.attach(storage, { build: 'new' });
  const old = (await second.archives()).find(d => d.sessionId === first.snapshot().sessionId)!;
  assert.equal(readLogPage(old).events[0].msg, 'before reload');
  assert.notEqual(second.snapshot().sessionId, first.snapshot().sessionId);
  await first.dispose(); await second.dispose();
});
test('quota failures retain memory and expose failure, then recover on retry', async () => {
  const journal = new SessionLog(); let failed = true;
  await journal.attach({ save: async () => { if (failed) throw new Error('quota'); }, list: async () => [] }, {});
  journal.append('warn', 'session', 'retained'); await journal.flush();
  assert.equal(journal.storageState, 'failed'); assert.equal(journal.storageError, 'quota');
  assert.equal(journal.read().events.length, 1);
  failed = false; await journal.flush(); assert.equal(journal.storageState, 'saved');
  await journal.dispose();
});
test('events appended during an in-flight save are not lost or falsely reported as saved', async () => {
  const journal = new SessionLog(); let release!: () => void; const snapshots: LogDocument[] = [];
  const saving = journal.attach({ save: async doc => { snapshots.push(doc); if (snapshots.length === 1) await new Promise<void>(r => { release = r; }); }, list: async () => [] }, {});
  await Promise.resolve(); journal.append('info', 'ui', 'during save'); release(); await saving;
  assert.equal(journal.storageState, 'pending'); await journal.flush();
  assert.equal(snapshots.at(-1)!.events[0].msg, 'during save'); assert.equal(journal.storageState, 'saved');
  await journal.dispose();
});
test('retention bounds session count and excludes expired history', () => {
  const now = Date.now(), current = new SessionLog().snapshot();
  const older = [1, 2, 3, 9].map(days => ({ ...current, sessionId: String(days), startedAt: new Date(now - days * 86400000).toISOString(), updatedAt: new Date(now - days * 86400000).toISOString() }));
  assert.deepEqual(retainLogs(older, current, now).map(d => d.sessionId), [current.sessionId, '1', '2']);
});
test('operation ids survive asynchronous completion and do not leak across overlapping requests', async () => {
  const sinceSeq = sessionLog.read().lastSeq;
  let finish!: () => void;
  const first = traceOperation('ui', 'first', {}, () => {
    const context = operationContext(); assert.equal(context?.source, 'ui');
    return new Promise<void>(r => { finish = r; });
  });
  assert.equal(operationContext(), undefined);
  await traceOperation('agent', 'second', {}, async () => {}); finish(); await first;
  const events = sessionLog.read({ sinceSeq }).events;
  const start = events.find(e => (e.data as { action: string }).action === 'first')!;
  const end = events.at(-1)!;
  assert.equal(start.context!.operationId, end.context!.operationId);
  assert.equal(end.context!.source, 'ui');
  assert.equal((end.data as { status: string }).status, 'completed');
});
test('failed and superseded operations have explicit outcomes with error details', async () => {
  const sinceSeq = sessionLog.read().lastSeq;
  assert.throws(() => traceOperation('ui', 'bad', {}, () => { throw new Error('bad input'); }));
  await assert.rejects(traceOperation('ui', 'stale', {}, async () => { throw new DOMException('replaced', 'AbortError'); }));
  const ends = sessionLog.read({ sinceSeq }).events.filter(e => e.msg === '操作结束');
  assert.deepEqual(ends.map(e => (e.data as { status: string }).status), ['failed', 'cancelled']);
  assert.match(JSON.stringify(ends[0]), /bad input/);
});
test('Agent log polling is quiet and validates fields at execution time', async () => {
  const tools = reviewTools(new ReviewSession(() => {}));
  const read = tools.find(t => t.name === 'get_review_logs')!;
  const before = sessionLog.read().lastSeq;
  await read.execute({ limit: 1 }); await read.execute({ sinceSeq: before });
  assert.equal(sessionLog.read().lastSeq, before);
  for (const bad of [{ limit: 0 }, { limit: '2' }, { sinceSeq: -1 }, { level: 'anything' }]) await assert.rejects(Promise.resolve().then(() => read.execute(bad)));
  assert.throws(() => read.execute({ unexpected: true }));
});
test('Agent mutation validation failures are logged without storing note text', () => {
  const tool = reviewTools(new ReviewSession(() => {})).find(t => t.name === 'add_review_mark')!;
  const sinceSeq = sessionLog.read().lastSeq;
  assert.throws(() => tool.execute({ slot: 'X', text: 'note body must not leak' }));
  const json = JSON.stringify(sessionLog.read({ sinceSeq }));
  assert.ok(!json.includes('note body must not leak')); assert.match(json, /failed/);
});
