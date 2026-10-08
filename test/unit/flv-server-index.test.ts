import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,stat} from 'node:fs/promises';
import {appendFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {MediaLibraryIndex,fileVersion} from '../../server/library.ts';
import {buildFlvIndexDocument} from '../../server/flv-index-builder.ts';
import {createMediaServer} from '../../server/app.ts';
import {FlvEngine} from '../../src/flv-engine.ts';
import {FlvReader,demuxFlv} from '../../src/flv-demux.ts';
import {serializeFlvIndex} from '../../src/flv-index-cache.ts';
import {FLV_MEDIA_INDEX_IDENTITY} from '../../src/media-index-identity.ts';
import {syntheticFlv} from '.././flv-fixture.ts';

function damagedFlv(vvc=false){
 const bytes=syntheticFlv(),at=bytes.length-25;
 if(!vvc){bytes[at+11]=0x17;bytes[bytes.length-5]=0x65;}
 if(vvc)for(let offset=13;offset<bytes.length;offset+=15+bytes.readUIntBE(offset+1,3))if(bytes[offset]===9)bytes[offset+11]=(bytes[offset+11]&0xf0)|14;
 const audio=Buffer.alloc(16);audio[0]=8;audio.writeUIntBE(1,1,3);audio[11]=1;audio.writeUInt32BE(12,12);
 return Buffer.concat([bytes.subarray(0,at),Buffer.alloc(149,0xa5),bytes.subarray(at),audio,audio]);
}
test('disk adapter and Blob share identical recovery/index documents, with version checks',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'vp-flv-disk-')),file=path.join(dir,'clip.flv'),bytes=damagedFlv();
 try{
  await writeFile(file,bytes);const version=fileVersion(await stat(file));
  const reader=new FlvReader({file:new Blob([bytes])});let document;
  try{document=serializeFlvIndex(await demuxFlv(reader),bytes.length);}finally{reader.close();}
  const result=await buildFlvIndexDocument(file,bytes.length,version);
  assert.deepEqual(result.document,document);assert.equal(result.document.recoveredGaps![0].size,149);
  assert.ok(result.profile.diskReadBytes<=bytes.length+1024*1024,'bounded cached reads, without per-tag syscalls');
  await assert.rejects(buildFlvIndexDocument(file,bytes.length,'old-version'),/改变/);
  await assert.rejects(buildFlvIndexDocument(file,bytes.length,version,p=>{if(p.scannedBytes===0)appendFileSync(file,new Uint8Array([0]));}),/改变/);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('VVC uses the same disk parser and recovery without a decoder core',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'vp-flv-vvc-')),file=path.join(dir,'clip.flv'),bytes=damagedFlv(true);
 const reader=new FlvReader({file:new Blob([bytes])});
 try{
  await writeFile(file,bytes);
  const built=await buildFlvIndexDocument(file,bytes.length,fileVersion(await stat(file)));
  assert.equal(built.document.codec,'vvc');
  assert.deepEqual(built.document,serializeFlvIndex(await demuxFlv(reader),bytes.length));
 }finally{reader.close();await rm(dir,{recursive:true,force:true});}
});

for(const outcome of ['recovered','prefix'] as const) test(`cold library FLV ${outcome} indexes persist, join builds and never scan/upload client-side`,async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'vp-flv-server-')),media=path.join(dir,'media');await mkdir(media);
 const bytes=outcome==='recovered'?damagedFlv():Buffer.concat([syntheticFlv(),Buffer.alloc(190*1024,0xa5)]);await writeFile(path.join(media,'clip.flv'),bytes);
 const library=new MediaLibraryIndex([media],{watch:false});await library.refresh();
 const entry=library.browse().entries[0];
 const server=createMediaServer({roots:[media],library,onLog(){}});
 let ranges=0,uploads=0,buildRequests=0;
 const handler=server.listeners('request')[0];server.removeAllListeners('request');
 server.on('request',(req,res)=>{if(req.headers.range)ranges++;if(req.method==='POST'&&req.url?.includes('frame-index'))uploads++;if(req.url?.includes('build=1'))buildRequests++;handler(req,res);});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 const input={url:`${base}/api/media/${entry.id}?v=${entry.version}`,size:entry.size};
 const first=new FlvEngine(input),joined=new FlvEngine(input);
 const handles=new Set<string>(),startBuild=library.indexJobs.startBuild.bind(library.indexJobs);
 library.indexJobs.startBuild=(request,options)=>{const handle=startBuild(request,options);handles.add(handle.buildId);return handle;};
 try{
  await Promise.all([first.prepare(),joined.prepare()]);
  const results=await Promise.all([first.completeIndex(),joined.completeIndex()]);
  assert.ok(results.every(r=>r.indexSource==='server'));
  assert.deepEqual(first.index,joined.index);assert.equal(handles.size,1);
  assert.equal(uploads,0);assert.equal(ranges,2,'each client reads only its initial 64 KiB block');
  assert.equal(buildRequests,2);assert.match(results[0].indexWarning!,outcome==='recovered'?/149.*重同步/:/有效视频前缀/);
  assert.ok(results.every(r=>r.indexIntegrity===outcome));
  if(outcome==='prefix')assert.equal(results[0].indexTruncatedAt,syntheticFlv().length);
  const cached=await library.indexJobs.call('has',{id:entry.id,version:entry.version,identity:FLV_MEDIA_INDEX_IDENTITY});assert.equal(cached,true);
  const warm=new FlvEngine(input);try{await warm.prepare();const result=await warm.completeIndex();assert.equal(result.indexSource,'server');assert.equal(result.indexIntegrity,outcome);assert.equal(result.indexWarning,results[0].indexWarning);}finally{warm.close();}
  assert.equal(handles.size,1,'warm lookup does not start another build');assert.equal(uploads,0);
  const reader=new FlvReader({file:new Blob([bytes])});try{assert.deepEqual(first.index,await demuxFlv(reader));}finally{reader.close();}
 }finally{first.close();joined.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await library.close();await rm(dir,{recursive:true,force:true});}
});

test('local FLV scans without a service; a failed library build never silently scans client-side',async()=>{
 const bytes=syntheticFlv(),file=new Blob([bytes]),original=globalThis.fetch;
 globalThis.fetch=async()=>{throw new Error('local indexing must not fetch');};
 const local=new FlvEngine({file});
 try{await local.prepare();assert.equal((await local.completeIndex()).indexSource,'client');assert.equal(local.index.packets.length,4);}finally{local.close();globalThis.fetch=original;}
 let mediaReads=0;
 globalThis.fetch=async(input)=>{
  const url=new URL(String(input));
  if(url.pathname.endsWith('/frame-index')){assert.equal(url.searchParams.get('build'),'1');return Response.json({epoch:0,index:null});}
  mediaReads++;return new Response(bytes.subarray(0,65536),{status:206,headers:{'content-range':`bytes 0-65535/${bytes.length}`,'content-length':'65536'}});
 };
 const remote=new FlvEngine({url:'http://localhost/api/media/'+'a'.repeat(24)+'?v=1',size:bytes.length});
 try{await remote.prepare();await assert.rejects(remote.completeIndex(),/服务端 FLV 索引未能完成/);assert.equal(mediaReads,1);assert.equal(remote.index.packets.length,1);}finally{remote.close();globalThis.fetch=original;}
});
