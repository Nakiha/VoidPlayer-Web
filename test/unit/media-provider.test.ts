import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMediaServer } from '../../server/app.ts';
import { MediaLibraryIndex } from '../../server/library.ts';
import { normalizeRoots } from '../../server/library-store.ts';

test('provider pages, version witnesses, exact ranges and downstream cancellation cross the HTTP boundary', {timeout:20000}, async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(),'vp-provider-'));
  let mode = 'normal', revision = 'v1', denyListing = false;
  let started!: () => void, stopped!: () => void;
  const pending = new Promise<void>(resolve => { started = resolve; }), cancelled = new Promise<void>(resolve => { stopped = resolve; });
  let statStarted!: () => void, statStopped!: () => void;
  const probing = new Promise<void>(resolve => { statStarted = resolve; }), drained = new Promise<void>(resolve => { statStopped = resolve; });
  let contentReads = 0;
  const meta = () => ({objectId:'opaque/+?',revision,size:5,lastModified:1});
  const upstream = createServer((req,res) => {
    const url = new URL(req.url!,'http://localhost');
    const route = url.pathname.replace(/^\/(prefix|rebound)\//,'/');
    const json = (body:unknown) => {res.writeHead(200,{'content-type':'application/json'}); res.end(JSON.stringify(body));};
    if (route === '/v1/list') {
      if (url.searchParams.get('cursor')) {
        if (denyListing) {res.writeHead(503); res.end(); return;}
        json({entries:[{kind:'file',name:'源.mp4',...meta()}],nextCursor:null});
      } else json({entries:[{kind:'file',name:'a.mp4',...meta(),objectId:'other'}],nextCursor:'page + /2'});
      return;
    }
    if (url.searchParams.get('objectId') !== meta().objectId) {res.writeHead(404); res.end(); return;}
    if (route === '/v1/stat') {
      if (mode === 'hold-stat') {res.once('close',statStopped); statStarted(); return;}
      json(meta());
      return;
    }
    assert.equal(route,'/v1/content');
    contentReads++;
    if (mode === 'hold') {res.once('close',stopped); started(); return;}
    if (mode === 'changed' || req.headers['if-match'] !== '"' + revision + '"') {res.writeHead(412); res.end(); return;}
    assert.equal(req.headers.range,'bytes=2-4');
    res.writeHead(mode === 'whole' ? 200 : 206,{etag:mode === 'wrong-tag' ? '"v0"' : '"' + revision + '"',
      'content-range':mode === 'wrong-range' ? 'bytes 0-2/5' : 'bytes 2-4/5'});
    res.end(mode === 'short' ? 'de' : 'cde');
  });
  upstream.listen(0,'127.0.0.1');
  await once(upstream,'listening');
  const endpoint = 'http://127.0.0.1:' + (upstream.address() as {port:number}).port + '/prefix';
  const roots = [{id:'cloud',provider:{endpoint}}], database = path.join(temp,'index.sqlite');
  let library = new MediaLibraryIndex(roots,{database,watch:false});
  let server;
  try {
    await library.refresh();
    const entry = library.browse({search:'源'}).entries[0];
    assert.equal(entry.storage,'provider');
    assert.ok(!JSON.stringify(library.browse()).includes(endpoint));
    denyListing = true;
    await library.refresh();
    assert.equal(library.browse({search:'源'}).entries[0].id,entry.id,'page two failure retains unseen media');
    assert.equal(library.status().job?.state,'partial');
    denyListing = false;
    await library.close();
    library = new MediaLibraryIndex(roots,{database,watch:false});
    server = createMediaServer({roots,library,onLog(){}});
    server.listen(0,'127.0.0.1');
    await once(server,'listening');
    const base = 'http://127.0.0.1:' + (server.address() as {port:number}).port;
    const content = base + '/api/media/' + entry.id + '/content?v=' + entry.version;
    const headers = {range:'bytes=-3'};
    assert.equal((await fetch(content,{method:'HEAD',headers})).status,206);
    assert.equal(contentReads,0,'metadata-only requests never read object content');
    const part = await fetch(content,{headers});
    assert.equal(part.status,206);
    assert.equal(part.headers.get('content-range'),'bytes 2-4/5');
    assert.equal(await part.text(),'cde');
    for (mode of ['short','whole','wrong-range','wrong-tag','changed']) {
      const bad = await fetch(content,{headers});
      assert.equal(bad.status,mode === 'changed' ? 409 : 502,mode);
      assert.ok((await bad.json()).code);
    }
    mode = 'hold';
    const controller = new AbortController();
    const blocked = fetch(content,{headers,signal:controller.signal});
    await pending;
    controller.abort();
    await assert.rejects(blocked);
    await cancelled;
    revision = 'v2';
    assert.equal((await fetch(content,{headers})).status,409);
    await library.refresh();
    const replaced = library.browse({search:'源'}).entries[0];
    assert.equal(replaced.id,entry.id);
    assert.notEqual(replaced.version,entry.version);
    assert.equal(await library.resolve(entry.id,replaced.version),null,'provider never resolves to a filesystem path');
    await assert.rejects(library.mutateFiles({operation:'delete',sources:[{rootId:'cloud',path:'源.mp4',kind:'file',version:replaced.version}]}),
      {code:'provider-read-only'});
    const reboundEndpoint = endpoint.replace(/\/prefix$/,'/rebound');
    await library.reconfigure([{id:'cloud',provider:{endpoint:reboundEndpoint}}],async () => async () => {});
    assert.equal(await library.source(entry.id,replaced.version!),null);
    await library.refresh();
    const rebound = library.browse({search:'源'}).entries[0];
    assert.equal(rebound.id,entry.id);
    assert.notEqual(rebound.version,replaced.version,'another adapter can reuse the same object ID and revision');
    assert.ok(await library.source(entry.id,rebound.version!));
    assert.throws(() => normalizeRoots([{id:'cloud',provider:{endpoint:'https://user:secret@example.invalid'}}]));
    mode = 'hold-stat';
    const probe = library.source(entry.id,rebound.version!);
    await probing;
    await Promise.all([assert.rejects(probe,{name:'AbortError'}),library.close(),drained]);
  } finally {
    if (server) {server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve()));}
    await library.close();
    upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
    await rm(temp,{recursive:true,force:true});
  }
});
