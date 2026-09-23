import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getLocalThumbnail, putLocalThumbnail, closeThumbnailDatabase, LOCAL_THUMB_BYTES, LOCAL_THUMB_COUNT } from '../src/thumbnails/local-store.ts';
import { WorkspaceCheckpoints } from '../src/workspace-checkpoint.ts';
import { Viewport } from '../src/viewport.ts';
import type { WorkspaceFile } from '../src/workspace-file.ts';
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
