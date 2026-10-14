import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {tsFixture,loadTsCore} from '../helpers/media/ts-analysis.ts';
import {analyzePicture,analyzeRange,analyzeStream} from '../../src/bitstream-analysis/runner.ts';
import {openAnalysisInput} from '../../src/bitstream-analysis/input.ts';
import {isAnnexB,nalRanges} from '../../src/nal-framing.ts';
import {pictureId} from '../../src/bitstream-analysis/contract.ts';
import {TsPacketSource,readTsPesClocks} from '../../src/ts-packet-source.ts';
import {JsContainerEngine} from '../../src/js-container-engine.ts';
import {JS_TS_MEDIA_INDEX_IDENTITY} from '../../src/media-index-identity.ts';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const signal=()=>new AbortController().signal;
const sourceVersion='static-ts-fixture';
test('lossless TS preserves all source VCLs, static config and independent block answers',async()=>{
 const f=await tsFixture(),core=await loadTsCore();
 const input=await openAnalysisInput(f.reader(),signal(),false,{sourceVersion});
 const source=fs.readFileSync('fixtures/video/h264_9s_1920x1080.mp4');
 const mp4=await openAnalysisInput({size:source.length,read:async(o,n)=>source.subarray(o,o+n),close(){}},signal());
 try {
  assert.equal(input.packets.length,600);
  const hash=(config:Uint8Array,bytes:Uint8Array,au:number)=>nalRanges('h264',config,bytes).filter(n=>[1,5].includes(bytes[n.offset]&31)).map(n=>{
    let payload=bytes.subarray(n.offset,n.offset+n.size);
    // The frozen MP4's last length-prefixed slice embeds an Annex-B EOS NAL.
    // libavformat's AVC parser separates that exact 5-byte marker in TS.
    if(!isAnnexB(config) && au===599) {assert.deepEqual([...payload.slice(-5)],[0,0,0,1,10]);payload=payload.subarray(0,payload.length-5);}
    return createHash('sha256').update(payload).digest('hex');
  });
  for(let au=0;au<600;au++)assert.deepEqual(hash(input.configurations[0],await input.readUnit(input.packets[au]),au),hash(mp4.configurations[0],await mp4.readUnit(mp4.packets[au]),au),`unchanged codec VCL ${au}`);
 } finally {input.close();mp4.close();}
 try {
  const answer=JSON.parse(fs.readFileSync('docs/fixtures/bitstream-analysis-answers.json','utf8'))[0];
  const result=await analyzePicture(f.reader(),{sourceVersion,sourcePtsUs:f.pts(0),normalizedMediaUs:0},core,'ts-test',signal());
  assert.equal(result.confidence,'exact');assert.equal(result.containerHeader?.box,'annexb');
  for(const block of answer.firstBlocks)assert.deepEqual(result.blocks.find(b=>b.x===block.x&&b.y===block.y),block);
  const engine=new JsContainerEngine({file:new Blob([f.bytes])},sourceVersion);
  try{await engine.open(pathToFileURL(resolve('public/vendor/voidplayer-core/voidplayer-core.js')).href,new Uint8Array(fs.readFileSync('public/vendor/voidplayer-core/voidplayer-core.wasm')),true);const shown=await engine.at(f.pts(0));assert.equal(shown.packetPicture?.au,result.picture.au);assert.equal(shown.packetPicture?.stream,result.picture.stream);shown.frame?.close();}finally{engine.close();}
 } finally {f.close();}
});
test('two independent rear TS GOP requests restore original AU with bounded physical IO',async()=>{
 const f=await tsFixture();try {for(const au of [200,560]) {
  const reader=f.reader(),core=await loadTsCore(),target={sourceVersion,sourcePtsUs:f.pts(au),normalizedMediaUs:f.pts(au)-f.pts(0)};
  const random=await analyzePicture(reader,target,core,'ts-test',signal());
  assert.equal(random.picture.au,au);assert.equal(random.confidence,'exact');assert.ok(random.metrics.startAu>0);assert.ok(reader.actualBytes<f.bytes.length/2);assert.ok(reader.closed);
  const sequentialCore=await loadTsCore(), collected=new Map<number,any>();
  await analyzeStream(f.reader(),{mode:'stream',sourceVersion,firstPtsUs:f.pts(0),durationUs:10000000},sequentialCore,'ts-test',signal(),async r=>{if(r.picture.au===au)collected.set(au,r);},async()=>{});
  const sequential=collected.get(au);assert.ok(sequential);
  assert.deepEqual(random.blocks,sequential.blocks);assert.deepEqual(random.references,sequential.references);assert.deepEqual(random.picture,sequential.picture);
  assert.ok(random.metrics.packets<600);assert.equal(core._vpa_record_bytes(),0);
 }}finally{f.close();}
});
test('fully cached TS range stays metadata-only; sparse miss decodes with source identity',async()=>{
 const f=await tsFixture();try {
  const results=new Map<string,any>(),target={sourceVersion,firstPtsUs:f.pts(0),startUs:0,endUs:100000};
  await analyzeRange(f.reader(),target,await loadTsCore(),'ts-test',signal(),async r=>{results.set(pictureId(r.picture),r);});
  let loads=0;const reader=f.reader();
  await analyzeRange(reader,{...target,startUs:10000,endUs:50000},async()=>{loads++;return loadTsCore();},'ts-test',signal(),async()=>{},async p=>results.get(pictureId(p))??null);
  assert.equal(loads,0);assert.ok(reader.actualBytes<=9);assert.ok(reader.closed);
  const missing=[...results.keys()][2];results.delete(missing);let repaired=false;
  await analyzeRange(f.reader(),target,await loadTsCore(),'ts-test',signal(),async r=>{if(pictureId(r.picture)===missing)repaired=true;},async p=>results.get(pictureId(p))??null);
  assert.ok(repaired);
 }finally{f.close();}
});
test('TS whole consumes exactly 600 distinct actual pictures and drains once; cancel releases and reopens',async()=>{
 const f=await tsFixture();try {
  const target={mode:'stream' as const,sourceVersion,firstPtsUs:f.pts(0),durationUs:10000000};
  const core=await loadTsCore(),seen=new Set<number>();let drains=0;
  const drain=core._vpa_drain;core._vpa_drain=()=>{drains++;return drain();};
  await analyzeStream(f.reader(),target,core,'ts-test',signal(),async r=>{assert.equal(r.confidence,'exact');assert.ok(!seen.has(r.picture.au));seen.add(r.picture.au);},async()=>{});
  assert.deepEqual([...seen].sort((a,b)=>a-b),Array.from({length:600},(_,i)=>i));assert.equal(drains,1);assert.equal(core._vpa_record_bytes(),0);
  const controller=new AbortController(),reader=f.reader();let count=0;
  await assert.rejects(analyzeStream(reader,target,core,'ts-test',controller.signal,async()=>{if(++count===21)controller.abort(new Error('test cancellation'));},async()=>{}),/test cancellation/);
  assert.ok(reader.closed);assert.equal(core._vpa_record_bytes(),0);
  const result=await analyzePicture(f.reader(),{sourceVersion,sourcePtsUs:f.pts(560),normalizedMediaUs:0},core,'ts-test',signal());assert.equal(result.picture.au,560);
 }finally{f.close();}
});
test('old FFmpeg and malformed JS cache documents rebuild from source instead of authorizing exact AU identities',async()=>{
 const f=await tsFixture();try {
  const variants:any[]=[{schema:3,kind:'ffmpeg-container',indexIntegrity:'prefix'}, {...f.index,configuration:[]}, {...f.index,build:'old-indexer-build'}];
  const missing=structuredClone(f.index);missing.packets[0].timing.dts=null;variants.push(missing);
  const duplicate=structuredClone(f.index);duplicate.packets[1].ptsUs=duplicate.packets[0].ptsUs;duplicate.packets[1].timestamp=duplicate.packets[0].timestamp;variants.push(duplicate);
  for(const doc of variants){const reader=f.reader(doc),input=await openAnalysisInput(reader,signal(),false,{sourceVersion});try{assert.equal(input.packets.length,600);assert.equal(input.packets[1].pts,f.pts(1));assert.equal(input.packets[0].timing?.dts,f.index.packets[0].timing.dts);assert.ok(reader.actualBytes>9,'untrusted old or changed metadata must not skip a source scan');}finally{input.close();}}
 }finally{f.close();}
});
test('real PES missing timestamps stay unknown; duplicate PES PTS produce no exact token',async()=>{
 const fixture=await tsFixture();try{for(const name of ['h264-missing-timestamps.ts','h264-duplicate-pts.ts']) {
  const bytes=fs.readFileSync('fixtures/ts-analysis/'+name),reader={size:bytes.length,async read(at:number,n:number){return bytes.subarray(at,at+n);},close(){}},raw=await readTsPesClocks(reader,fixture.index.pid,signal()),clocks=[...raw.values()],source=new TsPacketSource(reader,sourceVersion,signal());
  try{if(name.includes('duplicate')){assert.equal(clocks[0].pts,clocks[1].pts);await assert.rejects(source.open(),/timestamp|clock/i);}else{
   assert.equal(clocks[0].pts,null);assert.equal(clocks[0].dts,null);await assert.rejects(source.open(),/missing PTS/i,'pinned demuxer cannot produce an exact picture for this missing-clock input');
  }}finally{source.close();}
 }}finally{fixture.close();}
});
test('a range miss allocates one shared WASM session; complete cache hit allocates none',async()=>{
 const f=await tsFixture();try {
  let loads=0;const cache=new Map<string,any>();const target={sourceVersion,firstPtsUs:f.pts(0),startUs:0,endUs:50000};
  await analyzeRange(f.reader(),target,async()=>{loads++;return loadTsCore();},'ts-test',signal(),async r=>{cache.set(pictureId(r.picture),r);});
  assert.equal(loads,1,'demux and collector share the same instance');
  await analyzeRange(f.reader(),target,async()=>{loads++;throw new Error('cache must not instantiate WASM');},'ts-test',signal(),async()=>{},async p=>cache.get(pictureId(p))??null);
  assert.equal(loads,1);
 }finally{f.close();}
});
test('actual JS reader failures close their source before propagating, then the codec module reopens',async()=>{
 const f=await tsFixture(),core=await loadTsCore();try {
  const injected=new Error('injected asynchronous reader failure'),target={sourceVersion,sourcePtsUs:f.pts(0),normalizedMediaUs:0},initialHeap=core.HEAPU8.byteLength;
  for(let i=0;i<300;i++){
   const reader=f.reader(),read=reader.read;reader.read=async(at,n)=>{if(n>9)throw injected;return read(at,n);};
   await assert.rejects(analyzePicture(reader,target,core,'ts-test',signal()),error=>error===injected);assert.ok(reader.closed);assert.equal(reader.closes,1);assert.equal(core._vpa_record_bytes(),0);
  }
  assert.equal(core.HEAPU8.byteLength,initialHeap,'pre-codec IO failures cannot allocate a growing C demux heap');
  const result=await analyzePicture(f.reader(),target,core,'ts-test',signal());assert.equal(result.picture.au,0);assert.equal(core._vpa_record_bytes(),0);
 }finally{f.close();}
});
test('whole TS can consume more than 64 MiB while each advancement and result remains bounded',async()=>{
 const f=await tsFixture('h264-padded-long.ts');try {
  assert.ok(f.bytes.length>64*1024*1024);const reader=f.reader(),core=await loadTsCore();let count=0;
  await analyzeStream(reader,{mode:'stream',sourceVersion,firstPtsUs:f.pts(0),durationUs:10000000},core,'ts-test',signal(),async r=>{assert.equal(r.confidence,'exact');count++;assert.ok(core._vpa_record_bytes()<32*1024*1024);},async()=>{});
  assert.equal(count,600);assert.ok(reader.actualBytes>64*1024*1024);assert.ok(reader.closed);assert.equal(core._vpa_record_bytes(),0);
 }finally{f.close();}
});
test('JS demux preserves HRD clocks and playable coding layouts without inventing exact identities',async()=>{
 let baseline:Map<number,{pts:number|null;dts:number|null}>|undefined,pid=256;
 for(const name of ['hrd.ts','hrd-missing.ts']) {
  const bytes=fs.readFileSync('fixtures/ts-analysis/'+name),reader={size:bytes.length,async read(at:number,n:number){return bytes.subarray(at,at+n);},close(){}},source=new TsPacketSource(reader,sourceVersion,signal());
  try{if(name==='hrd.ts'){const index=await source.open();pid=index.pid;baseline=await readTsPesClocks(reader,pid,signal());assert.equal(index.packets.length,100);assert.equal(baseline.size,100);for(const packet of index.packets)assert.deepEqual({pts:packet.timing.pts,dts:packet.timing.dts},baseline.get(packet.pesOffset!),'HRD cannot synthesize a DTS omitted from its physical PES');}
   else{const clocks=await readTsPesClocks(reader,pid,signal());assert.equal(clocks.size,100);for(const [au,[position,clock]] of [...clocks].entries()){if([10,11,40,41].includes(au)){assert.equal(clock.pts,null);assert.equal(clock.dts,null);}else assert.deepEqual(clock,baseline!.get(position));}await assert.rejects(source.open(),/missing PTS/i);}
  }finally{source.close();}
 }
 for(const [name,count,expected] of [['progressive-single.ts',25,25],['progressive-two-slices.ts',25,25],['mbaff.ts',50,50],['mbaff-frame-sei.ts',50,50]] as const){
  const bytes=fs.readFileSync('fixtures/ts-analysis/'+name),source=new TsPacketSource({size:bytes.length,async read(at,n){return bytes.subarray(at,at+n);},close(){}},sourceVersion,signal());
  const {execFileSync}=await import('node:child_process');const frames=JSON.parse(execFileSync('ffprobe',['-v','error','-select_streams','v:0','-show_entries','frame=interlaced_frame','-of','json','fixtures/ts-analysis/'+name],{encoding:'utf8'})).frames;assert.equal(frames.length,count);
  try{const index=await source.open();assert.equal(index.packets.length,expected);
   if(name==='progressive-single.ts')assert.equal(index.exactPictureMapping,undefined);
   else{assert.equal(index.exactPictureMapping,false);await assert.rejects(openAnalysisInput({size:bytes.length,async read(at,n){return bytes.subarray(at,at+n);},close(){}},signal(),false,{sourceVersion}),/no verified exact picture mapping/);}
   if(name==='mbaff-frame-sei.ts')assert.equal(frames.filter((f:any)=>!f.interlaced_frame).length,50,'FRAME presentation cannot override coding SPS evidence');}finally{source.close();}
 }
});
test('unconsumed whole IO remains bounded until a result is acknowledged',async()=>{
 const f=await tsFixture(),core=await loadTsCore();try {
  const reader=f.reader(),input=await openAnalysisInput(reader,signal(),true,{sourceVersion});
  try {
    for(let i=0;i<100;i++)await input.readUnit(input.packets[560]);
    await assert.rejects(async()=>{for(let i=0;i<65;i++)await input.read(0,1024*1024);},/IO budget/);
    assert.ok(input.bytesRead<=64*1024*1024);input.acknowledge?.();await input.read(0,1024*1024);
  }finally{input.close();}
  assert.equal(core._vpa_record_bytes(),0);
 }finally{f.close();}
});
test('library TS whole, cache restart and corrupt-hole repair use independent source-bound demux',async()=>{
 const {MediaLibraryIndex}=await import('../../server/library.ts');const {AnalysisScheduler}=await import('../../server/analysis/scheduler.ts');
 const {mkdtemp,rm,mkdir,copyFile,writeFile}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join,resolve}=await import('node:path');const {execFileSync}=await import('node:child_process');
 const temp=await mkdtemp(join(tmpdir(),'vp-ts-library-')),media=join(temp,'media');await mkdir(media);
 execFileSync('ffmpeg',['-y','-v','error','-copyts','-i','fixtures/ts-analysis/h264-static.ts','-map','0:v:0','-an','-c:v','copy','-frames:v','120','-mpegts_copyts','1','-f','mpegts',join(media,'short.ts')]);
 const library=new MediaLibraryIndex([media],{database:join(temp,'library.sqlite'),watch:false}),coreDir=resolve('public/vendor/voidplayer-analysis'),directory=join(temp,'analysis');let scheduler=new AnalysisScheduler(library,coreDir,directory);
 await library.refresh();const entry=(await library.list()).entries.find(e=>e.name==='short.ts')!;
 const target={mode:'stream' as const,sourceVersion:`${entry.id}@${entry.version}`,firstPtsUs:1433333,durationUs:2000000};
 const consume=async(requestId:string,expected?:Map<number,any>)=>{
  const results=new Map<number,any>();let cursor=0;const deadline=performance.now()+120000;
  for(;;){assert.ok(performance.now()<deadline);const state=await scheduler.streamStatus(requestId,'owner',cursor);assert.ok(state && ['queued','running','complete'].includes(state.state),JSON.stringify(state));
   for(const ref of state.chunks){const result=await scheduler.store.get(ref.id);assert.equal(result?.confidence,'exact');assert.ok(!results.has(result!.picture.au));if(expected)assert.deepEqual(result!.blocks,expected.get(result!.picture.au).result.blocks);results.set(result!.picture.au,{id:ref.id,result});cursor=ref.cursor;}
   if(state.state==='complete' && cursor===state.published){assert.equal(state.progress!.indexComplete,true);break;}
   await new Promise(resolve=>setTimeout(resolve,5));
  }assert.equal(cursor,120);return results;
 };
 try {
  const expected=await consume((await scheduler.submit(entry.id,entry.version!,target,'owner')).requestId);await scheduler.close();
  const manifestOnly=join(temp,'manifest-only');await mkdir(manifestOnly);await copyFile(join(coreDir,'manifest.json'),join(manifestOnly,'manifest.json'));scheduler=new AnalysisScheduler(library,manifestOnly,directory);
  assert.deepEqual(await consume((await scheduler.submit(entry.id,entry.version!,{...target,indexIdentity:JS_TS_MEDIA_INDEX_IDENTITY},'owner')).requestId,expected),expected,'restart keeps all 120 finite-source records without JS/WASM');
  await scheduler.close();scheduler=new AnalysisScheduler(library,coreDir,directory);await writeFile(scheduler.store.chunkFile(expected.get(60).id),'{broken');await consume((await scheduler.submit(entry.id,entry.version!,{...target,indexIdentity:JS_TS_MEDIA_INDEX_IDENTITY},'owner')).requestId,expected);
 }finally{await scheduler.close();await library.close();await rm(temp,{recursive:true,force:true});}
});
