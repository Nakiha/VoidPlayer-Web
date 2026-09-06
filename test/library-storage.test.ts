import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MediaLibraryIndex } from '../server/library.ts';
import { openIndexDatabase } from '../server/sqlite.ts';

// Real directory and SQLite operations; only the statfs type transition is
// injected. This is regression coverage, not a claim of real SMB/NFS acceptance.
async function fixture(run: (context: { root: string; media: string; database: string; setType: (value: number) => void; open: (folder?: string) => MediaLibraryIndex }) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vp-storage-'));
  const media = path.join(root, 'media'); await fs.mkdir(media);
  const database = path.join(root, 'index.sqlite'), original = fs.statfs;
  const indexes: MediaLibraryIndex[] = [];
  let type = 101;
  fs.statfs = (async (...args: Parameters<typeof original>) => ({ ...await original(...args), type })) as typeof original;
  try { await run({ root, media, database, setType: value => { type = value; }, open: (folder = media) => { const index = new MediaLibraryIndex([{ id: 'archive', path: folder }], { database, watch: false }); indexes.push(index); return index; } }); }
  finally { fs.statfs = original; for (const index of indexes) await index.close(); await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
}

test('empty mount underlay preserves the indexed library across restart and reconnect', async () => fixture(async ({ root, media, setType, open }) => {
  await fs.mkdir(path.join(media, 'nested')); await fs.writeFile(path.join(media, 'nested/one.mp4'), 'original');
  let index = open(); await index.refresh(); const before = index.browse({ recursive: true }).entries[0];
  // A different filesystem must not be served even before the next scan.
  setType(202); assert.equal(await index.resolve(before.id, before.version), null);
  await fs.rename(media, path.join(root, 'disconnected')); await fs.mkdir(media);
  await index.refresh(); assert.equal(index.status().roots[0].state, 'offline');
  assert.deepEqual(index.browse({ recursive: true }).entries, [before]);
  assert.ok(index.errors().some(error => error.code === 'ESTORAGECHANGED'));
  await index.close(); index = open();
  await index.refreshDirectories([{ rootId: 'archive', directory: '' }]);
  assert.deepEqual(index.browse({ recursive: true }).entries, [before]);
  await fs.rm(media, { recursive: true }); await fs.rename(path.join(root, 'disconnected'), media); setType(101);
  await index.refresh(); assert.equal(index.status().roots[0].state, 'ready');
  assert.deepEqual(index.browse({ recursive: true }).entries, [before]);
  assert.ok(await index.resolve(before.id, before.version));
}));

test('filesystem loss during directory enumeration cannot reconcile an empty result as deletion', async () => fixture(async ({ media, setType, open }) => {
  await fs.writeFile(path.join(media, 'one.mp4'), 'original');
  const index = open(); await index.refresh(); const before = index.browse().entries;
  const original = fs.readdir;
  try {
    fs.readdir = (async (...args: Parameters<typeof original>) => { await original(...args); setType(202); return []; }) as unknown as typeof original;
    await index.refresh();
    assert.equal(index.status().roots[0].state, 'offline'); assert.deepEqual(index.browse().entries, before);
  } finally { fs.readdir = original; }
}));

test('unchanged filesystem permits real deletions and explicit root relocation can bind a new filesystem', async () => fixture(async ({ root, media, setType, open }) => {
  await fs.writeFile(path.join(media, 'one.mp4'), 'original');
  let index = open(); await index.refresh(); const before = index.browse().entries[0]; await index.close();
  const moved = path.join(root, 'new-storage'); await fs.rename(media, moved); setType(202);
  index = open(moved); await index.refresh(); assert.equal(index.browse().entries[0].id, before.id); assert.ok(await index.resolve(before.id));
  await fs.rm(path.join(moved, 'one.mp4')); await index.refresh();
  assert.equal(index.browse().total, 0); assert.equal(index.status().roots[0].state, 'ready');
}));

test('schema 1 upgrade preserves media and waits for an unchanged original before learning a storage binding', async () => fixture(async ({ root, media, database, setType, open }) => {
  await fs.writeFile(path.join(media, 'one.mp4'), 'original');
  let index = open(); await index.refresh(); const before = index.browse().entries; await index.close();
  const old = openIndexDatabase(database); old.exec('DROP TABLE root_storage; PRAGMA user_version=1;'); old.close();
  await fs.rename(media, path.join(root, 'disconnected')); await fs.mkdir(media); setType(202);
  index = open(); await index.refresh();
  assert.deepEqual(index.browse().entries, before); assert.equal(index.status().roots[0].state, 'offline');
  assert.ok(index.errors().some(error => error.code === 'ESTORAGEUNVERIFIED'));
  await fs.writeFile(path.join(media, 'one.mp4'), 'wrong underlying filesystem'); await fs.writeFile(path.join(media, 'other.mp4'), 'unrelated');
  await index.refresh(); assert.deepEqual(index.browse().entries, before, 'unverified files must not become trusted on a subsequent scan');
  await index.close(); index = open(); await index.refresh(); assert.deepEqual(index.browse().entries, before);
  await fs.rm(media, { recursive: true }); await fs.rename(path.join(root, 'disconnected'), media); setType(101);
  await index.refresh(); assert.equal(index.status().roots[0].state, 'ready'); assert.deepEqual(index.browse().entries, before);
  await index.close();
  const upgraded = openIndexDatabase(database);
  assert.equal(upgraded.prepare('PRAGMA user_version').get()?.user_version, 2);
  assert.equal(upgraded.prepare('SELECT fs_type FROM root_storage').get()?.fs_type, '101'); upgraded.close();
}));

test('legacy binding rechecks files encountered before its first unchanged original', async () => fixture(async ({ media, database, open }) => {
  await fs.writeFile(path.join(media, 'z-original.mp4'), 'original');
  let index = open(); await index.refresh(); await index.close();
  const old = openIndexDatabase(database); old.exec('DROP TABLE root_storage; PRAGMA user_version=1;'); old.close();
  await fs.writeFile(path.join(media, 'a-new.mp4'), 'new');
  index = open(); await index.refresh();
  await index.refresh(); // drain/reconcile queued work; no unverified deletion
  assert.deepEqual(index.browse().entries.map(entry => entry.name), ['a-new.mp4', 'z-original.mp4']);
  assert.equal(index.status().roots[0].state, 'ready');
}));

test('schema 1 relocation keeps IDs while accepting an explicitly changed root path', async () => fixture(async ({ root, media, database, setType, open }) => {
  await fs.writeFile(path.join(media, 'one.mp4'), 'original');
  let index = open(); await index.refresh(); const before = index.browse().entries[0]; await index.close();
  const old = openIndexDatabase(database); old.exec('DROP TABLE root_storage; PRAGMA user_version=1;'); old.close();
  const moved = path.join(root, 'new-storage'); await fs.mkdir(moved); await fs.writeFile(path.join(moved, 'one.mp4'), 'replacement'); setType(202);
  index = open(moved); await index.refresh();
  assert.equal(index.status().roots[0].state, 'ready'); assert.equal(index.browse().entries[0].id, before.id);
  assert.notEqual(index.browse().entries[0].version, before.version); assert.equal(await index.resolve(before.id, before.version), null);
}));
