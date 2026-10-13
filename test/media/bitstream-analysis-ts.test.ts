import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {tsFixture,loadTsCore} from '../helpers/media/ts-analysis.ts';
import {analyzePicture,analyzeRange,analyzeStream} from '../../src/bitstream-analysis/runner.ts';
import {openAnalysisInput} from '../../src/bitstream-analysis/input.ts';
import {isAnnexB,nalRanges} from '../../src/nal-framing.ts';
import {pictureId} from '../../src/bitstream-analysis/contract.ts';
const signal=()=>new AbortController().signal;
const sourceVersion='static-ts-fixture';
test('lossless TS preserves all source VCLs, static config and independent block answers',async()=>{
 const f=await tsFixture(),core=await loadTsCore();
 const input=await openAnalysisInput(f.reader(),signal(),false,{demuxCore:core});
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
  assert.equal(f.play._vp_extract(f.ctx,f.ordered[0].pts),1);const id=f.play._vp_picture_info(f.ctx);assert.ok(id);assert.equal(Number(new DataView(f.play.HEAPU8.buffer,id,56).getBigUint64(24,true)),result.picture.au);
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
test('missing/duplicate timestamps, prefix, missing config and mismatched indexer fail closed',async()=>{
 const f=await tsFixture();try {
  const variants:any[]=[{...f.snapshot,indexIntegrity:'prefix',indexTruncatedAt:f.bytes.length-1,indexEndDts:String(f.ordered.at(-1).dts)}, {...f.snapshot,analysisConfiguration:undefined}, {...f.snapshot,indexerBuild:'0'.repeat(40)}];
  for(const kind of ['missing-dts','duplicate-pts']) {
    const bytes=f.records.slice(),v=new DataView(bytes.buffer);if(kind==='missing-dts')v.setBigInt64(8,-9223372036854775808n,true);else v.setBigInt64(48,v.getBigInt64(0,true),true);
    variants.push({...f.snapshot,records:Buffer.from(bytes).toString('base64')});
  }
  for(const snapshot of variants)await assert.rejects(analyzePicture(f.reader(snapshot),{sourceVersion,sourcePtsUs:f.pts(0),normalizedMediaUs:0},await loadTsCore(),'ts-test',signal()));
 }finally{f.close();}
});
test('real PES missing timestamps stay unknown; duplicate PES PTS produce no exact token',async()=>{
 const f=await tsFixture();try {
  for(const name of ['h264-missing-timestamps.ts','h264-duplicate-pts.ts']) {
    const bytes=fs.readFileSync('fixtures/ts-analysis/'+name),core=await loadTsCore();
    core.vpDemuxRead=(_h:number,o:number,n:number)=>bytes.subarray(o,o+n);
    const ctx=core._vpd_open(-1,BigInt(bytes.length));assert.ok(ctx);
    try {
      const packets:any[]=[];
      while(packets.length<2) {
        const status=core._vpd_read(ctx,128);assert.ok(status>0);if(status===2)continue;
        const ptr=core._vpd_packet(ctx),v=new DataView(core.HEAPU8.buffer,ptr,72);packets.push({pts:v.getBigInt64(0,true),dts:v.getBigInt64(8,true),flags:v.getUint32(44,true)});core._vpd_release(ctx);
      }
      if(name.includes('missing')) {assert.equal(packets[0].flags&3,0);assert.equal(packets[0].pts,-9223372036854775808n);assert.equal(packets[0].dts,-9223372036854775808n);}
      else {
        assert.equal(packets[0].pts,packets[1].pts);
        f.play.FS.writeFile('/negative.ts',bytes);const playCtx=f.play._vp_create();
        try {assert.equal(f.play.ccall('vp_open','number',['number','string'],[playCtx,'/negative.ts']),0);assert.equal(f.play._vp_index_build(playCtx),600);
          const status=f.play._vp_extract(playCtx,packets[0].pts);assert.ok([1,2].includes(status));assert.equal(f.play._vp_picture_info(playCtx),0,'duplicate raw PTS cannot attach a receive identity');
        }finally{f.play._vp_destroy(playCtx);f.play.FS.unlink('/negative.ts');}
      }
    }finally{core._vpd_close(ctx);}
  }
 }finally{f.close();}
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
test('actual WASM IO failures unwind C allocations before propagating, then the module reopens',async()=>{
 const f=await tsFixture(),core=await loadTsCore();try {
  const injected=new Error('injected synchronous reader failure');const target={sourceVersion,sourcePtsUs:f.pts(0),normalizedMediaUs:0};
  for(let i=0;i<3;i++) {
   const reader=f.reader();reader.readSync=()=>{throw injected;};
   await assert.rejects(analyzePicture(reader,target,core,'ts-test',signal()),error=>error===injected);
   assert.ok(reader.closed);assert.equal(core._vpd_live_contexts(),0);
  }
  const initialHeap=core.HEAPU8.byteLength;
  for(let i=0;i<300;i++) {
   core.vpDemuxRead=()=>{throw injected;};core.vpDemuxError=undefined;
   assert.equal(core._vpd_open(-1,BigInt(f.bytes.length)),0);assert.equal(core.vpDemuxError,injected);assert.equal(core._vpd_live_contexts(),0);
  }
  assert.equal(core.HEAPU8.byteLength,initialHeap,'repeated pre-return failures retain no growing C heap');
  const result=await analyzePicture(f.reader(),target,core,'ts-test',signal());assert.equal(result.picture.au,0);assert.equal(core._vpd_live_contexts(),0);
 }finally{f.close();}
});
test('whole TS can consume more than 64 MiB while each advancement and result remains bounded',async()=>{
 const f=await tsFixture('h264-padded-long.ts');try {
  assert.ok(f.bytes.length>64*1024*1024);const reader=f.reader(),core=await loadTsCore();let count=0;
  await analyzeStream(reader,{mode:'stream',sourceVersion,firstPtsUs:f.pts(0),durationUs:10000000},core,'ts-test',signal(),async r=>{assert.equal(r.confidence,'exact');count++;assert.ok(core._vpa_record_bytes()<32*1024*1024);},async()=>{});
  assert.equal(count,600);assert.ok(reader.actualBytes>64*1024*1024);assert.ok(reader.closed);assert.equal(core._vpd_live_contexts(),0);
 }finally{f.close();}
});
test('paired pinned WASMs preserve HRD input clocks and reject coding MBAFF despite FRAME presentation',async()=>{
 // CI prepares only artifacts, so this repository carries the same assertion
 // below rather than depending on a sibling checkout.
 const play=await loadTsCore(true),analyzer=await loadTsCore();
 for(const core of [play,analyzer])for(const name of ['hrd.ts','hrd-missing.ts']) {
  const bytes=fs.readFileSync('fixtures/ts-analysis/'+name);core.vpDemuxRead=(_h:number,o:number,n:number)=>bytes.subarray(o,o+n);const ctx=core._vpd_open(-1,BigInt(bytes.length));assert.ok(ctx);let count=0;
  try{for(;;){const status=core._vpd_read(ctx,128);if(!status)break;assert.ok(status>0);if(status===2)continue;
   const ptr=core._vpd_packet(ctx),v=new DataView(core.HEAPU8.buffer,ptr,72),au=Number(v.getBigUint64(32,true));assert.equal(au,count++);
   if(name==='hrd-missing.ts' && [10,11,40,41].includes(au)){assert.equal(v.getUint32(44,true)&3,0);assert.equal(v.getBigInt64(0,true),-9223372036854775808n);assert.equal(v.getBigInt64(8,true),-9223372036854775808n);}
   else assert.equal(v.getUint32(44,true)&3,3);core._vpd_release(ctx);
  }}finally{core._vpd_close(ctx);}assert.equal(count,100);
 }
 for(const [name,count,expected] of [['progressive-single.ts',25,25],['progressive-two-slices.ts',25,0],['mbaff.ts',50,0],['mbaff-frame-sei.ts',50,0]] as const) {
  play.FS.writeFile('/admission.ts',fs.readFileSync('fixtures/ts-analysis/'+name));const ctx=play._vp_create();let admitted=0,shownProgressive=0;
  try{assert.equal(play.ccall('vp_open','number',['number','string'],[ctx,'/admission.ts']),0);assert.equal(play._vp_index_build(ctx),count);
   for(let i=0;i<count;i++){assert.equal(play._vp_extract(ctx,play._vp_index_ticks(ctx,i)),1);admitted+=+!!play._vp_picture_info(ctx);shownProgressive+=+(play._vp_frame_interlaced(ctx)===0);}
   assert.equal(admitted,expected);if(name==='mbaff-frame-sei.ts')assert.equal(shownProgressive,50);
  }finally{play._vp_destroy(ctx);play.FS.unlink('/admission.ts');}
 }
});
test('unconsumed whole IO remains bounded until a result is acknowledged',async()=>{
 const f=await tsFixture(),core=await loadTsCore();try {
  const reader=f.reader(),input=await openAnalysisInput(reader,signal(),true,{demuxCore:core});
  try {
    await assert.rejects(async()=>{for(let i=0;i<200;i++)await input.readUnit(input.packets[560]);},/IO budget/);
    assert.ok(input.bytesRead<=64*1024*1024);
  }finally{input.close();}
  assert.equal(core._vpd_live_contexts(),0);
 }finally{f.close();}
});
test('library TS whole, cache restart and corrupt-hole repair use independent source-bound demux',async()=>{
 const {MediaLibraryIndex}=await import('../../server/library.ts');const {AnalysisScheduler}=await import('../../server/analysis/scheduler.ts');
 const {mkdtemp,rm,mkdir,copyFile,writeFile}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join,resolve}=await import('node:path');const {execFileSync}=await import('node:child_process');
 const temp=await mkdtemp(join(tmpdir(),'vp-ts-library-')),media=join(temp,'media');await mkdir(media);
 execFileSync('ffmpeg',['-y','-v','error','-copyts','-i','fixtures/ts-analysis/h264-static.ts','-map','0:v:0','-an','-c:v','copy','-frames:v','120','-mpegts_copyts','1','-f','mpegts',join(media,'short.ts')]);
 const library=new MediaLibraryIndex([media],{database:join(temp,'library.sqlite'),watch:false}),coreDir=resolve('public/vendor/voidplayer-analysis'),directory=join(temp,'analysis');let scheduler=new AnalysisScheduler(library,coreDir,directory);
 await library.refresh();const entry=(await library.list()).entries.find(e=>e.name==='short.ts')!;const lock=JSON.parse(fs.readFileSync('scripts/release-core.json','utf8'));
 const target={mode:'stream' as const,sourceVersion:`${entry.id}@${entry.version}`,firstPtsUs:1433333,durationUs:2000000,indexIdentity:{kind:'ffmpeg' as const,streamKey:'video:0',schemaVersion:3,indexerBuild:lock.revision}};
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
  assert.deepEqual(await consume((await scheduler.submit(entry.id,entry.version!,target,'owner')).requestId,expected),expected,'restart keeps all 120 finite-source records without JS/WASM');
  await scheduler.close();scheduler=new AnalysisScheduler(library,coreDir,directory);await writeFile(scheduler.store.chunkFile(expected.get(60).id),'{broken');await consume((await scheduler.submit(entry.id,entry.version!,target,'owner')).requestId,expected);
 }finally{await scheduler.close();await library.close();await rm(temp,{recursive:true,force:true});}
});
