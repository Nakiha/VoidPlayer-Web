import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { MediaLibraryIndex } from '../server/library.ts';
import { DirectoryChanges, DirectoryWatchHints } from '../server/library-watch.ts';

async function fixture(run: (root: string, media: string) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vp-incremental-'));
  const media = path.join(root, 'media'); await fs.mkdir(media);
  try { await run(root, media); }
  finally { await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
}
async function until(check: () => boolean, description: string) {
  const deadline = Date.now() + 8000;
  while (!check()) {
    assert.ok(Date.now() < deadline, description);
    await new Promise(r => setTimeout(r, 20));
  }
}

test('directory hints collapse ancestors and cap a burst without losing an affected root', () => {
  const changes = new DirectoryChanges();
  for (const directory of ['a/b', 'a/c', 'a', 'ab']) changes.add({ rootId: 'one', directory });
  changes.add({ rootId: 'two', directory: 'a/b' });
  assert.deepEqual(changes.take(), [{ rootId: 'one', directory: 'a' }, { rootId: 'one', directory: 'ab' }, { rootId: 'two', directory: 'a/b' }]);
  for (let i = 0; i < 1000; i++) changes.add({ rootId: 'one', directory: `folder-${i}` });
  assert.deepEqual(changes.take(), [{ rootId: 'one', directory: '' }]);
  assert.equal(changes.size, 0);
});

test('a subtree scan updates additions and deletions without traversing or clearing its siblings', async () => fixture(async (root, media) => {
  for (const directory of ['a/deep', 'ab', 'b']) await fs.mkdir(path.join(media, directory), { recursive: true });
  for (const file of ['a/old.mp4', 'a/deep/keep.mp4', 'ab/sibling.mp4', 'b/sibling.mp4']) await fs.writeFile(path.join(media, file), 'video');
  const index = new MediaLibraryIndex([{ id: 'archive', path: media }]);
  try {
    await index.refresh(); const initial = index.browse({ recursive: true }).entries;
    await fs.rm(path.join(media, 'a/old.mp4'));
    await fs.mkdir(path.join(media, 'a/new')); await fs.writeFile(path.join(media, 'a/new/new.mp4'), 'new video');
    // If this directory were accidentally traversed its old record would disappear.
    await fs.rm(path.join(media, 'b/sibling.mp4'));
    await index.refreshDirectories([{ rootId: 'archive', directory: 'a/deep' }, { rootId: 'archive', directory: 'a' }]);
    assert.equal(index.status().job?.visited, 3);
    assert.deepEqual(index.browse({ recursive: true }).entries.map(e => e.name), ['a/deep/keep.mp4', 'a/new/new.mp4', 'ab/sibling.mp4', 'b/sibling.mp4']);
    assert.equal(index.metadata(initial.find(e => e.name === 'a/old.mp4')!.id)?.state, 'missing');
    const revision = index.browse().revision;
    await index.refreshDirectories([{ rootId: 'archive', directory: 'a' }]); assert.equal(index.browse().revision, revision);
    await assert.rejects(index.refreshDirectories([{ rootId: 'archive', directory: '../outside' }]), /无效/);
    await assert.rejects(index.refreshDirectories([{ rootId: 'unknown', directory: '' }]), /无效/);
    await fs.rename(path.join(media, 'a'), path.join(root, 'offline-a'));
    await index.refreshDirectories([{ rootId: 'archive', directory: 'a' }]);
    assert.equal(index.status().roots[0].state, 'partial');
    assert.ok(index.browse({ recursive: true }).entries.some(e => e.name === 'a/deep/keep.mp4'));
    await index.refresh(); assert.deepEqual(index.browse({ recursive: true }).entries.map(e => e.name), ['ab/sibling.mp4']);
  } finally { await index.close(); }
}));

test('changes arriving during a scan are drained and a requested full calibration is not swallowed', async () => fixture(async (root, media) => {
  for (const directory of ['left', 'right']) { await fs.mkdir(path.join(media, directory)); await fs.writeFile(path.join(media, directory, 'one.mp4'), 'video'); }
  const index = new MediaLibraryIndex([{ id: 'archive', path: media }]);
  const original = fs.readdir;
  let release: () => void = () => {};
  const gate = new Promise<void>(r => { release = r; });
  try {
    await index.refresh();
    let blocked = false;
    const left = await fs.realpath(path.join(media, 'left'));
    fs.readdir = (async (...args: Parameters<typeof original>) => {
      const result = await original(...args);
      if (String(args[0]) === left && !blocked) { blocked = true; await gate; }
      return result;
    }) as typeof original;
    const first = index.refreshDirectories([{ rootId: 'archive', directory: 'left' }]); await until(() => blocked, 'scan did not reach the gated directory');
    await fs.writeFile(path.join(media, 'left/two.mp4'), 'new'); await fs.writeFile(path.join(media, 'right/two.mp4'), 'new');
    const queued = index.refreshDirectories([{ rootId: 'archive', directory: 'left' }]);
    const full = index.refresh();
    release(); await Promise.all([first, queued, full]);
    assert.equal(index.browse({ recursive: true }).total, 4);
    assert.equal(index.status().job?.visited, 3, 'manual refresh must finish a full scan after the incremental work');
  } finally { release(); fs.readdir = original; await index.close(); }
}));

test('pending media settles with a local rescan instead of rereading the entire library', async () => fixture(async (root, media) => {
  for (const directory of ['left', 'right']) await fs.mkdir(path.join(media, directory));
  await fs.writeFile(path.join(media, 'left/one.mp4'), 'new');
  let now = Date.now();
  const index = new MediaLibraryIndex([{ id: 'archive', path: media }], { settleMs: 150, now: () => now });
  try {
    await index.refresh(); assert.equal(index.browse({ recursive: true }).entries[0].state, 'pending');
    now += 151;
    await until(() => index.browse({ recursive: true }).entries[0].state === 'ready', 'pending file did not settle');
    assert.equal(index.status().job?.visited, 1);
  } finally { await index.close(); }
}));

test('native directory watchers discover nested writes, renames and deletes before periodic calibration', async () => fixture(async (root, media) => {
  await fs.mkdir(path.join(media, 'nested')); await fs.writeFile(path.join(media, 'nested/one.mp4'), 'video');
  const index = new MediaLibraryIndex([{ id: 'archive', path: media }], { ttlMs: 60000, debounceMs: 40 });
  try {
    index.start(); await index.refresh(); assert.ok(Number(index.status().watch?.active) >= 2);
    const first = index.browse({ recursive: true }).entries[0];
    await fs.writeFile(path.join(media, 'nested/one.mp4'), 'replacement video');
    await until(() => index.metadata(first.id)?.version !== first.version, 'watcher did not index changed media');
    await fs.mkdir(path.join(media, 'nested/new')); await fs.writeFile(path.join(media, 'nested/new/two.mp4'), 'video');
    await until(() => index.browse({ recursive: true }).total === 2, 'watcher did not discover a new directory');
    await fs.rename(path.join(media, 'nested/new/two.mp4'), path.join(media, 'nested/new/renamed.mp4'));
    await until(() => index.browse({ recursive: true }).entries.some(e => e.name.endsWith('/renamed.mp4')), 'watcher did not index a rename');
    await fs.rm(path.join(media, 'nested/new'), { recursive: true });
    await until(() => index.browse({ recursive: true }).total === 1 && index.status().watch?.active === 2, 'watcher did not remove a deleted subtree and release its handle');
    index.stop(); assert.equal(index.status().watch, null);
  } finally { await index.close(); }
}));

test('periodic calibration repairs unreported changes and recovers an offline mount without watchers', async () => fixture(async (root, media) => {
  await fs.writeFile(path.join(media, 'one.mp4'), 'video');
  const index = new MediaLibraryIndex([{ id: 'archive', path: media }], { ttlMs: 80, watch: false });
  try {
    index.start(); await index.refresh(); assert.equal(index.status().watch, null);
    await fs.rename(media, path.join(root, 'offline'));
    await until(() => index.status().roots[0].state === 'offline', 'offline state did not update');
    assert.equal(index.browse().total, 1, 'disconnection must not remove cached references');
    await fs.rename(path.join(root, 'offline'), media); await fs.writeFile(path.join(media, 'two.mp4'), 'new');
    await until(() => index.status().roots[0].state === 'ready' && index.browse().total === 2, 'periodic scan did not repair missed events after reconnection');
  } finally { await index.close(); }
}));

test('watch failures and handle limits degrade to calibration and release every owned handle', async () => fixture(async (root, media) => {
  const watcher = new DirectoryWatchHints(() => {}, 1);
  try {
    watcher.add({ rootId: 'absent', directory: '' }, path.join(root, 'absent'));
    assert.deepEqual(watcher.status().unavailableRoots, ['absent']);
    watcher.add({ rootId: 'archive', directory: '' }, media);
    watcher.add({ rootId: 'another', directory: '' }, root);
    assert.equal(watcher.status().active, 1); assert.equal(watcher.status().limited, true);
    watcher.resetRoot('archive'); assert.equal(watcher.status().active, 0);
    watcher.add({ rootId: 'another', directory: '' }, root); assert.equal(watcher.status().active, 1);
  } finally { watcher.close(); }
  assert.equal(watcher.status().active, 0);
}));


test('incremental scopes cannot enter a directory replaced by a symlink', async () => fixture(async (root, media) => {
  await fs.mkdir(path.join(media, 'original')); await fs.mkdir(path.join(media, 'other'));
  await fs.writeFile(path.join(media, 'original/one.mp4'), 'original');
  await fs.writeFile(path.join(media, 'other/two.mp4'), 'other');
  const index = new MediaLibraryIndex([{ id: 'archive', path: media }]);
  try {
    await index.refresh();
    await fs.rename(path.join(media, 'original'), path.join(root, 'moved'));
    await fs.symlink(path.join(media, 'other'), path.join(media, 'original'), process.platform === 'win32' ? 'junction' : 'dir');
    await index.refreshDirectories([{ rootId: 'archive', directory: 'original' }]);
    assert.equal(index.status().roots[0].state, 'partial'); assert.equal(index.errors()[0].code, 'EPERM');
    assert.deepEqual(index.browse({ recursive: true }).entries.map(e => e.name), ['original/one.mp4', 'other/two.mp4']);
  } finally { await index.close(); }
}));

test('cancelling an incremental scan also cancels the full refresh queued behind it', async () => fixture(async (root, media) => {
  await fs.mkdir(path.join(media, 'nested')); await fs.writeFile(path.join(media, 'nested/one.mp4'), 'video');
  const index = new MediaLibraryIndex([{ id: 'archive', path: media }]);
  const original = fs.readdir;
  let release: () => void = () => {}, blocked = false;
  const gate = new Promise<void>(r => { release = r; });
  try {
    await index.refresh(); const directory = await fs.realpath(path.join(media, 'nested'));
    fs.readdir = (async (...args: Parameters<typeof original>) => {
      if (String(args[0]) === directory) { blocked = true; await gate; }
      return original(...args);
    }) as typeof original;
    const scan = index.refreshDirectories([{ rootId: 'archive', directory: 'nested' }]);
    await until(() => blocked, 'scan did not reach cancellation gate');
    const full = index.refresh(), queued = index.refreshDirectories([{ rootId: 'archive', directory: '' }]);
    index.cancel(); await Promise.all([scan, full, queued]);
    assert.equal(index.status().job?.state, 'cancelled'); assert.equal(index.status().scanning, false);
    assert.equal(index.browse({ recursive: true }).total, 1);
  } finally { release(); fs.readdir = original; await index.close(); }
}));
