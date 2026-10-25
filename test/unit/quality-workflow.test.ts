import test from 'node:test';
import assert from 'node:assert/strict';
import { QualityJobObserver } from '../../src/analysis/quality/job-observer.ts';
import type { QualityTransport,QualityHistory } from '../../src/services/quality-jobs.ts';
import type { QualityJob,QualityJobInput,QualityJobResult } from '../../shared/analysis/quality/jobs.ts';
import { qualityFrameCandidates,qualityFrameQuery } from '../../shared/analysis/quality/selection.ts';
import type { LibraryPairBinding } from '../../shared/analysis/quality/library-pair.ts';
import { wrapFlv,pairAvcc,admissionIdr,preparedPair,pairRequest } from '../helpers/frame-pair-fixture.ts';
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(reason:unknown)=>void;const promise=new Promise<T>((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
function memory(){const values=new Map<string,string>();return {getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value);},removeItem:(key:string)=>{values.delete(key);}};}
const input={schema:'voidplayer-psnr-frame-job',version:1,client:{kind:'browser',id:'tab-1'},request:{}}as QualityJobInput;
function job(id='job-1',revision=1):QualityJob{return {id,revision,sequence:revision,state:'running',phase:'decode',createdAt:1,submitted:{actorId:'a',client:input.client},result:{available:false},attempt:{id:'attempt-1'},input}as QualityJob;}
function transport():QualityTransport{return {submit:async()=>({job:job(),replayed:false}),get:async()=>job(),result:async()=>assert.fail('no result'),cancel:async()=>({...job(),state:'cancelling'}),changes:async()=>({schema:'voidplayer-quality-jobs',version:1,resources:{queued:0,activeAttempts:0},limits:{},entries:[],cursor:0,head:0,more:false})as QualityHistory};}

test('submission is frozen and saved before POST; double click and lost response retry reuse key/body across reload',async()=>{
 const io=transport(),storage=memory(),calls:{actor:string;body:QualityJobInput;key:string}[]=[],gate=deferred<{job:QualityJob;replayed:boolean}>();
 io.submit=async(actor,body,key)=>{assert.ok(storage.getItem('voidplayer-quality-pending:a:tab-1'));calls.push({actor,body,key});return gate.promise;};
 const o=new QualityJobObserver(io,'a','tab-1',()=>{},storage,()=> 'original-key');
 const first=o.submit(input),second=o.submit({...input,request:{changed:true}as any});assert.equal(first,second);assert.equal(calls.length,1);
 input.request={}as any;gate.reject(new TypeError('lost response'));await first;assert.ok(o.snapshot().pending);assert.equal(o.snapshot().jobs.length,0);o.dispose();
 io.submit=async(actor,body,key)=>{calls.push({actor,body,key});return {job:job(),replayed:true};};
 const restored=new QualityJobObserver(io,'a','tab-1',()=>{},storage,()=>assert.fail('retry must not mint a key'));
 await restored.submit({...input,request:{different:true}as any});assert.deepEqual(calls[0],calls[1]);assert.equal(restored.snapshot().jobs.length,1);assert.equal(restored.snapshot().pending,null);restored.dispose();
});

test('dispose/actor/client switch fences ignored-abort replies and only stops observation; uncertain request remains actor/client scoped',async()=>{
 const io=transport(),store=memory(),gate=deferred<{job:QualityJob;replayed:boolean}>();let cancelled=0,published=0;
 io.cancel=async()=>{cancelled++;return job();};io.submit=()=>gate.promise;
 const old=new QualityJobObserver(io,'a','tab-1',()=>{published++;},store,()=> 'key');const request=old.submit(input);old.dispose();const count=published;
 const actor=new QualityJobObserver(io,'b','tab-1',()=>{},store);assert.equal(actor.snapshot().pending,null);
 const client=new QualityJobObserver(io,'a','tab-2',()=>{},store);assert.equal(client.snapshot().pending,null);
 gate.resolve({job:job(),replayed:false});await request;assert.equal(published,count);assert.equal(cancelled,0);assert.ok(store.getItem('voidplayer-quality-pending:a:tab-1'));
 actor.dispose();client.dispose();
});

test('paged service facts dedupe by revision, preserve non-browser clients and do not translate observation errors into failed jobs',async()=>{
 const io=transport();let calls=0;io.changes=async(_actor,after)=>{
  calls++;if(calls===1){assert.equal(after,0);return {schema:'voidplayer-quality-jobs',version:1,resources:{queued:0,activeAttempts:0},limits:{},entries:[job('agent-job',2)],cursor:2,head:4,more:true}as QualityHistory;}
  if(calls===2){assert.equal(after,2);return {schema:'voidplayer-quality-jobs',version:1,resources:{queued:0,activeAttempts:0},limits:{},entries:[job('agent-job',1),job('browser-job',4)],cursor:4,head:4,more:false}as QualityHistory;}
  throw new Error('offline');};
 const o=new QualityJobObserver(io,'a','tab-1',()=>{},memory());await o.poll();assert.equal(o.snapshot().jobs.length,2);assert.equal(o.snapshot().jobs.find(j=>j.id==='agent-job')?.revision,2);
 await o.poll();assert.ok(o.snapshot().error);assert.deepEqual(o.snapshot().jobs.map(j=>j.state),['running','running']);o.dispose();
});

test('late detail/result from another selection cannot overwrite selected task; explicit cancel uses returned terminal fact',async()=>{
 const io=transport(),gate=deferred<QualityJobResult>();io.get=async(_actor,id)=>({...job(id),result:{available:id==='old',url:'',digest:null}});io.result=()=>gate.promise;
 io.cancel=async(_actor,id)=>({...job(id,2),state:'completed'});
 const o=new QualityJobObserver(io,'a','tab-1',()=>{},memory());const old=o.select('old');await Promise.resolve();await o.select('new');gate.resolve({jobId:'old'}as QualityJobResult);await old;
 assert.equal(o.snapshot().detail?.id,'new');assert.equal(o.snapshot().result,null);await o.cancel('new');assert.equal(o.snapshot().detail?.state,'completed');o.dispose();
});

test('failed draft persistence sends no POST; explicit abandon creates a separate operation',async()=>{
 let sent=0;const io=transport();io.submit=async()=>{sent++;return {job:job(),replayed:false};};
 const o=new QualityJobObserver(io,'a','tab-1',()=>{},{getItem:()=>null,setItem:()=>{throw new Error('quota');},removeItem:()=>{}});
 await o.submit(input);assert.equal(sent,0);assert.ok(o.snapshot().operationError);o.dispose();
});

async function fixture(){const value=await preparedPair(wrapFlv('h264',pairAvcc,[admissionIdr,admissionIdr]));
 const proof={binding:value.source.binding,producer:{producer:'server-flv-scan-v1'}}as LibraryPairBinding;return {proof,doc:value.source.index!};}
test('candidate selection returns exact identities/AU/nonzero source PTS; bounded page requires original build and never pairs',async()=>{
 const {proof,doc}=await fixture();const first=qualityFrameCandidates(proof,doc,{afterAu:0,limit:1});
 assert.equal(first.entries.length,1);assert.equal(first.entries[0].picture.au,0);assert.equal(first.entries[0].sourcePtsUs,2000000);assert.deepEqual(first.entries[0].indexIdentity,proof.binding.indexIdentity);assert.equal(first.nextAu,1);
 const second=qualityFrameCandidates(proof,doc,{afterAu:first.nextAu!,limit:1,buildId:proof.binding.indexBuildId});assert.equal(second.entries[0].picture.au,1);assert.equal(second.entries[0].sourcePtsUs,3000000);assert.equal(second.nextAu,null);
 assert.match(first.eligibility,/candidate-execution-verifies/);assert.equal(first.geometry.width,32);assert.equal(first.inspection.supported,true);
 assert.throws(()=>qualityFrameQuery({afterAu:1,limit:1}),/original build/);
 assert.throws(()=>qualityFrameCandidates(proof,doc,{afterAu:1,limit:1,buildId:'rebuilt'}),/changed/);
 assert.throws(()=>qualityFrameQuery({afterAu:0,limit:51}),/bounded/);
});
test('duplicates, non-forward clocks and configuration changes never become candidates; no implicit cache rebuild',async()=>{
 const {proof,doc}=await fixture();doc.packets[1][2]=doc.packets[0][2];assert.deepEqual(qualityFrameCandidates(proof,doc,{afterAu:0,limit:50}).entries,[]);
 doc.packets[1][2]++;doc.packets[1][4]=0;assert.deepEqual(qualityFrameCandidates(proof,doc,{afterAu:0,limit:50}).entries.map(p=>p.picture.au),[0]);
 doc.configurations=[doc.description];assert.throws(()=>qualityFrameCandidates(proof,doc,{afterAu:0,limit:50}),/single-configuration/);
 assert.throws(()=>qualityFrameCandidates(proof,null as any,{afterAu:0,limit:1}),/Invalid quality cache/);
});

test('foreign/mismatched service replies never publish private facts or clear the uncertain submission',async()=>{
 const io=transport(),store=memory(),foreign={...job(),submitted:{...job().submitted,actorId:'b'}};
 io.submit=async()=>({job:foreign,replayed:false});io.get=async()=>foreign;
 const o=new QualityJobObserver(io,'a','tab-1',()=>{},store);await o.submit(input);assert.equal(o.snapshot().jobs.length,0);assert.ok(o.snapshot().pending);assert.ok(o.snapshot().operationError);
 await o.select(foreign.id);assert.equal(o.snapshot().detail,null);assert.ok(o.snapshot().error);o.dispose();
});
test('explicit history resync ignores an old page, restarts at zero and does not resubmit work',async()=>{
 const io=transport(),gate=deferred<QualityHistory>();let count=0,sent=0;
 io.submit=async()=>{sent++;return {job:job(),replayed:false};};
 io.changes=async(_actor,after)=>{assert.equal(after,0);if(count++===0)return gate.promise;return {schema:'voidplayer-quality-jobs',version:1,entries:[job('fresh',3)],head:3,cursor:3,more:false,resources:{queued:0,activeAttempts:0},limits:{}};};
 const o=new QualityJobObserver(io,'a','tab-1',()=>{},memory()),poll=o.poll();await o.resync();gate.resolve({schema:'voidplayer-quality-jobs',version:1,entries:[job('old',9)],head:9,cursor:9,more:false,resources:{queued:0,activeAttempts:0},limits:{}});await poll;
 assert.equal(o.snapshot().jobs.length,0);await o.poll();assert.deepEqual(o.snapshot().jobs.map(j=>j.id),['fresh']);assert.equal(sent,0);o.dispose();
});
