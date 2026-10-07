import 'fake-indexeddb/auto';
import { test } from 'node:test';
import { IDBFactory } from 'fake-indexeddb';
import { AnnotationStorage } from '../../src/annotation-storage.ts';
import { LocalDatabase } from '../../src/local-database.ts';
import assert from 'node:assert/strict';
import { getLocalThumbnail, putLocalThumbnail, closeThumbnailDatabase, LOCAL_THUMB_BYTES, LOCAL_THUMB_COUNT } from '../../src/thumbnails/local-store.ts';
import { WorkspaceCheckpoints, checkpointTabId } from '../../src/workspace-checkpoint.ts';
import { Viewport } from '../../src/viewport.ts';
import type { WorkspaceFile } from '../../src/workspace-file.ts';
const workspace = (): WorkspaceFile => ({ schema: 'voidplayer-workspace', version: 1, generatedAt: new Date().toISOString(), serverUrl: 'http://localhost/', positionUs: 0, tracks: [], media: [], marks: [], viewport: new Viewport().snapshot() });
function open(name: string, version?: number) { return new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open(name, version); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); }
function complete(tx: IDBTransaction) { return new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); }); }

test('legacy thumbnail cache migration enforces byte/count budgets and never touches workspace data', async () => {
  const checkpoint = new WorkspaceCheckpoints(), doc = workspace();
  await checkpoint.save({ id: 'protected', actor: 'owner', updatedAt: 1, document: doc });
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('voidplayer-thumbnails', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('thumbs', { keyPath: 'key' });
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  const tx = db.transaction('thumbs', 'readwrite');
  for (let i = 0; i < 4; i++) tx.objectStore('thumbs').put({ key: `legacy-${i}`, bytes: new ArrayBuffer(10 * 1024 * 1024), updatedAt: i, width: 1, height: 1, sourcePtsUs: 0 });
  await complete(tx); db.close();
  assert.equal(await getLocalThumbnail('legacy-0'), undefined);
  assert.ok(await getLocalThumbnail('legacy-3'));
  for (let i = 0; i <= LOCAL_THUMB_COUNT; i++) assert.ok(await putLocalThumbnail({ key: `new-${i}`, blob: new Blob(['jpeg']), width: 1, height: 1, sourcePtsUs: 0, updatedAt: Date.now() }));
  assert.equal(await getLocalThumbnail('new-0'), undefined);
  assert.ok(await getLocalThumbnail(`new-${LOCAL_THUMB_COUNT}`));
  const inspected = await open('voidplayer-thumbnails');
  const records = await new Promise<any[]>(resolve => { const req = inspected.transaction('lru').objectStore('lru').getAll(); req.onsuccess = () => resolve(req.result); });
  assert.ok(records.length <= LOCAL_THUMB_COUNT); assert.ok(records.reduce((sum, r) => sum + r.bytes, 0) <= LOCAL_THUMB_BYTES);
  assert.deepEqual((await checkpoint.read('owner', 'protected'))?.document, { ...doc, thumbnails: [] });
  inspected.close(); checkpoint.close(); closeThumbnailDatabase();
});
test('checkpoints separate actor/tab records, prefer this tab and preserve comparison conditions', async () => {
  const checkpoint = new WorkspaceCheckpoints(), doc = workspace();
  doc.comparison = { version: 1, colorMode: 'reference', referenceDecode: { decoder: 'hardware', depth: 4 }, presentation: 'voidplayer-sdr-v1', outputColorSpace: 'srgb' };
  await checkpoint.save({ id: 'a', actor: 'one', updatedAt: 1, document: doc });
  await checkpoint.save({ id: 'b', actor: 'one', updatedAt: 2, document: { ...doc, positionUs: 20 } });
  await checkpoint.save({ id: 'c', actor: 'two', updatedAt: 3, document: doc });
  assert.equal((await checkpoint.read('one', 'a'))?.id, 'a');
  assert.equal((await checkpoint.read('one', 'none'))?.id, 'b');
  assert.equal((await checkpoint.read('two', 'a'))?.id, 'c');
  assert.equal(await checkpoint.read('unknown', 'a'), undefined);
  assert.deepEqual((await checkpoint.read('one', 'a'))?.document.comparison, doc.comparison);
  checkpoint.close();
});


test('blocked database opens recover after the old tab closes, without orphan connections', async () => {
  const name = 'vp-blocked-recovery';
  const old = await open(name, 1);
  const connection = new LocalDatabase(name, 2, () => {}, 'blocked');
  await assert.rejects(connection.open(), /blocked/);
  old.close();
  const recovered = await connection.open();
  assert.equal(recovered.version, 2);
  connection.close();
  // Any orphan from the first request would block this upgrade.
  const next = await open(name, 3); next.close();
});

test('version changes invalidate cached connections and closing an in-flight open settles waiters', async () => {
  const connection = new LocalDatabase('vp-version-recovery', 1, db => db.createObjectStore('rows'), 'blocked');
  const first = await connection.open();
  const upgraded = await open('vp-version-recovery', 2); upgraded.close();
  await assert.rejects(connection.open(), { name: 'VersionError' });
  connection.close();
  const old = await open('vp-close-pending', 1);
  const pending = new LocalDatabase('vp-close-pending', 2, () => {}, 'blocked');
  const request = pending.open(); pending.close();
  await assert.rejects(request, { name: 'AbortError' }); old.close();
  const reopened = await pending.open(); assert.equal(reopened.version, 2); pending.close();
  assert.throws(() => first.transaction('rows'), { name: 'InvalidStateError' });
});

test('annotation migration indexes existing records and scopes draft reads; previews share one transaction', async t => {
  const previous = globalThis.indexedDB;
  globalThis.indexedDB = new IDBFactory(); t.after(() => { globalThis.indexedDB = previous; });
  const legacy = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('voidplayer-annotations', 2);
    request.onupgradeneeded = () => { for (const name of ['drafts', 'records', 'previews']) request.result.createObjectStore(name, { keyPath: 'key' }); };
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  const tx = legacy.transaction(['records', 'drafts', 'previews'], 'readwrite');
  for (const space of ['current', 'other']) {
    tx.objectStore('records').put({ key: `${space}/m`, space, id: 'm', revision: 1 });
    for (const actor of ['alice', 'bob']) tx.objectStore('drafts').put({ key: `${actor}/${space}/tab/m`, actor, space, id: 'm' });
  }
  await complete(tx); legacy.close();
  const storage = new AnnotationStorage(); t.after(() => storage.close());
  assert.deepEqual((await storage.records('current')).map(r => r.space), ['current']);
  assert.deepEqual((await storage.drafts('current', 'alice')).map(r => [r.space, r.actor]), [['current', 'alice']]);
  await storage.savePreview('current', 'm', { url: 'jpeg', width: 2, height: 2 });
  await storage.savePreview('other', 'm', { url: 'other', width: 2, height: 2 });
  const previews = await storage.previews('current', ['m', 'missing', 'm']);
  assert.equal(previews.size, 1); assert.equal(previews.get('m')?.url, 'jpeg');
  // Closed connections can be reopened by the same storage instance.
  storage.close(); assert.equal((await storage.records('current')).length, 1);
});


test('reloads reuse their own checkpoint while inherited new-tab storage gets a fresh identity', async () => {
  const previous = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', fresh = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  assert.equal(checkpointTabId(previous, 'reload', fresh), previous);
  assert.equal(checkpointTabId(previous, 'back_forward', fresh), previous);
  assert.equal(checkpointTabId(previous, 'navigate', fresh), fresh);
  assert.equal(checkpointTabId('invalid', 'reload', fresh), fresh);
  const store = new WorkspaceCheckpoints();
  try {
    for (let i = 0; i < 20; i++) await store.save({ id: previous + ':reload-user', actor: 'reload-user', updatedAt: i, document: workspace() });
    assert.equal((await store.list('reload-user')).entries.length, 1);
  } finally { store.close(); }
});

test('checkpoint history pages tied timestamps, isolates users, and refuses stale deletions', async t => {
  const previous = globalThis.indexedDB; globalThis.indexedDB = new IDBFactory(); t.after(() => { globalThis.indexedDB = previous; });
  const store = new WorkspaceCheckpoints(), document = workspace();
  try {
    for (const id of ['a', 'b', 'c', 'd', 'e']) await store.save({ id, actor: 'history', updatedAt: 100, document });
    await store.save({ id: 'other-actor', actor: 'other-history', updatedAt: 200, document });
    const first = await store.list('history', undefined, 2);
    const second = await store.list('history', first.entries.at(-1), 2);
    const last = await store.list('history', second.entries.at(-1), 2);
    assert.deepEqual([...first.entries, ...second.entries, ...last.entries].map(row => row.id), ['e','d','c','b','a']);
    assert.equal(first.more, true); assert.equal(last.more, false);
    assert.equal(await store.exact('history', 'other-actor'), undefined);
    assert.equal(await store.remove('history', 'other-actor', 200), false);
    await store.save({ id: 'e', actor: 'history', updatedAt: 101, document });
    assert.equal(await store.remove('history', 'e', 100), false);
    assert.equal(await store.remove('history', 'e', 101), true);
    assert.equal(await store.exact('history', 'e'), undefined);
  } finally { store.close(); }
});

function isolatedCheckpoints(t: { after(fn: () => void): void }, limits = { count: 100, bytes: 64 * 1024 * 1024 }) {
  const previous = globalThis.indexedDB; globalThis.indexedDB = new IDBFactory();
  const store = new WorkspaceCheckpoints(limits);
  t.after(() => { store.close(); globalThis.indexedDB = previous; }); return store;
}
test('checkpoint count budget serializes competing tabs and never evicts user work', async t => {
  const store = isolatedCheckpoints(t, { count: 2, bytes: 1_000_000 }), document = workspace();
  const saves = await Promise.allSettled(['one','two','three'].map(id => store.save({ id, actor: 'owner', updatedAt: 1, document })));
  assert.equal(saves.filter(result => result.status === 'fulfilled').length, 2);
  const failed = saves.find(result => result.status === 'rejected') as PromiseRejectedResult;
  assert.equal(failed.reason.name, 'CheckpointCapacityError');
  assert.equal((await store.usage('owner')).count, 2);
  const first = (await store.list('owner')).entries[0];
  await store.save({ id: first.id, actor: 'owner', updatedAt: 2, document: { ...document, positionUs: 42 } });
  assert.equal((await store.exact('owner', first.id))?.document.positionUs, 42);
  await store.save({ id: 'separate', actor: 'other', updatedAt: 1, document });
  assert.equal((await store.usage('other')).count, 1);
  await assert.rejects(store.save({ id: 'separate', actor: 'owner', updatedAt: 1, document }), /another actor/);
  assert.equal(await store.remove('owner', first.id, 1), false, 'stale deletion cannot free budget');
  assert.equal(await store.remove('owner', first.id, 2), true);
  await store.save({ id: 'resumed', actor: 'owner', updatedAt: 3, document });
  assert.equal((await store.usage('owner')).count, 2);
});
test('checkpoint byte budget counts UTF-8, rolls back oversized replacements, and resumes after deletion', async t => {
  const store = isolatedCheckpoints(t, { count: 100, bytes: 1000 }), document = workspace();
  await store.save({ id: 'small', actor: 'owner', updatedAt: 1, document });
  const before = await store.usage('owner');
  const record = { id: 'small', actor: 'owner', updatedAt: 1, document };
  assert.equal(before.bytes, new TextEncoder().encode(JSON.stringify(record)).byteLength);
  await assert.rejects(store.save({ ...record, updatedAt: 2, document: { ...document, name: '备份'.repeat(500) } }), { name: 'CheckpointCapacityError' });
  assert.equal((await store.exact('owner', 'small'))?.updatedAt, 1);
  assert.equal((await store.usage('owner')).bytes, before.bytes);
  assert.equal(await store.remove('owner', 'small', 1), true);
  assert.equal((await store.usage('owner')).bytes, 0);
  await store.save({ ...record, document: { ...document, name: '恢复' } });
});
test('v1 checkpoint migration keeps oversized histories and permits shrink-only updates', async t => {
  const store = isolatedCheckpoints(t, { count: 1, bytes: 100 }), document = workspace();
  const legacy = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('voidplayer-workspace-checkpoints', 1);
    request.onupgradeneeded = () => { const rows = request.result.createObjectStore('checkpoints', { keyPath: 'id' }); rows.createIndex('actor-time', ['actor','updatedAt']); };
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  const tx = legacy.transaction('checkpoints', 'readwrite');
  for (const id of ['old-a','old-b']) tx.objectStore('checkpoints').put({ id, actor: 'owner', updatedAt: 1, document: { ...document, name: 'legacy-long-name' } });
  await complete(tx); legacy.close();
  const before = await store.usage('owner'); assert.equal(before.count, 2); assert.ok(before.bytes > 100);
  assert.equal((await store.list('owner')).entries.length, 2);
  assert.equal((await store.exact('owner', 'old-a'))?.document.name, 'legacy-long-name');
  await assert.rejects(store.save({ id: 'new', actor: 'owner', updatedAt: 1, document }), { name: 'CheckpointCapacityError' });
  await store.save({ id: 'old-a', actor: 'owner', updatedAt: 1, document });
  assert.ok((await store.usage('owner')).bytes < before.bytes);
  await assert.rejects(store.save({ id: 'old-a', actor: 'owner', updatedAt: 2, document: { ...document, name: 'longer'.repeat(100) } }), { name: 'CheckpointCapacityError' });
  assert.equal((await store.list('owner')).entries.length, 2);
});
