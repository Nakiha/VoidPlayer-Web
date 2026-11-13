import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rename, rm, chmod } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { MediaLibraryIndex, mediaId, scanLibrary } from '../../server/library.ts';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import { openIndexDatabase } from '../../server/sqlite.ts';
import { createMediaServer } from '../../server/app.ts';

async function fixture(run: (root: string, media: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vp-index-'));
  const media = path.join(root, 'media'); await mkdir(media);
  let failure: unknown;
  try { await run(root, media); } catch (error) { failure = error; }
  try {
    // Use the same bounded sharing-error retry policy under Node and Bun,
    // after all owned SQLite connections have been explicitly closed.
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

test('explicit library file commands move, rename and delete without overwriting or escaping mounts', async () => fixture(async (root,media) => {
  const other=path.join(root,'other'),outside=path.join(root,'outside');
  for (const directory of [other,outside,path.join(media,'target'),path.join(media,'protected'),path.join(media,'pack')]) await mkdir(directory);
  for (const name of ['a.mp4','b.mp4','c.mp4','d.mp4']) await writeFile(path.join(media,name),name);
  await writeFile(path.join(media,'pack','notes.txt'),'folder contents');
  await writeFile(path.join(media,'pack','clip.mp4'),'nested');
  await writeFile(path.join(media,'target','c.mp4'),'do not overwrite');
  await writeFile(path.join(outside,'secret.mp4'),'outside');
  await fs.symlink(outside,path.join(media,'link'),process.platform==='win32'?'junction':'dir');
  const index=new MediaLibraryIndex([{id:'a',path:media},{id:'b',path:other},{id:'nested',path:path.join(media,'protected')}],{watch:false});
  await index.refresh();
  const server=createMediaServer({roots:[media,other],library:index,onLog(){}});
  await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const call=(body:unknown,origin=base) => fetch(base+'/api/library/files',{method:'POST',headers:{origin,'content-type':'application/json','x-voidplayer-action':'library-files'},body:JSON.stringify(body)});
  const file=(name:string,rootId='a') => {
    const entry=index.browse({rootId,recursive:true}).entries.find(entry => entry.name===name)!;
    assert.ok(entry,`indexed ${rootId}/${name}`);
    return {rootId,path:name,kind:'file' as const,version:entry.version};
  };
  const target={rootId:'a',directory:'target'};
  const link=fs.link,unlink=fs.unlink,renameFile=fs.rename;
  try {
    const move={operation:'move',sources:[file('a.mp4'),file('b.mp4')],target};
    assert.equal((await call(move,'http://different.invalid')).status,403);
    assert.equal((await call({...move,sources:[{...file('a.mp4'),version:'0'.repeat(24)}]})).status,409);
    for (const value of ['../secret.mp4','/secret.mp4','a\\secret.mp4','']) assert.equal((await call({operation:'delete',sources:[{...file('a.mp4'),path:value}]})).status,400);
    assert.equal((await call({operation:'move',sources:[file('a.mp4')],target:{rootId:'a',directory:'link'}})).status,409);
    assert.equal((await call({operation:'delete',sources:[{rootId:'a',path:'protected',kind:'directory'}]})).status,409);
    assert.equal((await call({operation:'move',sources:[{rootId:'a',path:'pack',kind:'directory'}],target:{rootId:'a',directory:'pack'}})).status,400);
    assert.equal((await call({operation:'move',sources:[file('c.mp4'),file('d.mp4')],target})).status,409);
    assert.equal(await fs.readFile(path.join(media,'d.mp4'),'utf8'),'d.mp4','whole-batch conflict validation precedes all writes');
    const moved=await (await call(move)).json();
    assert.equal(moved.indexRefreshed,true);assert.ok(moved.results.every((item:{ok:boolean}) => item.ok));
    assert.equal(await fs.readFile(path.join(media,'target/a.mp4'),'utf8'),'a.mp4');
    assert.equal(index.browse({rootId:'a',directory:''}).entries.some(entry => entry.name==='a.mp4'),false);
    assert.equal((await call(move)).status,404,'a repeated uncertain request cannot act on a missing original');
    const renamed=await (await call({operation:'rename',source:file('target/a.mp4'),name:'renamed.mp4'})).json();
    assert.equal(renamed.results[0].ok,true);assert.ok(file('target/renamed.mp4'));
    const deleted=await (await call({operation:'delete',sources:[file('target/b.mp4')]})).json();
    assert.equal(deleted.results[0].ok,true);await assert.rejects(fs.stat(path.join(media,'target/b.mp4')),{code:'ENOENT'});
    const folder=await (await call({operation:'move',sources:[{rootId:'a',path:'pack',kind:'directory'}],target:{rootId:'b',directory:''}})).json();
    assert.equal(folder.results[0].ok,true);assert.equal(await fs.readFile(path.join(other,'pack/notes.txt'),'utf8'),'folder contents');
    assert.ok(file('pack/clip.mp4','b'));
    // Exercise the cross-volume file path without needing a second test volume.
    fs.link=(async () => {throw Object.assign(new Error('cross device'),{code:'EXDEV'});}) as typeof fs.link;
    const copied=await (await call({operation:'move',sources:[file('d.mp4')],target:{rootId:'b',directory:''}})).json();
    assert.equal(copied.results[0].ok,true);assert.equal(await fs.readFile(path.join(other,'d.mp4'),'utf8'),'d.mp4');
    fs.link=link;
    // Failure after an exclusive destination exists retains both copies and reports failure.
    fs.unlink=(async (...args:Parameters<typeof fs.unlink>) => {
      if (String(args[0]).endsWith(path.sep+'c.mp4')) throw Object.assign(new Error('source busy'),{code:'EACCES'});
      return unlink(...args);
    }) as typeof fs.unlink;
    const partial=await (await call({operation:'move',sources:[file('c.mp4')],target:{rootId:'b',directory:''}})).json();
    assert.equal(partial.results[0].ok,false);assert.equal(await fs.readFile(path.join(media,'c.mp4'),'utf8'),'c.mp4');
    assert.equal(await fs.readFile(path.join(other,'c.mp4'),'utf8'),'c.mp4');fs.unlink=unlink;
    // A running write owns its lifetime; concurrent commands/configuration cannot race it.
    let entered!:()=>void,release!:()=>void;
    const started=new Promise<void>(resolve => {entered=resolve;}),gate=new Promise<void>(resolve => {release=resolve;});
    fs.rename=(async (...args:Parameters<typeof fs.rename>) => {entered();await gate;return renameFile(...args);}) as typeof fs.rename;
    const pending=call({operation:'rename',source:{rootId:'b',path:'pack',kind:'directory'},name:'renamed-pack'});
    await started;
    try {
      assert.equal((await call({operation:'delete',sources:[file('d.mp4','b')]})).status,409);
      await assert.rejects(index.reconfigure([],async () => async () => {}),{status:409});
    } finally {release();}
    assert.equal((await (await pending).json()).results[0].ok,true);
    fs.rename=renameFile;
    const removedFolder=await (await call({operation:'delete',sources:[{rootId:'b',path:'renamed-pack',kind:'directory'}]})).json();
    assert.equal(removedFolder.results[0].ok,true);await assert.rejects(fs.stat(path.join(other,'renamed-pack')),{code:'ENOENT'});
    // Shutdown waits for the accepted physical write; an interrupted rescan is explicit.
    let deleting!:()=>void,finishDelete!:()=>void,stopped=false;
    const deleteStarted=new Promise<void>(resolve => {deleting=resolve;}),deleteGate=new Promise<void>(resolve => {finishDelete=resolve;});
    fs.unlink=(async (...args:Parameters<typeof fs.unlink>) => {deleting();await deleteGate;return unlink(...args);}) as typeof fs.unlink;
    const deletingReply=call({operation:'delete',sources:[file('d.mp4','b')]});
    await deleteStarted;
    const shutdown=index.stopExecution().then(() => {stopped=true;});
    try {await new Promise<void>(resolve => setImmediate(resolve));assert.equal(stopped,false);}
    finally {finishDelete();}
    const duringShutdown=await (await deletingReply).json();
    assert.equal(duringShutdown.results[0].ok,true);assert.equal(duringShutdown.indexRefreshed,false);
    await shutdown;assert.equal(stopped,true);
    await assert.rejects(fs.stat(path.join(other,'d.mp4')),{code:'ENOENT'});
    assert.equal(await fs.readFile(path.join(outside,'secret.mp4'),'utf8'),'outside');
  } finally {
    fs.link=link;fs.unlink=unlink;fs.rename=renameFile;
    server.closeAllConnections();await new Promise<void>(resolve => server.close(() => resolve()));await index.close();
  }
}));

test('browse validators skip unchanged row queries while retaining scope, revision and content checks', async () => fixture(async (root, media) => {
  await writeFile(path.join(media, 'one.mp4'), 'video');
  const index = new MediaLibraryIndex([media], { database: path.join(root, 'library.sqlite'), watch: false, settleMs: 0 });
  await index.refresh();
  const server = createMediaServer({ roots: [media], library: index, onLog() {} });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/library/browse`;
  const browse = index.browse.bind(index); let rowQueries = 0;
  index.browse = query => { rowQueries++; return browse(query); };
  try {
    const first = await fetch(base + '?limit=1'), etag = first.headers.get('etag')!;
    const page = await first.json(); assert.equal(page.entries.length, 1); assert.ok(etag);
    const unchanged = await fetch(base + `?limit=1&revision=${page.revision}`, { headers: { 'if-none-match': etag } });
    assert.equal(unchanged.status, 304); assert.equal(await unchanged.text(), ''); assert.equal(rowQueries, 1);
    assert.equal((await fetch(base + '?limit=2', { headers: { 'if-none-match': etag } })).status, 200);
    assert.equal((await fetch(base + '?directory=..', { headers: { 'if-none-match': '*' } })).status, 400);
    assert.equal((await fetch(base + `?revision=${page.revision + 1}`, { headers: { 'if-none-match': '*' } })).status, 409);
    await writeFile(path.join(media, 'two.mp4'), 'second'); await index.refresh();
    const changed = await fetch(base + '?limit=1', { headers: { 'if-none-match': etag } });
    assert.equal(changed.status, 200); assert.notEqual(changed.headers.get('etag'), etag);
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await index.close();
  }
}));

test('HTTP browse and conditional polling serve cached results while shared directory checks are stalled', async () => fixture(async (root, media) => {
  for (const directory of ['hot/deep', 'cold']) await mkdir(path.join(media, directory), { recursive: true });
  await writeFile(path.join(media, 'hot/one.mp4'), 'video');
  let now = Date.now();
  const index = new MediaLibraryIndex([{ id: 'archive', path: media }], { watch: false, now: () => now, scanDelayMs: 10 });
  await index.refresh();
  const server = createMediaServer({ roots: [media], library: index, onLog() {} });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const original = fs.readdir, visited: string[] = [];
  let release: () => void = () => {}, blocked = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const hot = await fs.realpath(path.join(media, 'hot'));
  fs.readdir = (async (...args: Parameters<typeof original>) => {
    visited.push(String(args[0]));
    if (String(args[0]) === hot) { blocked = true; await gate; }
    return original(...args);
  }) as typeof original;
  try {
    await writeFile(path.join(media, 'hot/two.mp4'), 'new');
    now += 31000; index.start();
    // A global search observes the existing catalog without requesting a disk walk.
    for (const search of ['two', 'one']) {
      const response = await fetch(`${base}/api/library/browse?recursive=1&search=${search}`, { signal: AbortSignal.timeout(2000) });
      assert.equal(response.status, 200); await response.json();
    }
    await new Promise(r => setTimeout(r, 30)); assert.deepEqual(visited, []);
    const url = `${base}/api/library/browse?root=archive&directory=hot`;
    const cached = await fetch(url, { signal: AbortSignal.timeout(2000) });
    assert.deepEqual((await cached.json()).entries.map((e: { name: string }) => e.name), ['hot/one.mp4']);
    const deadline = Date.now() + 3000;
    while (!blocked) { assert.ok(Date.now() < deadline, 'directory observation did not schedule work'); await new Promise(r => setTimeout(r, 10)); }
    const current = await fetch(url); const etag = current.headers.get('etag')!; const page = await current.json();
    assert.equal((await fetch(url, { headers: { 'if-none-match': etag }, signal: AbortSignal.timeout(2000) })).status, 304);
    await Promise.all(['one', 'two', 'video'].map(async search => {
      const response = await fetch(url + `&search=${search}`, { signal: AbortSignal.timeout(2000) });
      assert.equal(response.status, 200); await response.json();
    }));
    const range = await fetch(`${base}/api/media/${page.entries[0].id}/content?v=${page.entries[0].version}`,
      { headers: { range: 'bytes=0-1' }, signal: AbortSignal.timeout(2000) });
    assert.equal(range.status, 206); assert.equal(await range.text(), 'vi');
    assert.deepEqual(visited, [hot], 'clients and changing keywords must share one shallow check');
    release();
    while (index.status().scanning) await new Promise(r => setTimeout(r, 10));
    const updated = await fetch(url); assert.equal((await updated.json()).entries.length, 2);
    await new Promise(r => setTimeout(r, 40)); assert.deepEqual(visited, [hot], 'fresh scopes must stay cooled down');
  } finally {
    release(); fs.readdir = original; server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve())); await index.close();
  }
}));

test('persistent index reopens offline, preserves identities on root relocation and rejects a second writer', async () => fixture(async (root, media) => {
  const file = path.join(media, 'one.mp4'); await writeFile(file, 'video');
  const database = path.join(root, 'library.sqlite');
  let index = new MediaLibraryIndex([{ id: 'archive', path: media }], { database });
  await index.refresh();
  const before = index.browse().entries[0];
  assert.equal(await index.resolve(mediaId(media,'one.mp4')), null, 'path hashes are not asset aliases');
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
  assert.equal(await index.resolve(mediaId(media,'one.mp4')), null, 'absolute-path aliases are not accepted');
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

test('replacing a root identity does not silently adopt assets from an unrelated root', async () => fixture(async (root, media) => {
  await writeFile(path.join(media, 'one.mp4'), 'video');
  const database = path.join(root, 'library.sqlite');
  let index = new MediaLibraryIndex([media], { database });
  await index.refresh(); const old = index.browse().entries[0]; await index.close();
  index = new MediaLibraryIndex([{ id: 'archive', path: media }], { database });
  try {
    await index.refresh();
    assert.equal(await index.resolve(old.id, old.version),null);
    assert.notEqual(index.browse().entries[0].id,old.id);
  } finally { await index.close(); }
}));

test('page revisions remain stable across unchanged scans and invalidate changed results', async () => fixture(async (root, media) => {
  await writeFile(path.join(media, 'one.mp4'), 'video');
  const index = new MediaLibraryIndex([media]);
  try {
    await index.refresh(); const page = index.browse();
    await index.refresh(); assert.equal(index.browse({ revision: page.revision }).revision, page.revision);
    await writeFile(path.join(media, 'two.mp4'), 'video'); await index.refresh();
    assert.throws(() => index.browse({ revision: page.revision }), /媒体库已更新/);
    assert.equal(index.browse().entries.length, 2);
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
    assert.ok(await Promise.race([index.resolve(index.browse().entries[0].id), timeout]));
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
      const response = await fetch(`${base}/api/media/${entry.id}/content?v=${entry.version}`, { headers: { range: `bytes=${start}-${start + 255}` }, signal: AbortSignal.timeout(2000) });
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
  const db = openIndexDatabase(file); db.exec('PRAGMA user_version=99'); db.close();
  assert.throws(() => new MediaLibraryIndex([media], { database: file }), /更新的程序版本/);
  const check = openIndexDatabase(file); assert.equal(check.prepare('PRAGMA user_version').get()?.user_version, 99); check.close();
}));

test('closing an index database releases files even while a prepared statement remains reachable', async () => fixture(async root => {
  const file = path.join(root, 'held.sqlite');
  const db = openIndexDatabase(file); db.exec('PRAGMA journal_mode=WAL; CREATE TABLE sample(value INTEGER); INSERT INTO sample VALUES(1);');
  const statement = db.prepare('SELECT value FROM sample'); assert.equal(statement.get()?.value, 1);
  db.close();
  await rename(file, file + '.closed');
  assert.throws(() => statement.get(), /finalized|closed|not open/i);
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
  const moduleUrl = new URL('../../server/library.ts', import.meta.url).href;
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
      await index.refresh(); assert.ok(await index.resolve(index.browse().entries[0].id));
    } finally { await index.close(); }
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const done = once(child, 'exit'); child.kill('SIGKILL'); await done; }
  }
}));


test('owned relocation preserves asset identity and pinned content across roots and restart', async () => fixture(async (root, media) => {
  const other = path.join(root, 'other'); await mkdir(other);
  await writeFile(path.join(media, 'asset.mp4'), 'original bytes');
  const database = path.join(root, 'assets.sqlite'), roots = [{id:'a',path:media},{id:'b',path:other}];
  let library = new MediaLibraryIndex(roots, {database,watch:false});
  try {
    await library.refresh();
    const original = library.browse({rootId:'a'}).entries[0];
    const moved = await library.mutateFiles({operation:'move',sources:[{rootId:'a',path:'asset.mp4',kind:'file',version:original.version}],target:{rootId:'b',directory:''}});
    assert.equal(moved.results[0].ok, true);
    assert.equal(library.metadata(original.id)?.rootId, 'b');
    assert.equal(library.metadata(original.id)?.version, original.version);
    assert.equal(await library.resolve(original.id, original.version), await fs.realpath(path.join(other,'asset.mp4')));
    await writeFile(path.join(media,'asset.mp4'), 'different asset'); await library.refresh();
    assert.notEqual(library.browse({rootId:'a'}).entries[0].id, original.id, 'reusing a path cannot steal a moved asset identity');
    await library.close(); library = new MediaLibraryIndex(roots, {database,watch:false}); await library.refresh();
    assert.equal(await library.resolve(original.id, original.version), await fs.realpath(path.join(other,'asset.mp4')));
    await writeFile(path.join(other,'asset.mp4'), 'replaced content'); await library.refresh();
    assert.equal(await library.resolve(original.id, original.version), null, 'external content changes invalidate the pinned version');
  } finally { await library.close(); }
}));

test('a rescan between source resolution and opening cannot serve new bytes under an old version', async () => fixture(async (_root,media) => {
  const file=path.join(media,'race.mp4');await writeFile(file,'original');
  const library=new MediaLibraryIndex([media],{watch:false});await library.refresh();
  const entry=library.browse().entries[0],resolve=library.resolve.bind(library);
  let changed=false;
  library.resolve=async(id,version)=>{
    const result=await resolve(id,version);
    if(result&&!changed){changed=true;await writeFile(file,'replacement bytes');await library.refresh();}
    return result;
  };
  const server=createMediaServer({roots:[media],library,onLog(){}});
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));
  try {
    const response=await fetch(`http://127.0.0.1:${(server.address() as {port:number}).port}/api/media/${entry.id}/content?v=${entry.version}`);
    assert.equal(response.status,409);assert.notEqual(await response.text(),'replacement bytes');
  } finally {server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));await library.close();}
}));
