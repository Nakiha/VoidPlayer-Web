import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildJsTsIndexDocument } from '../../server/js-ts-index-builder.ts';
import { MediaLibraryIndex, fileVersion } from '../../server/library.ts';
import { createMediaServer } from '../../server/app.ts';
import { TsPacketSource } from '../../src/ts-packet-source.ts';
import { parseTsPacketIndex } from '../../src/ts-packet-index.ts';
import { JS_TS_MEDIA_INDEX_IDENTITY, parseMediaIndexIdentity } from '../../src/media-index-identity.ts';
import { MediaIndexClient } from '../../src/media-index-client.ts';
import { prepareFrameIndex } from '../../server/frame-index-store.ts';

const fixture = () => readFile('fixtures/ts-analysis/h264-static.ts');
test('JS disk and independent Blob indexes match with source/file-version checks and no decoder', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'vp-js-ts-disk-'));
  const file = path.join(directory, 'video.ts'), bytes = await fixture();
  const sourceVersion = 'source@version';
  const blob = new TsPacketSource({ size: bytes.length, read: async (at,len) => bytes.subarray(at,at+len), close(){} },sourceVersion,new AbortController().signal);
  try {
    await writeFile(file, bytes);
    const version = fileVersion(await stat(file));
    const disk = await buildJsTsIndexDocument(file,bytes.length,version,sourceVersion);
    assert.deepEqual(disk.document, await blob.open());
    assert.equal(disk.profile.scanMode, 'js-ts-packets');
    assert.ok(disk.profile.diskReadBytes > 0); assert.ok(disk.profile.diskReadCalls > 0);
    assert.ok(disk.profile.diskReadCalls < 100, 'two bounded block-cache passes avoid a syscall per TS packet');
    assert.ok(disk.profile.diskReadBytes <= bytes.length * 3, 'bounded actual disk IO is reported independently from logical adapter reads');
    await assert.rejects(buildJsTsIndexDocument(file,bytes.length,'old-version',sourceVersion),/改变/);
    await assert.rejects(buildJsTsIndexDocument(file,bytes.length,version,sourceVersion,progress=>{
      if (progress.scannedBytes === 0) appendFileSync(file,new Uint8Array([0]));
    }),/改变/);
  } finally { blob.close(); await rm(directory,{recursive:true,force:true}); }
});

test('JS TS library index cold build, joined clients and durable warm restart require no WASM core or client payload IO', async () => {
  const directory = await mkdtemp(path.join(tmpdir(),'vp-js-ts-library-'));
  const media = path.join(directory,'media'), database = path.join(directory,'library.sqlite');
  await mkdir(media); await writeFile(path.join(media,'video.ts'),await fixture());
  const missingCore = path.join(directory,'no-core');
  let library: MediaLibraryIndex | undefined, server: ReturnType<typeof createMediaServer> | undefined;
  const clients: MediaIndexClient[] = [];
  function createLibrary() {
    const prior = process.env.VOIDPLAYER_WASM_CORE_DIR;
    process.env.VOIDPLAYER_WASM_CORE_DIR = missingCore;
    try { return new MediaLibraryIndex([media],{database,watch:false}); }
    finally { if(prior === undefined) delete process.env.VOIDPLAYER_WASM_CORE_DIR; else process.env.VOIDPLAYER_WASM_CORE_DIR=prior; }
  }
  async function startServer() {
    server = createMediaServer({roots:[media],library:library!,onLog(){}});
    await new Promise<void>((resolve,reject)=>{
      const onError = (error: Error) => { clearTimeout(timer); reject(error); };
      const timer = setTimeout(()=>{server!.off('error',onError);reject(new Error('owned server readiness timed out'));},1500);
      server!.once('error',onError);
      server!.listen(0,'127.0.0.1',()=>{clearTimeout(timer);server!.off('error',onError);resolve();});
    });
    return `http://127.0.0.1:${(server.address() as {port:number}).port}`;
  }
  async function closeServer() { if(server?.listening){await new Promise<void>((resolve,reject)=>server!.close(e=>e?reject(e):resolve()));server=undefined;} else server=undefined; }
  try {
    library=createLibrary(); await library.refresh();
    const entry=library.browse().entries[0], sourceVersion=`${entry.id}@${entry.version}`;
    const base=await startServer();
    let starts=0,ranges=0,uploads=0; const buildIds=new Set<string>();
    const startBuild=library.indexJobs.startBuild.bind(library.indexJobs);
    library.indexJobs.startBuild=(...args)=>{starts++;const handle=startBuild(...args);buildIds.add(handle.buildId);return handle;};
    const handler=server!.listeners('request')[0] as (req:any,res:any)=>void;
    server!.removeAllListeners('request');server!.on('request',(req,res)=>{
      if(req.headers.range)ranges++; if(req.method==='POST')uploads++; handler(req,res);
    });
    const sourceUrl=`${base}/api/media/${entry.id}?v=${entry.version}`;
    const client=()=>{const c=new MediaIndexClient(sourceUrl,'js-ts',64*1024*1024,120000,true,JS_TS_MEDIA_INDEX_IDENTITY);clients.push(c);return c;};
    const [a,b]=await Promise.all([client().read(),client().read()]);
    assert.ok(a);assert.ok(b);assert.deepEqual(a,b);
    const index=parseTsPacketIndex(a,sourceVersion,entry.size);assert.ok(index);
    assert.equal(index.packets.length,600);assert.equal(index.packets.filter(p=>p.timing.dts===null).length,138);
    assert.equal(starts,2,'concurrent callers both request a build');
    assert.equal(buildIds.size,1,'only one physical build owns the joined index');
    const warm=await client().read();assert.deepEqual(warm,a);assert.equal(starts,2);
    assert.equal(ranges,0,'index clients never request media payload');assert.equal(uploads,0,'server owns cold JS index construction');
    const epoch=await library.indexJobs.call('epoch');
    const bad=structuredClone(index);bad.sourceVersion='other-source';
    const bytes=new TextEncoder().encode(JSON.stringify({epoch,index:bad}));
    await assert.rejects(library.indexJobs.call('put',{id:entry.id,version:entry.version!,size:entry.size,identity:JS_TS_MEDIA_INDEX_IDENTITY,bytes}),/源身份/);
    assert.throws(()=>prepareFrameIndex(index,entry.size,{...JS_TS_MEDIA_INDEX_IDENTITY,indexerBuild:'wrong-build'},sourceVersion),/身份与请求/);
    assert.throws(()=>parseMediaIndexIdentity('js-ts',new URLSearchParams({stream:'video:0',schema:'2',indexer:'wrong-build'})),/版本不受支持/);
    assert.equal(JSON.parse(library.frameIndexes.getJson(entry.id,entry.version!,'ffmpeg',{kind:'ffmpeg',streamKey:'video:0',schemaVersion:3,indexerBuild:'0'.repeat(40)})).index,null,'legacy FFmpeg identity never aliases JS');
    const manifest=await library.indexJobs.call('stream-manifest',{id:entry.id,version:entry.version!,identity:JS_TS_MEDIA_INDEX_IDENTITY});
    assert.equal(manifest.manifest?.complete,true);assert.equal(manifest.manifest?.buildId,null);
    for(const c of clients)c.close();clients.length=0;
    await closeServer();await library.close();library=undefined;
    library=createLibrary();await library.refresh();
    let restartedBuilds=0;
    const restarted=library.indexJobs.startBuild.bind(library.indexJobs);
    library.indexJobs.startBuild=(...args)=>{restartedBuilds++;return restarted(...args);};
    const restartedBase=await startServer();
    const c=new MediaIndexClient(`${restartedBase}/api/media/${entry.id}?v=${entry.version}`,'js-ts',64*1024*1024,120000,true,JS_TS_MEDIA_INDEX_IDENTITY);clients.push(c);
    assert.deepEqual(await c.read(),a);assert.equal(restartedBuilds,0);
    await assert.rejects(stat(missingCore),{code:'ENOENT'});
  } finally {
    for(const c of clients)c.close();await closeServer();await library?.close();await rm(directory,{recursive:true,force:true});
  }
});
