import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Worker} from 'node:worker_threads';
import {planQualityRange,aggregateRange,rangeCandidatePolicy,selectRangeCandidates,QUALITY_RANGE_LIMITS} from '../../shared/analysis/quality/ranges.ts';
import type {QualityRangeInput} from '../../shared/analysis/quality/ranges.ts';
import type {QualityJobResult} from '../../shared/analysis/quality/jobs.ts';
import {jobInput} from '../helpers/quality-job-fixture.ts';
import {QualityAdmission} from '../../server/quality-admission.ts';
import {QualityJobService} from '../../server/analysis/quality/job-service.ts';
import {QualityRangeService} from '../../server/analysis/quality/range-service.ts';
import {LibraryPairRunner} from '../../server/analysis/quality/runner.ts';
import type {MediaLibraryIndex} from '../../server/library.ts';
import {openIndexDatabase} from '../../server/sqlite.ts';
import {randomUUID} from 'node:crypto';

function input(aus=[0,1]):QualityRangeInput{
  return {schema:'voidplayer-quality-range',version:1,client:{id:'range-test',kind:'agent'},interval:{startAu:0,endAu:2},correspondence:{mode:'explicit-au-table'},sampling:{mode:'all'},
    pairs:aus.map(au=>{const p=jobInput().request;p.reference.picture.au=au;p.distorted.picture.au=au+5;p.reference.sourcePtsUs=au*100;p.distorted.sourcePtsUs=au*100+500;p.budget={maxReadBytes:1024,maxInputBytes:1024};return p;}),
    budget:{maxReadBytes:4096,maxPackets:128,maxOutputFrames:128,maxInputBytes:4096,maxElapsedMs:10000}};
}
// Arithmetic-only envelopes exercise pooling independently of decoding, which
// is verified against fixed native planes in the HTTP/browser suites.
function result(sse:number,samples:number,db:number,depth=8):QualityJobResult{
  return {value:{schema:'voidplayer-library-frame-pair-psnr',version:1,result:{metric:{implementation:'cpu-number-sse-v1',domain:'source-yuv-code-values',bitDepth:depth,peak:depth===8?255:1023,color:{matrix:'bt709'},roi:{x:0,y:0,width:32,height:32},aggregate:{sse,samples,psnr:{kind:'finite',db}}},work:{readBytes:10,packets:2,outputFrames:2,elapsedMs:1}}}} as QualityJobResult;
}
async function until(check:()=>boolean){for(let n=0;n<500;n++){if(check())return;await new Promise(r=>setTimeout(r,5));}assert.fail('Range transition timeout');}

test('inclusive AU planning distinguishes unmapped endpoints and deterministic stride positions',()=>{
  const v=input(),all=planQualityRange(v);assert.deepEqual(all.selectedAus,[0,1,2]);assert.deepEqual(all.unmappedAus,[2]);assert.deepEqual(all.unsampledAus,[]);
  v.sampling={mode:'stride',every:2,offset:0};const stride=planQualityRange(v);assert.deepEqual(stride.selectedAus,[0,2]);assert.deepEqual(stride.unsampledAus,[1]);assert.deepEqual(stride.unmappedAus,[2]);
  assert.equal(stride.preRollAndDrain.packets,2);assert.equal(stride.reservation.readBytes,1024);assert.equal(v.pairs[0].budget?.maxPackets,undefined,'pure plan leaves caller input intact');
  const tooMany=input([0]);tooMany.interval.endAu=1024;assert.throws(()=>planQualityRange(tooMany),/1024 selected/);
});

test('independent parent actor/queue, row/byte history caps and future schema preserve old receipts',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'vp-range-limits-')),file=join(dir,'ranges.sqlite'),children=new Map<string,any>();
  const jobs={submit(){const job={id:randomUUID(),state:'queued',reason:null};children.set(job.id,job);return {job};},get(id:string){return children.get(id);},cancel(id:string){children.get(id).state='cancelled';},resources(){return {available:true};}} as unknown as QualityJobService;
  let ranges:QualityRangeService|undefined=new QualityRangeService(file,jobs);t.after(async()=>{await ranges?.close();await rm(dir,{recursive:true,force:true});});
  const v=input([0]);v.interval.endAu=0;const owner={id:'owner',name:'Owner'},first=ranges.submit(v,owner,'first','first').job;
  ranges.submit(v,owner,'two','two');assert.throws(()=>ranges!.submit(v,owner,'over-actor','over-actor'),{code:'range-queue-full'});
  ranges.submit(v,{id:'other',name:'Other'},'three','three');ranges.submit(v,{id:'third',name:'Third'},'four','four');
  assert.throws(()=>ranges!.submit(v,{id:'fourth',name:'Fourth'},'over-queue','over-queue'),{code:'range-queue-full'});
  for(const actor of [owner.id,'other','third'])for(const j of ranges.list(actor).entries)ranges.cancel(j.id,actor);
  await until(()=>ranges!.get(first.id,owner.id).state==='cancelled');await ranges.close();ranges=undefined;
  const db=openIndexDatabase(file),row=db.prepare('SELECT * FROM quality_ranges WHERE id=?').get(first.id)!;
  try{
    for(let i=4;i<100;i++){const id=randomUUID(),body=JSON.parse(String(row.body));body.id=id;body.key=`history-${i}`;db.prepare('INSERT INTO quality_ranges VALUES(?,?,?,?,?,?,?)').run(id,row.actor,row.client,body.key,row.fingerprint,JSON.stringify(body),row.reserved);}
  }finally{db.close();}
  ranges=new QualityRangeService(file,jobs);assert.equal(ranges.submit(v,owner,'old-receipt','first').replayed,true);
  assert.throws(()=>ranges!.submit(v,owner,'new','row-full'),{code:'range-history-full'});await ranges.close();ranges=undefined;
  const bytes=openIndexDatabase(file);try{bytes.prepare('DELETE FROM quality_ranges WHERE id!=?').run(first.id);bytes.prepare('UPDATE quality_ranges SET reserved=? WHERE id=?').run(QUALITY_RANGE_LIMITS.reservedBytes,first.id);}finally{bytes.close();}
  ranges=new QualityRangeService(file,jobs);assert.throws(()=>ranges!.submit(v,owner,'new','bytes-full'),{code:'range-history-full'});assert.equal(ranges.submit(v,owner,'old','first').replayed,true);await ranges.close();ranges=undefined;
  const future=openIndexDatabase(file);future.exec('PRAGMA user_version=99');future.close();assert.throws(()=>new QualityRangeService(file,jobs),/newer application/);
  const inspect=openIndexDatabase(file);try{assert.equal(Number(inspect.prepare('SELECT count(*) AS n FROM quality_ranges').get()!.n),1);}finally{inspect.close();}
});
test('one-to-one mapping rejects duplicate AU, changing sources/cache and incorrect declared clock offset',()=>{
  for(const change of [(x:QualityRangeInput)=>x.pairs[1].reference.picture.au=0,(x:QualityRangeInput)=>x.pairs[1].distorted.picture.au=5,
    (x:QualityRangeInput)=>x.pairs[1].reference.indexBuildId='different',(x:QualityRangeInput)=>{x.pairs[1].reference.mediaVersion='c'.repeat(24);x.pairs[1].reference.picture.sourceVersion=`${x.pairs[1].reference.mediaId}@${'c'.repeat(24)}`;},
    (x:QualityRangeInput)=>{x.correspondence={mode:'constant-source-pts-offset',offsetUs:501};}]){const v=input();change(v);assert.throws(()=>planQualityRange(v));}
  const good=input();good.correspondence={mode:'constant-source-pts-offset',offsetUs:500};assert.equal(planQualityRange(good).targets,3);
});
test('GOP budgets include repeated pre-roll, post-target and drain outputs in every selected pair',()=>{
  const v=input();for(const p of v.pairs)for(const t of [p.reference,p.distorted])t.decode={mode:'packet-identity-gop-v1',startAu:0,endAu:15};
  const plan=planQualityRange(v);assert.deepEqual(plan.preRollAndDrain,{packets:64,outputFrames:64});assert.equal(plan.input.pairs[0].budget?.maxOutputFrames,32);
  for(const key of ['maxPackets','maxOutputFrames'] as const){const low=structuredClone(v);low.budget[key]=63;assert.throws(()=>planQualityRange(low),/total range budget/);}
  const low=structuredClone(v);low.pairs[0].budget!.maxOutputFrames=2;assert.throws(()=>planQualityRange(low),/dependency/);
  const numeric=structuredClone(v);numeric.budget.maxInputBytes=1024;assert.throws(()=>planQualityRange(numeric),/total range budget/);
});
test('PSNR pools exact SSE/count by pixel domain and SSIM uses per-plane window weights',()=>{
  const a=result(100,100,48),b=result(900,300,32),other=result(10,100,60,10);
  const s=(y:number,u:number,v:number,n:number)=>({planes:{y:{score:y,windows:n},u:{score:u,windows:n/2},v:{score:v,windows:n/2}}});
  a.value.result.ssim=s(.8,.6,.4,20) as never;b.value.result.ssim=s(.2,.4,.8,60) as never;
  const pooled=aggregateRange([a,b,other]);assert.equal(pooled.groups.length,2);const g=pooled.groups[0];assert.equal(g.metric.sse,1000);assert.equal(g.metric.samples,400);
  assert.ok(Math.abs(g.metric.psnr.db!-10*Math.log10(255**2/2.5))<1e-12);assert.notEqual(g.metric.psnr.db,40);
  assert.ok(Math.abs(g.ssim!.score-(4*.35+.45+.7)/6)<1e-12);assert.deepEqual(g.ssim!.windows,{y:80,u:40,v:40});assert.equal(pooled.work.outputFrames,6);
  assert.equal(aggregateRange([result(0,100,Infinity)]).groups[0].metric.psnr.kind,'positive-infinity');
  assert.throws(()=>aggregateRange([result(Number.MAX_SAFE_INTEGER,100,0),result(2,100,0)]),/exact integer/);
});
test('candidate policy requires explicit text/severity and deterministic threshold, ties, top-N and spacing',()=>{
  const policy=rangeCandidatePolicy({space:'default',side:'reference',metric:'psnr',maxDb:40,limit:2,minAuDistance:3,text:' Candidate ',severity:3});
  const selected=selectRangeCandidates([0,1,4,8].map((au,i)=>({au,result:result(10,100,[25,25,30,50][i])})),policy);
  assert.deepEqual(selected.map(x=>x.au),[0,4]);assert.equal(policy.text,'Candidate');
  for(const change of [{severity:0},{text:''},{space:123},{limit:9},{minAuDistance:-1},{maxDb:Infinity},{extra:true}])assert.throws(()=>rangeCandidatePolicy({...policy,...change}));
});
test('durable parent holds no nested permit; cancellation waits for child terminate, actor/key and restart are fenced',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'vp-range-unit-')),gate=new QualityAdmission(),workers:{events:EventEmitter;release():void;stopping:boolean}[]=[];
  const runner=new LibraryPairRunner({qualityAdmission:gate,indexDatabase:'/unused'} as MediaLibraryIndex,'/unused',()=>{
    const events=new EventEmitter();let release!:()=>void;const stopped=new Promise<number>(r=>release=()=>r(0));const state={events,release,stopping:false};workers.push(state);
    return Object.assign(events,{postMessage(){},terminate(){state.stopping=true;return stopped;}}) as unknown as Worker;
  });
  const jobs=new QualityJobService(join(dir,'jobs.sqlite'),runner),file=join(dir,'ranges.sqlite');let ranges=new QualityRangeService(file,jobs);
  t.after(async()=>{for(const w of workers)w.release();await ranges.close();await jobs.close();await runner.close();await rm(dir,{recursive:true,force:true});});
  const actor={id:'owner',name:'Owner'},v=input([0]);v.interval.endAu=0;
  const permit=gate.acquire(),first=ranges.submit(v,actor,'original','key').job;assert.equal(workers.length,0,'external shared admission leaves child queued');permit();
  await until(()=>workers.length===1);const child=ranges.get(first.id,actor.id).samples[0];assert.ok(jobs.get(child.jobId).attempt);
  assert.equal(ranges.submit(v,{...actor,name:'Changed'},'replay','key').replayed,true);assert.equal(ranges.get(first.id,actor.id).requestId,'original');
  assert.throws(()=>ranges.get(first.id,'other'),{code:'range-not-found'});assert.throws(()=>ranges.submit({...v,sampling:{mode:'stride',every:2,offset:0}},actor,'conflict','key'),{code:'idempotency-conflict'});
  assert.throws(()=>new QualityRangeService(file,jobs),/另一个实例/);ranges.cancel(first.id,actor.id);
  await until(()=>workers[0].stopping);assert.equal(ranges.get(first.id,actor.id).state,'cancelling');assert.equal(ranges.get(first.id,actor.id).endedAt,null);assert.throws(()=>gate.acquire(),{code:'quality-busy'});
  workers[0].release();await until(()=>ranges.get(first.id,actor.id).state==='cancelled');const release=gate.acquire();release();
  await ranges.close();ranges=new QualityRangeService(file,jobs);assert.equal(ranges.submit(v,actor,'restart','key').job.state,'cancelled');assert.equal(workers.length,1);
  assert.equal(QUALITY_RANGE_LIMITS.historyRows,100);
});
