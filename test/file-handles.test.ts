import test from 'node:test';
import assert from 'node:assert/strict';
import { FileHandleError, handleKey, restoreHandleFile, saveFileHandle, supportsFileHandles } from '../src/file-handles.ts';
import type { FsFileHandle, HandleRecord, HandleStore } from '../src/file-handles.ts';

const memoryStore = () => {
  const map = new Map<string, HandleRecord>();
  const store: HandleStore = {
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
