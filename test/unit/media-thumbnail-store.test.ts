import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { MediaLibraryIndex } from '../../server/library.ts';
import { AdminController } from '../../server/admin.ts';
import { loadConfig } from '../../server/config.ts';
import { createMediaServer } from '../../server/app.ts';
import { THUMB_RECIPE_VERSION } from '../../shared/thumbnails/contract.ts';
import {promises as fs} from 'node:fs';
import type {LibraryFileRef} from '../../shared/service/library-files.ts';

function jpeg320x240(): Uint8Array<ArrayBuffer> {
  return Uint8Array.from([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0xf0, 0x01, 0x40, 0x01, 0x01, 0x11, 0x00,
    0xff, 0xd9,
  ]);
}

test('owned moves retain ready thumbnails; pending, changed and cache-cleared files do not inherit them', async () => {
  const root=await mkdtemp(path.join(os.tmpdir(),'vp-move-thumbs-'));
  await mkdir(path.join(root,'target'));await mkdir(path.join(root,'pack'));
  for (const name of ['one.mp4','pending.mp4','clear.mp4','pack/child.mp4','pack/changed.mp4']) {
    await writeFile(path.join(root,name),name);
    await fs.utimes(path.join(root,name),new Date(1000),new Date(1000));
  }
  const library=new MediaLibraryIndex([{id:'video',path:root}],{watch:false,settleMs:60000});
  const image=jpeg320x240(),recipe=THUMB_RECIPE_VERSION;
  const entry=(name:string) => library.browse({rootId:'video',recursive:true}).entries.find(item => item.name===name)!;
  const ref=(name:string):LibraryFileRef => ({rootId:'video',path:name,kind:'file',version:entry(name).version});
  const move=(source:LibraryFileRef,directory:string) => library.mutateFiles({operation:'move',sources:[source],target:{rootId:'video',directory}});
  const verify=(name:string) => {
    const item=entry(name);assert.ok(item.version);assert.equal(item.state,'ready',`${name} is immediately available`);
    assert.equal(item.thumbnail,true,`${name} retains its cover in the same metadata commit`);
    assert.deepEqual([...library.thumbnails.get(item.id,item.version,recipe)!.data],[...image]);return item;
  };
  try {
    await library.refresh();
    for (const item of library.browse({rootId:'video',recursive:true}).entries) {
      assert.ok(item.version);
      library.thumbnails.put(item.id,item.version,recipe,library.thumbnails.epoch,image,{width:320,height:240,sourcePtsUs:0});
    }
    const original=entry('one.mp4');
    assert.equal((await move(ref('one.mp4'),'target')).results[0].ok,true);
    const moved=verify('target/one.mp4');assert.notEqual(moved.id,original.id);
    assert.equal((await move(ref('target/one.mp4'),'')).results[0].ok,true);
    const returned=verify('one.mp4');assert.notEqual(returned.version,original.version,'returning to an old path does not reuse its old identity');
    // The existing exclusive-copy fallback needs the same handoff as hard links.
    const link=fs.link;
    fs.link=async () => {throw Object.assign(Error('cross-device'),{code:'EXDEV'});};
    try {assert.equal((await move(ref('one.mp4'),'target')).results[0].ok,true);verify('target/one.mp4');}
    finally {fs.link=link;}
    await writeFile(path.join(root,'pending.mp4'),'still being written');await library.refresh();
    assert.equal(entry('pending.mp4').state,'pending');
    await move(ref('pending.mp4'),'target');
    assert.equal(entry('target/pending.mp4').state,'pending','moving a pending source does not certify it stable');
    assert.equal(entry('target/pending.mp4').thumbnail,false);
    const rename=fs.rename;
    fs.rename=async (...args) => {await rename(...args);await writeFile(path.join(root,'target/pack/changed.mp4'),'external write');};
    try {await move({rootId:'video',path:'pack',kind:'directory'},'target');}
    finally {fs.rename=rename;}
    verify('target/pack/child.mp4');
    assert.equal(entry('target/pack/changed.mp4').thumbnail,false,'a changed child cannot inherit an old cover');
    const unlink=fs.unlink;
    fs.unlink=async (...args) => {library.thumbnails.remove();await unlink(...args);};
    try {await move(ref('clear.mp4'),'target');}
    finally {fs.unlink=unlink;}
    assert.equal(entry('target/clear.mp4').state,'ready');
    assert.equal(entry('target/clear.mp4').thumbnail,false,'a cache clear during movement wins over thumbnail handoff');
    await library.refresh();assert.equal(entry('one.mp4'),undefined,'the source stays missing after another scan');
  } finally {await library.close();await rm(root,{recursive:true,force:true});}
});

test('media thumbnails: status, upload, first-wins, epoch races and version binding', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vp-thumbs-'));
  const media = path.join(root, 'media'); await mkdir(media); await mkdir(path.join(root, 'data'));
  await writeFile(path.join(media, 'one.mp4'), Buffer.alloc(2048, 7));
  const config = await loadConfig(['--folder', media], 'production', root); config.dataDir = path.join(root, 'data');
  const database = path.join(root, 'data', 'library.sqlite');
  const library = new MediaLibraryIndex([media], { database, watch: false }); await library.refresh();
  const entry = library.browse().entries[0];
  assert.ok(entry?.id && entry.version, 'library entry has versioned id');
  const admin = new AdminController(config, library);
  const server = createMediaServer({ roots: [media], library, admin, onLog() {} });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const image = jpeg320x240();
  const statusUrl = `${base}/api/media/${entry.id}/thumbnail-status?v=${entry.version}&recipe=${encodeURIComponent(THUMB_RECIPE_VERSION)}`;
  const imageUrl = `${base}/api/media/${entry.id}/thumbnail?v=${entry.version}&recipe=${encodeURIComponent(THUMB_RECIPE_VERSION)}`;
  const uploadUrl = (epoch: number | string, extra = '') =>
    `${base}/api/media/${entry.id}/thumbnail?v=${entry.version}&recipe=${encodeURIComponent(THUMB_RECIPE_VERSION)}&epoch=${epoch}&w=320&h=240&pts=1000${extra}`;
  const uploadHeaders = (origin = base) => ({ origin, 'x-voidplayer-action': 'thumbnail', 'content-type': 'image/jpeg' });
  try {
    // Missing at first; reads never create work.
    assert.deepEqual(await (await fetch(statusUrl)).json(), { state: 'missing', epoch: 0 });
    assert.equal((await fetch(imageUrl)).status, 404);
    // Validation, not trust.
    assert.equal((await fetch(uploadUrl('x'), { method: 'POST', headers: uploadHeaders(), body: new Blob([image]) })).status, 400);
    assert.equal((await fetch(uploadUrl(0), { method: 'POST', headers: { ...uploadHeaders(), 'content-type': 'text/plain' }, body: new Blob([image]) })).status, 400);
    assert.equal((await fetch(uploadUrl(0), { method: 'POST', headers: uploadHeaders(), body: new Blob([Uint8Array.from([1, 2, 3])]) })).status, 400);
    assert.equal((await fetch(uploadUrl(0), { method: 'POST', headers: uploadHeaders('https://evil.invalid'), body: new Blob([image]) })).status, 403);
    // First valid submission wins.
    assert.equal((await fetch(uploadUrl(0), { method: 'POST', headers: uploadHeaders(), body: new Blob([image]) })).status, 201);
    const status = await (await fetch(statusUrl)).json();
    assert.equal(status.state, 'ready');
    assert.equal(status.width, 320); assert.equal(status.height, 240);
    assert.ok(status.url.endsWith(`/api/media/${entry.id}/thumbnail?v=${entry.version}&recipe=${encodeURIComponent(THUMB_RECIPE_VERSION)}`));
    const got = await fetch(imageUrl);
    assert.equal(got.status, 200);
    assert.equal(got.headers.get('content-type'), 'image/jpeg');
    assert.equal(got.headers.get('cache-control'), 'private, no-cache');
    assert.ok(got.headers.get('etag'));
    assert.deepEqual([...Buffer.from(await got.arrayBuffer())], [...image]);
    const imageTag = got.headers.get('etag')!;
    const unchanged = await fetch(imageUrl, { headers: { 'if-none-match': `"different", W/${imageTag}` } });
    assert.equal(unchanged.status, 304); assert.equal(await unchanged.text(), '');
    assert.equal((await fetch(imageUrl, { method: 'HEAD' })).status, 200);
    // Repeat upload dedupes without overwrite.
    const other = Buffer.concat([image, Buffer.from([0x00])]);
    const dupe = await fetch(uploadUrl(0, '&w=320'), { method: 'POST', headers: uploadHeaders(), body: new Blob([other]) });
    assert.equal(dupe.status, 200);
    assert.deepEqual((await dupe.json()).deduped, true);
    assert.deepEqual([...Buffer.from(await (await fetch(imageUrl)).arrayBuffer())], [...image]);
    // Admin overview/list and single-item clear with epoch advance.
    const overview = await (await fetch(`${base}/api/admin/caches`)).json();
    const thumbs = overview.types.find((t: { kind: string }) => t.kind === 'media-thumbnails');
    assert.equal(thumbs.count, 1); assert.equal(thumbs.bytes, image.length);
    const adminHeaders = { origin: base, 'x-voidplayer-action': 'admin', 'content-type': 'application/json' };
    const listed = await (await fetch(`${base}/api/admin/caches/media-thumbnails`)).json();
    assert.equal(listed.entries.length, 1);
    assert.ok(listed.entries[0].previewUrl.includes('/thumbnail?'));
    const cleared = await fetch(`${base}/api/admin/caches/media-thumbnails`, { method: 'DELETE', headers: adminHeaders, body: JSON.stringify({ id: entry.id, version: entry.version }) });
    assert.deepEqual(await cleared.json(), { removed: 1 });
    assert.equal((await fetch(imageUrl)).status, 404);
    assert.equal((await fetch(imageUrl, { headers: { 'if-none-match': imageTag } })).status, 404, 'cleared data cannot be validated from an old tag');
    // The in-flight upload accepted before the clear cannot backfill.
    assert.equal((await fetch(uploadUrl(0), { method: 'POST', headers: uploadHeaders(), body: new Blob([image]) })).status, 409);
    assert.equal((await fetch(uploadUrl(1), { method: 'POST', headers: uploadHeaders(), body: new Blob([image]) })).status, 201);
    assert.equal((await fetch(imageUrl, { headers: { 'if-none-match': imageTag } })).status, 304, 'identical restored bytes may reuse their content validator');
    // Replaced files never inherit the old cover.
    await writeFile(path.join(media, 'one.mp4'), Buffer.alloc(4096, 9)); await library.refresh();
    const changed = library.browse().entries[0];
    assert.notEqual(changed.version, entry.version);
    assert.equal(library.thumbnails.overview().count, 0);
    assert.equal((await fetch(imageUrl)).status, 404);
    assert.equal((await fetch(imageUrl, { headers: { 'if-none-match': imageTag } })).status, 404, 'source version validation precedes conditional success');
  } finally {
    server.closeAllConnections(); await new Promise<void>(r => server.close(() => r()));
    await admin.close(); await library.close(); await rm(root, { recursive: true, force: true });
  }
});

test('thumbnail migration preserves earlier rows and other tables', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vp-thumbs-mig-'));
  const media = path.join(root, 'media'); await mkdir(media); await mkdir(path.join(root, 'data'));
  await writeFile(path.join(media, 'one.mp4'), Buffer.alloc(1024, 3));
  const database = path.join(root, 'data', 'library.sqlite');
  let library = new MediaLibraryIndex([media], { database, watch: false }); await library.refresh();
  const entry = library.browse().entries[0];
  library.thumbnails.put(entry.id, entry.version!, THUMB_RECIPE_VERSION, 0, jpeg320x240(), { width: 320, height: 240, sourcePtsUs: 0 });
  await library.close();
  library = new MediaLibraryIndex([media], { database, watch: false });
  try {
    assert.equal(library.thumbnails.status(entry.id, entry.version!, THUMB_RECIPE_VERSION).ready, true);
    assert.equal(library.browse().entries.length, 1);
  } finally { await library.close(); await rm(root, { recursive: true, force: true }); }
});
