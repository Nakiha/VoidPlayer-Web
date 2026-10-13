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
