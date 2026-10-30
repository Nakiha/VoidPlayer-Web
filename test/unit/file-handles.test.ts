import test from 'node:test';
import assert from 'node:assert/strict';
import { FileHandleError, handleKey, restoreHandleFile, saveFileHandle, supportsFileHandles } from '../../src/services/file-handles.ts';
import type { FsFileHandle, HandleRecord, HandleStore } from '../../src/services/file-handles.ts';

const memoryStore = () => {
  const map = new Map<string, HandleRecord>();
  const store: HandleStore = {
    putMany: async records=>{for(const record of records)map.set(record.key,record);},
    get: async key => map.get(key),
    put: async record => { map.set(record.key, record); },
    remove: async key => { map.delete(key); },
    trim: async () => {},
  };
  return { store, map };
};
const file = (overrides = {}) => ({ name: 'a.mp4', size: 10, lastModified: 7, ...overrides });
const handle = (overrides = {}) => ({ queryPermission: async () => 'granted', requestPermission: async () => 'granted', getFile: async () => file(), ...overrides });

test('file handles are unavailable without browser APIs', () => {
  assert.equal(supportsFileHandles(), false);
});

test('unsupported persistent local access is distinct from a missing stored handle', async () => {
  await assert.rejects(restoreHandleFile('k'), error => error instanceof FileHandleError && error.kind === 'unsupported');
  const { store } = memoryStore();
  await assert.rejects(restoreHandleFile('k', store), error => error instanceof FileHandleError && error.kind === 'unavailable');
});

test('granted handles restore the fingerprinted file', async () => {
  const { store } = memoryStore();
  await saveFileHandle('k', handle() as unknown as FsFileHandle, file(), store);
  const restored = await restoreHandleFile('k', store);
  assert.deepEqual({ ...restored }, file());
});

test('prompted grants continue in one gesture, refusals stay denied', async () => {
  const { store } = memoryStore();
  let requested = 0;
  const asking = handle({ queryPermission: async () => 'prompt', requestPermission: async () => { requested++; return 'granted'; } });
  await saveFileHandle('k', asking as unknown as FsFileHandle, file(), store);
  await restoreHandleFile('k', store);
  assert.equal(requested, 1);
  const refusing = handle({ queryPermission: async () => 'prompt', requestPermission: async () => 'denied' });
  await saveFileHandle('d', refusing as unknown as FsFileHandle, file(), store);
  await assert.rejects(restoreHandleFile('d', store), error => error instanceof FileHandleError && error.kind === 'denied');
});

test('changed or vanished files go stale and drop the stored handle', async () => {
  const { store, map } = memoryStore();
  await saveFileHandle('changed', handle({ getFile: async () => file({ size: 11 }) }) as unknown as FsFileHandle, file(), store);
  await assert.rejects(restoreHandleFile('changed', store), error => error instanceof FileHandleError && error.kind === 'stale');
  assert.equal(map.has('changed'), false);
  const gone = handle({ getFile: async () => { const error = new Error('gone'); error.name = 'NotFoundError'; throw error; } });
  await saveFileHandle('gone', gone as unknown as FsFileHandle, file(), store);
  await assert.rejects(restoreHandleFile('gone', store), error => error instanceof FileHandleError && error.kind === 'stale');
  assert.equal(map.has('gone'), false);
  await assert.rejects(restoreHandleFile('missing', store), error => error instanceof FileHandleError && error.kind === 'unavailable');
});

test('handle keys reuse the catalog identity', async () => {
  assert.equal(handleKey(file()), handleKey({ name: 'a.mp4', size: 10, lastModified: 7 }));
});

test('mtime drift commits canonical access before returning, and preserves old workspace aliases',async()=>{
 const {store,map}=memoryStore(),original=file(),changed=file({lastModified:8}),access=handle({getFile:async()=>changed});
 const oldKey=handleKey(original);await saveFileHandle(oldKey,access as unknown as FsFileHandle,original,store);
 const first=await restoreHandleFile(oldKey,store),canonical=handleKey(first);
 assert.notEqual(canonical,oldKey);assert.equal(map.get(canonical)?.lastModified,8);assert.equal(map.get(oldKey)?.lastModified,8);
 assert.deepEqual(await restoreHandleFile(canonical,store),changed);assert.deepEqual(await restoreHandleFile(oldKey,store),changed);
 const saved=store.putMany;store.putMany=async()=>{throw Error('storage aborted');};
 await saveFileHandle(oldKey,access as unknown as FsFileHandle,original,store);
 await assert.rejects(restoreHandleFile(oldKey,store),e=>e instanceof FileHandleError&&e.kind==='unavailable');
 assert.ok(map.get(oldKey),'storage failure must not destroy the recoverable handle');store.putMany=saved;
});

test('IndexedDB request success is provisional until commit; aborted writes never report success',async()=>{
 const {IDBFactory,IDBObjectStore}=await import('fake-indexeddb');
 const {indexedDBHandleStore}=await import('../../src/services/file-handles.ts');
 const previous=globalThis.indexedDB,put=IDBObjectStore.prototype.put;
 globalThis.indexedDB=new IDBFactory();
 try{
  const store=indexedDBHandleStore(),record={key:'committed',name:'file',size:1,lastModified:0,savedAt:0,handle:{kind:'file',name:'file'} as FsFileHandle};
  await store.put(record);assert.ok(await store.get(record.key));
  IDBObjectStore.prototype.put=function(...args:Parameters<typeof put>){const request=put.apply(this,args);request.addEventListener('success',()=>queueMicrotask(()=>this.transaction.abort()));return request;};
  await assert.rejects(store.put({...record,key:'aborted'}));assert.equal(await store.get('aborted'),undefined);
  await assert.rejects(store.putMany([{...record,key:'alias'},{...record,key:'canonical'}]));
  assert.equal(await store.get('alias'),undefined);assert.equal(await store.get('canonical'),undefined);assert.ok(await store.get(record.key));
 }finally{IDBObjectStore.prototype.put=put;globalThis.indexedDB=previous;}
});
