import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rename, rm, chmod } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { MediaLibraryIndex, mediaId, scanLibrary } from '../server/library.ts';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { createMediaServer } from '../server/app.ts';

async function fixture(run: (root: string, media: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vp-index-'));
  const media = path.join(root, 'media'); await mkdir(media);
  let failure: unknown;
  try { await run(root, media); } catch (error) { failure = error; }
  try {
    // Bun's Windows rm does not apply Node's retry options consistently.
    // Retry explicitly, after all owned SQLite connections have been closed.
    for (let attempt = 0; ; attempt++) {
      try { await rm(root, { recursive: true, force: true }); break; }
      catch (error) {
        if (attempt === 10 || !['EBUSY', 'EPERM', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        await new Promise(r => setTimeout(r, (attempt + 1) * 100));
      }
    }
  } catch (error) { if (failure) throw new AggregateError([failure, error], 'Index test and cleanup failed'); throw error; }
  if (failure) throw failure;
}

test('persistent index reopens offline, preserves identities on root relocation and rejects a second writer', async () => fixture(async (root, media) => {
  const file = path.join(media, 'one.mp4'); await writeFile(file, 'video');
  const database = path.join(root, 'library.sqlite');
  let index = new MediaLibraryIndex([{ id: 'archive', path: media }], { database });
  await index.refresh();
  const before = index.browse().entries[0];
  assert.equal(await index.resolve(mediaId(media, 'one.mp4')), await index.resolve(before.id), 'old workspace URL alias');
  assert.throws(() => new MediaLibraryIndex([{ id: 'archive', path: media }], { database }), /另一个实例/);
  await index.close();
  const moved = path.join(root, 'moved'); await rename(media, moved);
  index = new MediaLibraryIndex([{ id: 'archive', path: media }], { database });
  assert.equal(index.ready, true);
  assert.equal(index.browse().entries[0].id, before.id, 'cache readable before touching offline storage');
  await index.refresh(); assert.equal(index.status().roots[0].state, 'offline');
  assert.equal(index.browse().entries.length, 1, 'offline scan must not infer deletion');
  assert.equal(await index.resolve(before.id), null);
  await index.close();
  index = new MediaLibraryIndex([{ id: 'archive', path: moved }], { database });
  await index.refresh();
  assert.equal(index.browse().entries[0].id, before.id);
  assert.ok(await index.resolve(before.id));
  assert.ok(await index.resolve(mediaId(media, 'one.mp4')), 'old absolute-path-derived alias survives relocation');
  await writeFile(path.join(moved, 'one.mp4'), 'replacement');
  assert.equal(await index.resolve(before.id, before.version), null);
  await index.refresh(); assert.notEqual(index.browse().entries[0].version, before.version);
  assert.equal(await index.resolve(before.id, before.version), null, 'rescan must not grant old version access');
  await index.close();
}));

test('index traverses beyond six levels and 5000 files with complete bounded pagination', async () => fixture(async (root, media) => {
  const deep = path.join(media, ...Array.from({ length: 12 }, (_, i) => `level-${i}`)); await mkdir(deep, { recursive: true });
  for (let i = 0; i < 5100; i += 100) await Promise.all(Array.from({ length: 100 }, (_, j) => writeFile(path.join(deep, `${String(i+j).padStart(5, '0')}.mp4`), 'x')));
  const index = new MediaLibraryIndex([media], { database: path.join(root, 'index.sqlite') });
  try {
    await index.refresh();
    const found = new Set<string>();
    for (let offset = 0; ; ) {
      const page = index.browse({ recursive: true, limit: 137, offset });
      assert.ok(page.entries.length <= 137); assert.equal(page.total, 5100);
      page.entries.forEach(e => found.add(e.id));
      if (page.nextOffset === null) break; offset = page.nextOffset;
    }
    assert.equal(found.size, 5100);
    assert.equal(index.browse({ directory: Array.from({ length: 11 }, (_, i) => `level-${i}`).join('/') }).directories[0].name, 'level-11');
    assert.equal(index.browse({ recursive: true, search: '05099' }).entries.length, 1);
    assert.equal(index.errors().length, 0);
  } finally { await index.close(); }
}));

test('legacy path-based workspace IDs survive adopting an explicit root ID', async () => fixture(async (root, media) => {
  await writeFile(path.join(media, 'one.mp4'), 'video');
  const database = path.join(root, 'library.sqlite');
  let index = new MediaLibraryIndex([media], { database });
  await index.refresh(); const old = index.browse().entries[0]; await index.close();
  index = new MediaLibraryIndex([{ id: 'archive', path: media }], { database });
  try {
    await index.refresh();
    assert.ok(await index.resolve(old.id, old.version));
    assert.equal(index.metadata(old.id)?.id, index.browse().entries[0].id);
  } finally { await index.close(); }
}));

test('Range lookup remains available during an unfinished scan and cancellation preserves prior entries', async () => fixture(async (root, media) => {
  await writeFile(path.join(media, 'one.mp4'), 'original');
  let scanning = false, release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const index = new MediaLibraryIndex([media], { scan: async roots => { if (scanning) await gate; return scanLibrary(roots); } });
  try {
    await index.refresh(); scanning = true;
    const next = index.refresh();
    const timeout = new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error('Range waited for scan')), 1000); timer.unref(); });
    assert.ok(await Promise.race([index.resolve(mediaId(media, 'one.mp4')), timeout]));
    index.cancel(); await next;
    assert.equal(index.status().job?.state, 'cancelled');
    assert.equal(index.browse().entries.length, 1);
    release(); scanning = false; await index.refresh();
    assert.equal(index.status().job?.state, 'completed');
  } finally { release(); await index.close(); }
}));

test('recently written media stays pending until stable and deleted files are marked missing', async () => fixture(async (root, media) => {
  const file = path.join(media, 'one.mp4'); await writeFile(file, 'writing');
  let now = Date.now();
  const index = new MediaLibraryIndex([media], { settleMs: 10000, now: () => now });
  try {
    await index.refresh(); const entry = index.browse().entries[0];
    assert.equal(entry.state, 'pending'); assert.equal(await index.resolve(entry.id), null);
    now += 10001; await index.refresh(); assert.ok(await index.resolve(entry.id));
    await writeFile(file, 'replacement'); await index.refresh();
    assert.equal(index.browse().entries[0].state, 'pending');
    now += 10001; await index.refresh(); assert.ok(await index.resolve(entry.id));
    await rm(file); await index.refresh(); assert.equal(index.browse().entries.length, 0);
    assert.equal(await index.resolve(entry.id), null);
  } finally { await index.close(); }
}));

test('four HTTP Range requests finish while a background scan is stalled', async () => fixture(async (root, media) => {
  const bytes = Buffer.alloc(4096, 37); await writeFile(path.join(media, 'one.mp4'), bytes);
  let blocked = false, release: () => void = () => {};
  const gate = new Promise<void>(r => { release = r; });
  const index = new MediaLibraryIndex([media], { scan: async roots => { if (blocked) await gate; return scanLibrary(roots); } });
  await index.refresh();
  const entry = index.browse().entries[0];
  const server = createMediaServer({ roots: index.roots, library: index, onLog: () => {} });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  try {
    blocked = true; const scan = index.refresh();
    await Promise.all(Array.from({ length: 4 }, async (_, i) => {
      const start = i * 512;
      const response = await fetch(`${base}/api/media/${entry.id}?v=${entry.version}`, { headers: { range: `bytes=${start}-${start + 255}` }, signal: AbortSignal.timeout(2000) });
      assert.equal(response.status, 206); assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes.subarray(start, start + 256));
    }));
    assert.equal(index.status().scanning, true);
    index.cancel(); await scan;
  } finally {
    release(); await new Promise<void>(r => server.close(() => r())); await index.close();
  }
}));

test('future database schema is refused without modifying its version', async () => fixture(async (root, media) => {
  const file = path.join(root, 'future.sqlite');
  const db = new DatabaseSync(file); db.exec('PRAGMA user_version=99'); db.close();
  assert.throws(() => new MediaLibraryIndex([media], { database: file }), /更新的程序版本/);
  const check = new DatabaseSync(file); assert.equal(check.prepare('PRAGMA user_version').get()?.user_version, 99); check.close();
}));


test('unreadable subdirectories report partial scans without deleting cached entries', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async () => fixture(async (root, media) => {
  const directory = path.join(media, 'private'); await mkdir(directory);
  await writeFile(path.join(directory, 'one.mp4'), 'video');
  const index = new MediaLibraryIndex([media]);
  try {
    await index.refresh(); await chmod(directory, 0);
    await index.refresh();
    assert.equal(index.status().roots[0].state, 'partial');
    assert.equal(index.errors()[0].path, 'private');
    assert.equal(index.errors()[0].code, 'EACCES');
    assert.equal(index.browse({ recursive: true }).entries.length, 1);
    assert.equal(await index.resolve(mediaId(media, 'private/one.mp4')), null);
  } finally { await chmod(directory, 0o755); await index.close(); }
}));


test('a crashed writer releases the index lock and interrupted scans can resume', async () => fixture(async (root, media) => {
  await writeFile(path.join(media, 'one.mp4'), 'video');
  const database = path.join(root, 'index.sqlite');
  const moduleUrl = new URL('../server/library.ts', import.meta.url).href;
  const code = `import {MediaLibraryIndex} from ${JSON.stringify(moduleUrl)}; const index=new MediaLibraryIndex([${JSON.stringify(media)}],{database:${JSON.stringify(database)},scan:()=>new Promise(()=>{})}); void index.refresh(); process.send('ready'); setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let errors = ''; child.stderr!.on('data', d => { errors += d; });
  try {
    await Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw new Error('Writer exited before ready: ' + errors); })]);
    assert.throws(() => new MediaLibraryIndex([media], { database }), /另一个实例/);
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    const index = new MediaLibraryIndex([media], { database });
    try {
      assert.equal(index.status().job?.state, 'interrupted');
      await index.refresh(); assert.ok(await index.resolve(mediaId(media, 'one.mp4')));
    } finally { await index.close(); }
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const done = once(child, 'exit'); child.kill('SIGKILL'); await done; }
  }
}));
