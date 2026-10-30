import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {EventEmitter} from 'node:events';
import type {Worker} from 'node:worker_threads';
import {referenceRelationInput,correspondenceInput,buildCorrespondence,canonicalJson} from '../../shared/analysis/quality/correspondence.ts';
import {correspondenceFixture} from '../helpers/correspondence-fixture.ts';
import {CorrespondenceService} from '../../server/analysis/quality/correspondence-service.ts';
import {LibraryPairRunner} from '../../server/analysis/quality/runner.ts';
import {QualityAdmission} from '../../server/quality-admission.ts';
import type {MediaLibraryIndex} from '../../server/library.ts';
import type {QualityRangeService} from '../../server/analysis/quality/range-service.ts';
import {CORRESPONDENCE_LIMITS} from '../../shared/analysis/quality/correspondence.ts';
import {openIndexDatabase} from '../../server/sqlite.ts';
import {randomUUID} from 'node:crypto';

const work={indexBytes:100,indexPackets:4,sourceReadBytes:0 as const,decodedFrames:0 as const,elapsedMs:1};
const until=async(fn:()=>boolean)=>{for(let n=0;n<500;n++){if(fn())return;await new Promise(r=>setTimeout(r,5));}assert.fail('Planner transition timeout');};
test('independent actor/queue and settled byte reservations reject new plans while retaining original receipts',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'vp-clock-caps-')),file=join(directory,'plans.sqlite'),gate=new QualityAdmission(),held=gate.acquire();
  const runner=new LibraryPairRunner({qualityAdmission:gate,indexDatabase:'/unused'} as MediaLibraryIndex,'/unused',()=>{assert.fail('Queued/cancelled planning must start no Worker');});
  let service=new CorrespondenceService(file,runner,{} as QualityRangeService);t.after(async()=>{held();await service.close();await runner.close();await rm(directory,{recursive:true,force:true});});
  const f=await correspondenceFixture(),owner={id:'owner',name:'Owner'},owned=new Map<string,string>();
  const submit=(actor=owner,key='first')=>{let id=owned.get(actor.id);if(!id){id=service.createRelation(f.relation.input,actor,'relation','relation').relation.id;owned.set(actor.id,id);}return service.submit({...f.request,relation:{id,revision:1}},actor,'original',key).plan;};
  const first=submit();submit(owner,'second');assert.throws(()=>submit(owner,'over-actor'),{code:'correspondence-queue-full'});const other={id:'other',name:'Other'},third={id:'third',name:'Third'};submit(other);submit(third);assert.throws(()=>submit({id:'fourth',name:'Fourth'}),{code:'correspondence-queue-full'});
  assert.throws(()=>service.submit({...f.request,relation:{id:owned.get(owner.id),revision:1}},other,'foreign','foreign'),{code:'relation-not-found'});
  for(const actor of [owner,other,third])for(const plan of service.history(actor.id).entries)service.cancel(plan.id,actor.id);await service.close();
  const db=openIndexDatabase(file),row=db.prepare('SELECT * FROM quality_correspondence_plans WHERE id=?').get(first.id)!;
  try{for(let i=4;i<100;i++){const id=randomUUID(),body=JSON.parse(String(row.body));body.id=id;body.key=`history-${i}`;db.prepare('INSERT INTO quality_correspondence_plans VALUES(?,?,?,?,?,?,?,?)').run(id,row.actor,row.client,body.key,row.fingerprint,JSON.stringify(body),null,row.reserved);}}finally{db.close();}
  service=new CorrespondenceService(file,runner,{} as QualityRangeService);assert.equal(submit().id,first.id);assert.ok(submit(owner,'past-old-row-cap').id);await service.close();
  const bytes=openIndexDatabase(file);try{bytes.prepare('DELETE FROM quality_correspondence_plans WHERE id!=?').run(first.id);}finally{bytes.close();}
  service=new CorrespondenceService(file,runner,{} as QualityRangeService);const quota=openIndexDatabase(file);quota.prepare('UPDATE quality_correspondence_plans SET reserved=? WHERE id=?').run(CORRESPONDENCE_LIMITS.reservedBytes,first.id);quota.close();assert.equal(submit().id,first.id);assert.throws(()=>submit(owner,'bytes-full'),{code:'correspondence-history-full'});
});
test('explicit immutable clock contract: direction, half-open segments, stable order, overlap and exact integer guards',async()=>{
  const {relation}=await correspondenceFixture(),input=relation.input,parsed=referenceRelationInput({...input,clock:{...input.clock,segments:[...input.clock.segments].reverse()}});
  assert.equal(canonicalJson(parsed),canonicalJson(input));assert.equal(parsed.declaration,input.declaration);
  for(const segments of [
    [input.clock.segments[0],{...input.clock.segments[0],id:'overlap'}],
    [input.clock.segments[0],{...input.clock.segments[1],offsetUs:0}],
    [{id:'overflow',referenceStartUs:Number.MAX_SAFE_INTEGER-1,referenceEndUs:Number.MAX_SAFE_INTEGER,offsetUs:1}],
    [{id:'fraction',referenceStartUs:0,referenceEndUs:1,offsetUs:0.5}]
  ])assert.throws(()=>referenceRelationInput({...input,clock:{...input.clock,segments}}));
  assert.throws(()=>referenceRelationInput({...input,sameContent:true}));assert.throws(()=>referenceRelationInput({...input,declaration:' '}));
});
test('raw AU facts retain exact positive/negative joins, half-open holes and stride independently of execution',async()=>{
  const {relation,request,sources}=await correspondenceFixture();request.interval.endAu=2;
  const result=buildCorrespondence(relation,request,sources,work);assert.deepEqual(result.rows.map(r=>r.distorted?.au??null),[1,0,null]);assert.deepEqual(result.rows.map(r=>r.reason),[null,null,'reference-au-missing']);assert.ok(result.rangePlan);assert.equal(result.rangePlan.preRollAndDrain.outputFrames,4);assert.equal(result.work.decodedFrames,0);assert.equal(result.assessment,'exact-clock-match-not-content-certified');
  request.sampling={mode:'stride',every:2,offset:0};const stride=buildCorrespondence(relation,request,sources,work);assert.deepEqual(stride.rows.map(r=>r.selected),[true,false,true]);assert.deepEqual(stride.rangePlan!.unmappedAus,[2]);assert.deepEqual(stride.rangePlan!.unsampledAus,[1]);
  const gap=structuredClone(relation);gap.input.clock.segments=gap.input.clock.segments.slice(0,1);const g=buildCorrespondence(gap,request,sources,work);assert.equal(g.rows[1].reason,'clock-unmapped');assert.equal(g.rows[1].reference!.ptsUs,gap.input.clock.segments[0].referenceEndUs-1+gap.input.clock.segments[0].offsetUs);
});
test('half-open end excludes its exact PTS and an adjacent segment owns that boundary',async()=>{
  const f=await correspondenceFixture(),start=f.doc.packets[0][2],end=f.doc.packets[1][2];assert.ok(end>start);
  const left={id:'left',referenceStartUs:start,referenceEndUs:end,offsetUs:0},right={id:'right',referenceStartUs:end,referenceEndUs:end+1,offsetUs:0};
  const adjacent={...f.relation,input:referenceRelationInput({...f.relation.input,clock:{mode:'piecewise-exact-source-pts-offset',segments:[right,left]}})};
  const joined=buildCorrespondence(adjacent,f.request,f.sources,work);assert.deepEqual(joined.rows.map(r=>r.segmentId),['left','right']);assert.deepEqual(joined.rows.map(r=>r.distorted?.au),[0,1]);assert.equal(joined.rows[1].reference!.ptsUs,left.referenceEndUs);
  const onlyLeft={...f.relation,input:referenceRelationInput({...f.relation.input,clock:{mode:'piecewise-exact-source-pts-offset',segments:[left]}})},excluded=buildCorrespondence(onlyLeft,f.request,f.sources,work);
  assert.equal(excluded.rows[0].status,'mapped');assert.equal(excluded.rows[1].reason,'clock-unmapped');assert.equal(excluded.rows[1].segmentId,null);assert.equal(excluded.rows[1].distorted,null);
});
test('no nearest matching, raw duplicate PTS ambiguity, unsupported geometry and budget blocks remain explainable',async()=>{
  const f=await correspondenceFixture();const missing=structuredClone(f.relation);missing.input.clock.segments[0].offsetUs++;
  assert.equal(buildCorrespondence(missing,f.request,f.sources,work).rows[0].reason,'target-pts-missing');
  const duplicate=structuredClone(f.sources);duplicate[1].index.packets[1][2]=duplicate[1].index.packets[0][2];const r=buildCorrespondence(f.relation,f.request,duplicate,work);assert.equal(r.rows[1].reason,'target-pts-ambiguous');assert.equal(r.rows[1].matches,2);assert.deepEqual(r.rows[1].candidateAus,[0,1]);assert.equal(r.rows[1].reference!.au,1);
  const referenceDuplicate=structuredClone(f.sources);referenceDuplicate[0].index.packets[1][2]=referenceDuplicate[0].index.packets[0][2];assert.equal(buildCorrespondence(f.relation,f.request,referenceDuplicate,work).rows[0].reason,'reference-pts-ambiguous');
  const roi=structuredClone(f.request);roi.recipe.roi.width=64;const unsupported=buildCorrespondence(f.relation,roi,f.sources,work);assert.equal(unsupported.rows[0].status,'unsupported');assert.match(unsupported.rows[0].detail!,/ROI/);assert.match(unsupported.sourceIssues.reference!,/ROI/);assert.equal(unsupported.rangePlan,null);
  const low=structuredClone(f.request);low.budget.maxPackets=3;const blocked=buildCorrespondence(f.relation,low,f.sources,work);assert.equal(blocked.rows[0].status,'mapped');assert.equal(blocked.rangePlan,null);assert.match(blocked.executionBlock!.message,/budget/);
  assert.throws(()=>correspondenceInput({...f.request,sampling:{mode:'stride',every:2,offset:2}}));assert.throws(()=>correspondenceInput({...f.request,interval:{startAu:0,endAu:4096}}));
});
for(const stop of ['cancel','deadline'] as const)test(`planner ${stop} retains the shared slot until physical exit and restart never replans`,async t=>{
  const directory=await mkdtemp(join(tmpdir(),'vp-clock-unit-')),file=join(directory,'plans.sqlite'),gate=new QualityAdmission();let expire=()=>{};const workers:{events:EventEmitter;stopping:boolean;release():void}[]=[];
  const runner=new LibraryPairRunner({qualityAdmission:gate,indexDatabase:'/unused'} as MediaLibraryIndex,'/unused',()=>{const events=new EventEmitter();let release!:()=>void;const exit=new Promise<number>(r=>release=()=>r(0));const state={events,stopping:false,release};workers.push(state);return Object.assign(events,{postMessage(){},terminate(){state.stopping=true;return exit;}}) as unknown as Worker;},{set(callback,ms){assert.equal(ms,10000);expire=callback;return 0 as unknown as ReturnType<typeof setTimeout>;},clear(){}});
  const ranges={plan(){assert.fail('Cancelled plan must not publish results');}} as unknown as QualityRangeService;let service=new CorrespondenceService(file,runner,ranges);
  t.after(async()=>{workers.forEach(w=>w.release());await service.close();await runner.close();await rm(directory,{recursive:true,force:true});});
  const f=await correspondenceFixture(),actor={id:'owner',name:'Owner'},relation=service.createRelation(f.relation.input,actor,'relation','relation').relation,input={...f.request,relation:{id:relation.id,revision:1}};
  const release=gate.acquire(),accepted=service.submit(input,actor,'original','plan').plan;await new Promise(r=>setTimeout(r,10));assert.equal(workers.length,0);assert.equal(service.get(accepted.id,actor.id).attemptId,null);release();await until(()=>workers.length===1);
  const active=service.get(accepted.id,actor.id);assert.ok(active.attemptId);if(stop==='cancel')service.cancel(active.id,actor.id);else expire();await until(()=>workers[0].stopping);assert.equal(service.get(active.id,actor.id).endedAt,null);assert.throws(()=>gate.acquire(),{code:'quality-busy'});workers[0].release();await until(()=>service.get(active.id,actor.id).state===(stop==='cancel'?'cancelled':'failed'));if(stop==='deadline')assert.equal(service.get(active.id,actor.id).reason!.code,'budget-exceeded');const permit=gate.acquire();permit();
  assert.equal(service.submit(input,actor,'replay','plan').plan.requestId,'original');assert.throws(()=>service.get(active.id,'other'),{code:'plan-not-found'});assert.throws(()=>service.createRelation({...f.relation.input,declaration:'different'},actor,'other','relation'),{code:'idempotency-conflict'});
  await service.close();service=new CorrespondenceService(file,runner,ranges);assert.equal(service.get(active.id,actor.id).attemptId,active.attemptId);assert.equal(service.get(active.id,actor.id).state,stop==='cancel'?'cancelled':'failed');assert.equal(workers.length,1);
});

test('exact fractional-frame offsets preserve canonical identity, reject inconsistent projections and detect sub-microsecond overlap',async()=>{
  const f=await correspondenceFixture(),input=f.relation.input;
  const segment={id:'ntsc',referenceStartUs:0,referenceEndUs:100000,offsetUs:33367,offset:{ticks:1001,timescale:30000}};
  const parse=(segments:typeof segment[])=>referenceRelationInput({...input,clock:{mode:'piecewise-exact-source-pts-offset',segments}});
  const value=parse([segment]);assert.deepEqual(value.clock.segments[0].offset,segment.offset);
  assert.equal(canonicalJson(parse([{...segment,offset:{ticks:2002,timescale:60000}}])),canonicalJson(value));
  assert.throws(()=>parse([{...segment,offsetUs:33366}]),/projection/);
  for(const offset of [{ticks:NaN,timescale:30000},{ticks:1,timescale:0},{ticks:1,timescale:1.5},{ticks:1,timescale:1,extra:1}])assert.throws(()=>parse([{...segment,offset}]));
  // Rounded offsets are both zero, but the translated half-open intervals overlap.
  assert.throws(()=>parse([{id:'a',referenceStartUs:0,referenceEndUs:1,offsetUs:0,offset:{ticks:1,timescale:3000000}},
    {id:'b',referenceStartUs:1,referenceEndUs:2,offsetUs:0,offset:{ticks:0,timescale:1}}]),/Overlapping distorted/);
  assert.equal(parse([{id:'a',referenceStartUs:0,referenceEndUs:1,offsetUs:0,offset:{ticks:1,timescale:3000000}},
    {id:'b',referenceStartUs:1,referenceEndUs:2,offsetUs:0,offset:{ticks:1,timescale:3000000}}]).clock.segments.length,2);
});

test('execution intents are atomically reserved, migrated and replayed through rejection and lost downstream acceptance',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'vp-intent-quota-')),file=join(directory,'plans.sqlite'),f=await correspondenceFixture();
 const {QualityRangeService}=await import('../../server/analysis/quality/range-service.ts');
 let reject=true,lost=false,downstream=0;const accepted=new Map<string,any>();
 const ranges={plan:QualityRangeService.prototype.plan,get:(id:string)=>[...accepted.values()].find(j=>j.id===id),submit(input:any,actor:any,requestId:string,key:string){
   downstream++;if(reject)throw Object.assign(Error('range queue full'),{code:'range-queue-full'});
   let job=accepted.get(input.client.id);if(!job){job={id:randomUUID(),requestId,key,plan:this.plan(input)};accepted.set(input.client.id,job);}
   if(lost){lost=false;throw Error('lost acceptance');}return {job,replayed:true};
 }};
 const runner={planCorrespondence:async(relation:any,input:any,_signal:any,observer:any)=>{observer.admitted();return buildCorrespondence(relation,input,f.sources,work);}} as LibraryPairRunner;
 let service=new CorrespondenceService(file,runner,ranges as unknown as QualityRangeService);const db=openIndexDatabase(file);
 t.after(async()=>{db.close();await service.close();await rm(directory,{recursive:true,force:true});});
 const actor={id:'owner',name:'Owner'},relation=service.createRelation(f.relation.input,actor,'relation','relation').relation;
 const plan=service.submit({...f.request,relation:{id:relation.id,revision:1}},actor,'plan','plan').plan;
 await until(()=>service.get(plan.id,actor.id).state==='completed');const done=service.get(plan.id,actor.id),body={digest:done.resultDigest};
 const relationBytes=Number(db.prepare('SELECT sum(reserved) n FROM quality_relations').get()!.n);
 db.prepare('UPDATE quality_correspondence_plans SET reserved=? WHERE id=?').run(CORRESPONDENCE_LIMITS.reservedBytes-relationBytes,done.id);
 assert.throws(()=>service.execute(done.id,actor,body,'first'),{code:'correspondence-history-full'});
 assert.equal(downstream,0);assert.equal(db.prepare('SELECT count(*) n FROM quality_plan_executions').get()!.n,0);
 db.exec('UPDATE quality_correspondence_plans SET reserved=length(CAST(body AS BLOB))+length(CAST(result AS BLOB))+1024');
 assert.throws(()=>service.execute(done.id,actor,body,'original-execute'),{code:'range-queue-full'});
 const intent=()=>db.prepare('SELECT body,reserved FROM quality_plan_executions WHERE plan_id=?').get(done.id)!;
 const original=String(intent().body),reserved=Number(intent().reserved);assert.equal(reserved,Buffer.byteLength(original)+1024+34);
 assert.throws(()=>service.execute(done.id,actor,body,'different-request'),{code:'range-queue-full'});assert.equal(intent().reserved,reserved);assert.equal(String(intent().body),original);
 await service.close();db.exec('ALTER TABLE quality_plan_executions DROP COLUMN reserved; PRAGMA user_version=1');
 service=new CorrespondenceService(file,runner,ranges as unknown as QualityRangeService);assert.equal(intent().reserved,reserved);assert.equal(String(intent().body),original);
 reject=false;lost=true;assert.throws(()=>service.execute(done.id,actor,body,'lost'),/lost acceptance/);assert.equal(accepted.size,1);assert.equal(service.detail(done.id,actor.id).execution!.state,'submission-unconfirmed');
 const replay=service.execute(done.id,actor,body,'recover');assert.equal(replay.job.requestId,'original-execute');assert.equal(replay.job.key,'execute');assert.equal(accepted.size,1);
 assert.equal(Number(intent().reserved),Buffer.byteLength(String(intent().body))+1024);
 const calls=downstream;assert.equal(service.execute(done.id,actor,body,'again').job.id,replay.job.id);assert.equal(downstream,calls);
 await service.close();service=new CorrespondenceService(file,runner,ranges as unknown as QualityRangeService);assert.equal(service.taskRange(done.id,actor.id),replay.job.id);assert.equal(intent().reserved,Buffer.byteLength(String(intent().body))+1024);
});
