import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { MediaLibraryIndex } from '../../server/library.ts';
import { DirectoryChanges, DirectoryWatchHints } from '../../server/library-watch.ts';
import { LibraryScanScheduler } from '../../server/library-scheduler.ts';
import { LibraryStore, normalizeRoots } from '../../server/library-store.ts';
import { openIndexDatabase } from '../../server/sqlite.ts';

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

test('an unconfigured library is ready without a scan but a fresh configured root waits for its first check', async () => fixture(async (_root, media) => {
  const empty = new MediaLibraryIndex([]), configured = new MediaLibraryIndex([media]);
  try {
    assert.equal(empty.ready, true, 'a new portable installation needs no media scan');
    assert.equal(empty.status().ready, true);
    assert.deepEqual((await empty.list()).entries, []);
    assert.equal(configured.ready, false, 'configured roots retain their initial check requirement');
    await empty.reconfigure([media], async () => async () => {});
    assert.equal(empty.ready, false, 'adding a first root must not inherit empty-library readiness');
    await empty.reconfigure([], async () => async () => {});
    assert.equal(empty.ready, true, 'removing all roots restores empty-library readiness');
  } finally { await Promise.all([empty.close(), configured.close()]); }
}));

test('a subtree scan updates additions and deletions without traversing or clearing its siblings', async () => fixture(async (root, media) => {
  for (const directory of ['a/deep', 'ab', 'b']) await fs.mkdir(path.join(media, directory), { recursive: true });
  for (const file of ['a/old.mp4', 'a/deep/keep.mp4', 'ab/sibling.mp4', 'b/sibling.mp4']) await fs.writeFile(path.join(media, file), 'video');
  const index = new MediaLibraryIndex([{ id: 'archive', path: media }]);
  try {
    await index.refresh(); const initial = index.browse({ recursive: true }).entries;
    assert.deepEqual(index.status().inventory,{media:4,pending:0});
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
    await index.refreshDirectories([{rootId:'archive',directory:'a/deep'}]);
    assert.equal(index.status().job?.files,1,'a small incremental pass only visits its own media');
    assert.deepEqual(index.status().inventory,{media:4,pending:0},'inventory remains library-wide after the one-file pass');
    assert.equal(index.status().scanMode,null,'an idle scanner does not claim a live full scan');
    await assert.rejects(index.refreshDirectories([{ rootId: 'archive', directory: '../outside' }]), /无效/);
    await assert.rejects(index.refreshDirectories([{ rootId: 'unknown', directory: '' }]), /无效/);
    await fs.rename(path.join(media, 'a'), path.join(root, 'offline-a'));
    await index.refreshDirectories([{ rootId: 'archive', directory: 'a' }]);
    assert.equal(index.status().roots[0].state, 'partial');
    assert.ok(index.browse({ recursive: true }).entries.some(e => e.name === 'a/deep/keep.mp4'));
    await index.refresh(); assert.deepEqual(index.browse({ recursive: true }).entries.map(e => e.name), ['ab/sibling.mp4']);
    assert.deepEqual(index.status().inventory,{media:1,pending:0},'missing entries invalidate the inventory cache');
  } finally { await index.close(); }
}));

test('an explicit root scan never broadens an uninitialized library and keeps duplicate requests owned until completion', async () => fixture(async (root, media) => {
  const sibling=path.join(root,'sibling');await fs.mkdir(sibling);
  await fs.writeFile(path.join(media,'target.mp4'),'target');await fs.writeFile(path.join(sibling,'untouched.mp4'),'other');
  const index=new MediaLibraryIndex([{id:'target',path:media},{id:'other',path:sibling}]);
  const original=fs.readdir, target=await fs.realpath(media);
  let release:()=>void=()=>{}, blocked=false;
  const gate=new Promise<void>(resolve => {release=resolve;});
  try {
    fs.readdir=(async (...args:Parameters<typeof original>) => {
      if (String(args[0])===target && !blocked) {blocked=true;await gate;}
      return original(...args);
    }) as typeof original;
    const pending=index.refreshRoot('target');await until(()=>blocked,'root scan did not reach its directory');
    assert.equal(index.refreshRoot('target'),pending,'repeat clicks reuse the actual pending work');
    assert.equal(index.status().roots.find(root => root.id==='target')!.scanRequested,true);
    assert.equal(index.status().roots.find(root => root.id==='other')!.scanRequested,false);
    release();await pending;
    assert.deepEqual(index.browse({recursive:true}).entries.map(entry => entry.name),['target.mp4']);
    assert.equal(index.status().roots.find(root => root.id==='other')!.scannedAt,null,'the other root was not scanned');
    assert.equal(index.status().roots.find(root => root.id==='target')!.scanRequested,false);
    await assert.rejects(index.refreshRoot('unknown'),/无效/);
  } finally {release();fs.readdir=original;await index.close();}
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
    assert.equal(index.status().scanning,true);assert.equal(index.status().scanMode,'incremental');
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
    assert.deepEqual(index.status().inventory,{media:1,pending:1},'inventory explicitly reports settling files');
    now += 151;
    await until(() => index.browse({ recursive: true }).entries[0].state === 'ready' && !index.status().scanning, 'pending file did not finish settling');
    assert.equal(index.status().job?.visited, 1);
    assert.deepEqual(index.status().inventory,{media:1,pending:0},'settling updates the cached inventory without a full rescan');
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

test('directory scheduling shares observations, cools hot scopes and gives cold directories a turn', async () => fixture(async (root, media) => {
  const store = new LibraryStore(); store.configure(normalizeRoots([{ id: 'archive', path: media }]));
  let now = 100000;
  const scheduler = new LibraryScanScheduler(store.db, () => now, 1800000);
  const scope = (directory: string) => ({ rootId: 'archive', directory });
  try {
    for (const directory of ['hot', 'hot/deep', 'hotter', 'cold']) scheduler.remember(scope(directory));
    for (let i = 0; i < 20; i++) scheduler.observe(scope('hot'), true);
    assert.deepEqual(scheduler.next(), scope('hot'));
    scheduler.finish(scope('hot'), true);
    assert.deepEqual(scheduler.next(), scope('hot/deep'), 'recursive scope must not match its similarly named sibling');
    scheduler.finish(scope('hot/deep'), true);
    now += 31000;
    assert.deepEqual(scheduler.next(), scope('hot')); scheduler.finish(scope('hot'), true);
    assert.deepEqual(scheduler.next(), scope(''), 'the fourth foreground slot belongs to oldest background work');
    scheduler.finish(scope(''), true);
    assert.deepEqual(scheduler.next(), scope('hot/deep')); scheduler.finish(scope('hot/deep'), true);
    assert.deepEqual(scheduler.next(), scope('cold')); scheduler.finish(scope('cold'), true);
    assert.deepEqual(scheduler.next(), scope('hotter')); scheduler.finish(scope('hotter'), true);
    assert.equal(scheduler.next(), undefined, 'repeated clients cannot bypass the per-directory cooldown');
    now += 31000;
    scheduler.observe(scope('hot'), true);
    scheduler.finish(scope('hot'), false);
    assert.deepEqual(scheduler.next(), scope('hot/deep'));
    scheduler.finish(scope('hot/deep'), true);
    assert.equal(scheduler.next(), undefined, 'observations cannot bypass failure backoff');
    const shallow = new DirectoryChanges(false);
    shallow.add(scope('hot')); shallow.add(scope('hot/deep'));
    assert.deepEqual(shallow.take(), [scope('hot'), scope('hot/deep')], 'shallow hints must retain child work');
  } finally { store.close(); }
}));

test('automatic discovery checks one directory at a time and retains completed work across restart', async () => fixture(async (root, media) => {
  for (const file of ['root.mp4', 'a/one.mp4', 'a/deep/two.mp4', 'b/three.mp4']) {
    await fs.mkdir(path.dirname(path.join(media, file)), { recursive: true }); await fs.writeFile(path.join(media, file), 'video');
  }
  const database = path.join(root, 'library.sqlite');
  let index = new MediaLibraryIndex([{ id: 'archive', path: media }], { database, watch: false, scanDelayMs: 10 });
  try {
    index.start();
    await until(() => index.browse({ recursive: true }).total === 4 && !index.status().scanning, 'cold discovery did not visit all directories');
    const db = openIndexDatabase(database);
    try {
      assert.equal(db.prepare('SELECT MAX(visited) AS visited FROM scan_jobs').get()?.visited, 1);
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM library_directory_checks WHERE checked_at IS NOT NULL').get()?.count, 4);
    } finally { db.close(); }
    const job = index.status().job?.id; await index.close();
    index = new MediaLibraryIndex([{ id: 'archive', path: media }], { database, watch: false, scanDelayMs: 10 });
    index.start();
    assert.equal(index.browse({ recursive: true }).total, 4, 'cached results must be available synchronously after restart');
    await new Promise(r => setTimeout(r, 60));
    assert.equal(index.status().job?.id, job, 'restart must not schedule another full traversal of fresh directories');
    assert.equal((await index.list()).entries.length, 4, 'legacy reads also return cached records');
    assert.equal(index.status().job?.id, job);
  } finally { await index.close(); }
}));

test('pending directory rechecks survive restart without relying on an in-memory stability timer', async () => fixture(async (root, media) => {
  await fs.mkdir(path.join(media, 'nested')); await fs.writeFile(path.join(media, 'nested/one.mp4'), 'writing');
  const database = path.join(root, 'library.sqlite'); let now = Date.now();
  const options = { database, watch: false, settleMs: 1000, now: () => now, scanDelayMs: 5 };
  let index = new MediaLibraryIndex([{ id: 'archive', path: media }], options);
  try {
    await index.refresh(); assert.equal(index.browse({ recursive: true }).entries[0].state, 'pending');
    await index.close(); now += 1001;
    index = new MediaLibraryIndex([{ id: 'archive', path: media }], options); index.start();
    await until(() => index.browse({ recursive: true }).entries[0]?.state === 'ready' && !index.status().scanning, 'pending work was lost across restart');
    assert.equal(index.status().job?.visited, 1);
  } finally { await index.close(); }
}));

test('directory-only discovery commits partial progress and yields before the entire parent is enumerated', async () => fixture(async (root, media) => {
  // One directory beyond the write batch boundary, with no media-stat awaits
  // to accidentally provide the event-loop yield that directory discovery needs.
  for (let i = 0; i < 65; i++) await fs.mkdir(path.join(media, `child-${i}`));
  const index = new MediaLibraryIndex([{ id: 'archive', path: media }], { watch: false });
  const original = fs.readdir; let visibleAtYield = -1;
  fs.readdir = (async (...args: Parameters<typeof original>) => {
    const result = await original(...args);
    const first = (result as unknown as { isDirectory(): boolean }[])[0], isDirectory = first.isDirectory.bind(first);
    first.isDirectory = () => {
      setImmediate(() => { visibleAtYield = index.browse({ limit: 100 }).directories.length; index.stop(); });
      return isDirectory();
    };
    return result;
  }) as typeof original;
  try {
    index.start();
    await until(() => visibleAtYield >= 0 && !index.status().scanning, 'directory discovery did not yield');
    assert.ok(visibleAtYield > 0 && visibleAtYield < 65, 'clients must observe committed progress before the directory-only loop finishes');
  } finally { fs.readdir = original; await index.close(); }
}));

test('automatic shallow reconciliation removes confirmed deleted subtrees and leaves unvisited siblings intact', async () => fixture(async (root, media) => {
  for (const file of ['a/old.mp4', 'a/deep/old.mp4', 'ab/keep.mp4']) {
    await fs.mkdir(path.dirname(path.join(media, file)), { recursive: true }); await fs.writeFile(path.join(media, file), 'video');
  }
  let now = Date.now();
  const index = new MediaLibraryIndex([{ id: 'archive', path: media }], { watch: false, now: () => now, scanDelayMs: 5 });
  try {
    await index.refresh();
    await fs.rm(path.join(media, 'a/deep'), { recursive: true }); await fs.rm(path.join(media, 'a/old.mp4'));
    await fs.rm(path.join(media, 'ab/keep.mp4')); await fs.writeFile(path.join(media, 'a/new.mp4'), 'new');
    now += 31000; index.start(); index.observeBrowse({ rootId: 'archive', directory: 'a' });
    await until(() => index.browse({ recursive: true }).entries.some(e => e.name === 'a/new.mp4') && !index.status().scanning, 'active directory was not reconciled');
    assert.deepEqual(index.browse({ recursive: true }).entries.map(e => e.name), ['a/new.mp4', 'ab/keep.mp4']);
    assert.equal(index.status().job?.visited, 1);
    assert.equal(index.browse({ rootId: 'archive', directory: 'a' }).directories.length, 0);
  } finally { await index.close(); }
}));

test('timed out automatic IO drains physically before retry or shutdown releases ownership', async () => fixture(async (root, media) => {
  await fs.writeFile(path.join(media, 'one.mp4'), 'video');
  const original = fs.readdir;
  let release: () => void = () => {}, calls = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  fs.readdir = (async (...args: Parameters<typeof original>) => { calls++; await gate; return original(...args); }) as typeof original;
  const index = new MediaLibraryIndex([{ id: 'archive', path: media }], { watch: false, ttlMs: 20, ioTimeoutMs: 30, scanDelayMs: 5 });
  try {
    index.start(); await until(() => index.status().job?.state === 'partial', 'IO timeout was not recorded');
    await new Promise(r => setTimeout(r, 100));
    assert.equal(calls, 1, 'timeouts must not accumulate blocked NFS operations');
    let closed = false; const closing = index.close().then(() => { closed = true; });
    await new Promise(r => setTimeout(r, 20)); assert.equal(closed, false, 'shutdown must retain ownership until IO drains');
    release(); await closing;
  } finally { release(); fs.readdir = original; await index.close(); }
}));
