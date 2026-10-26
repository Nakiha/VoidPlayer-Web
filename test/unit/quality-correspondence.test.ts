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

const work={indexBytes:100,indexPackets:4,sourceReadBytes:0 as const,decodedFrames:0 as const,elapsedMs:1};
const until=async(fn:()=>boolean)=>{for(let n=0;n<500;n++){if(fn())return;await new Promise(r=>setTimeout(r,5));}assert.fail('Planner transition timeout');};
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
test('no nearest matching, raw duplicate PTS ambiguity, unsupported geometry and budget blocks remain explainable',async()=>{
  const f=await correspondenceFixture();const missing=structuredClone(f.relation);missing.input.clock.segments[0].offsetUs++;
  assert.equal(buildCorrespondence(missing,f.request,f.sources,work).rows[0].reason,'target-pts-missing');
  const duplicate=structuredClone(f.sources);duplicate[1].index.packets[1][2]=duplicate[1].index.packets[0][2];const r=buildCorrespondence(f.relation,f.request,duplicate,work);assert.equal(r.rows[1].reason,'target-pts-ambiguous');assert.equal(r.rows[1].matches,2);assert.deepEqual(r.rows[1].candidateAus,[0,1]);assert.equal(r.rows[1].reference!.au,1);
  const referenceDuplicate=structuredClone(f.sources);referenceDuplicate[0].index.packets[1][2]=referenceDuplicate[0].index.packets[0][2];assert.equal(buildCorrespondence(f.relation,f.request,referenceDuplicate,work).rows[0].reason,'reference-pts-ambiguous');
  const roi=structuredClone(f.request);roi.recipe.roi.width=64;const unsupported=buildCorrespondence(f.relation,roi,f.sources,work);assert.equal(unsupported.rows[0].status,'unsupported');assert.match(unsupported.rows[0].detail!,/ROI/);assert.equal(unsupported.rangePlan,null);
  const low=structuredClone(f.request);low.budget.maxPackets=3;const blocked=buildCorrespondence(f.relation,low,f.sources,work);assert.equal(blocked.rows[0].status,'mapped');assert.equal(blocked.rangePlan,null);assert.match(blocked.executionBlock!.message,/budget/);
  assert.throws(()=>correspondenceInput({...f.request,sampling:{mode:'stride',every:2,offset:2}}));assert.throws(()=>correspondenceInput({...f.request,interval:{startAu:0,endAu:256}}));
});
test('planner admission has no outer permit; cancellation retains slot until physical exit and restart never replans',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'vp-clock-unit-')),file=join(directory,'plans.sqlite'),gate=new QualityAdmission(),workers:{events:EventEmitter;stopping:boolean;release():void}[]=[];
  const runner=new LibraryPairRunner({qualityAdmission:gate,indexDatabase:'/unused'} as MediaLibraryIndex,'/unused',()=>{const events=new EventEmitter();let release!:()=>void;const exit=new Promise<number>(r=>release=()=>r(0));const state={events,stopping:false,release};workers.push(state);return Object.assign(events,{postMessage(){},terminate(){state.stopping=true;return exit;}}) as unknown as Worker;});
  const ranges={plan(){assert.fail('Cancelled plan must not publish results');}} as unknown as QualityRangeService;let service=new CorrespondenceService(file,runner,ranges);
  t.after(async()=>{workers.forEach(w=>w.release());await service.close();await runner.close();await rm(directory,{recursive:true,force:true});});
  const f=await correspondenceFixture(),actor={id:'owner',name:'Owner'},relation=service.createRelation(f.relation.input,actor,'relation','relation').relation,input={...f.request,relation:{id:relation.id,revision:1}};
  const release=gate.acquire(),accepted=service.submit(input,actor,'original','plan').plan;await new Promise(r=>setTimeout(r,10));assert.equal(workers.length,0);assert.equal(service.get(accepted.id,actor.id).attemptId,null);release();await until(()=>workers.length===1);
  const active=service.get(accepted.id,actor.id);assert.ok(active.attemptId);service.cancel(active.id,actor.id);await until(()=>workers[0].stopping);assert.equal(service.get(active.id,actor.id).endedAt,null);assert.throws(()=>gate.acquire(),{code:'quality-busy'});workers[0].release();await until(()=>service.get(active.id,actor.id).state==='cancelled');const permit=gate.acquire();permit();
  assert.equal(service.submit(input,actor,'replay','plan').plan.requestId,'original');assert.throws(()=>service.get(active.id,'other'),{code:'plan-not-found'});assert.throws(()=>service.createRelation({...f.relation.input,declaration:'different'},actor,'other','relation'),{code:'idempotency-conflict'});
  await service.close();service=new CorrespondenceService(file,runner,ranges);assert.equal(service.get(active.id,actor.id).attemptId,active.attemptId);assert.equal(service.get(active.id,actor.id).state,'cancelled');assert.equal(workers.length,1);
});
