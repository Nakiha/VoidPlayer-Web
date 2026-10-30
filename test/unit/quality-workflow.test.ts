import {normalizeQualityJobInput} from '../../shared/analysis/quality/job-input.ts';
import test from 'node:test';
import {FrozenSubmissionJournal,assertJobReceipt} from '../../src/services/frozen-submission.ts';
import {QualityObservationScope} from '../../src/analysis/quality/observation-scope.ts';
import {candidateAnnotations} from '../../src/analysis/quality/candidate-evidence.ts';
import {ApiError} from '../../src/services/api-error.ts';
import type {AnnotationRecord} from '../../shared/review/annotation-record.ts';
import assert from 'node:assert/strict';
import { QualityJobObserver } from '../../src/analysis/quality/job-observer.ts';
import type { QualityTransport,QualityHistory } from '../../src/services/quality-jobs.ts';
import type { QualityJob,QualityJobInput,QualityJobResult } from '../../shared/analysis/quality/jobs.ts';
import { qualityFrameCandidates,qualityFrameQuery } from '../../shared/analysis/quality/selection.ts';
import type { LibraryPairBinding } from '../../shared/analysis/quality/library-pair.ts';
import { wrapFlv,pairAvcc,admissionIdr,preparedPair,pairRequest } from '../helpers/frame-pair-fixture.ts';
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(reason:unknown)=>void;const promise=new Promise<T>((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
function memory(){const values=new Map<string,string>();return {getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value);},removeItem:(key:string)=>{values.delete(key);}};}
const examplePair=await preparedPair(wrapFlv('h264',pairAvcc,[admissionIdr]));
const input={schema:'voidplayer-psnr-frame-job',version:1,client:{kind:'browser',id:'tab-1'},request:pairRequest(examplePair.target)}as QualityJobInput;
function job(id='job-1',revision=1,key='key'):QualityJob{return {id,revision,sequence:revision,state:'running',phase:'decode',createdAt:1,submitted:{actorId:'a',client:input.client,idempotencyKey:key},result:{available:false},attempt:{id:'attempt-1'},input:normalizeQualityJobInput(input)}as QualityJob;}
function transport():QualityTransport{return {submit:async(_actor,_body,key)=>({job:job('job-1',1,key),replayed:false}),get:async()=>job(),result:async()=>assert.fail('no result'),cancel:async()=>({...job(),state:'cancelling'}),changes:async()=>({schema:'voidplayer-quality-jobs',version:1,resources:{queued:0,activeAttempts:0},limits:{},entries:[],cursor:0,head:0,more:false})as QualityHistory};}

test('submission is frozen and saved before POST; double click and lost response retry reuse key/body across reload',async()=>{
 const io=transport(),storage=memory(),calls:{actor:string;body:QualityJobInput;key:string}[]=[],gate=deferred<{job:QualityJob;replayed:boolean}>();
 io.submit=async(actor,body,key)=>{assert.ok(storage.getItem('voidplayer-quality-pending:a:tab-1'));calls.push({actor,body,key});return gate.promise;};
 const o=new QualityJobObserver(io,'a','tab-1',()=>{},storage,()=> 'original-key');
 const original=structuredClone(input);const first=o.submit(original),second=o.submit({...input,request:{changed:true}as any});assert.equal(first,second);assert.equal(calls.length,1);
 original.request={}as any;gate.reject(new TypeError('lost response'));await first;assert.ok(o.snapshot().pending);assert.equal(o.snapshot().jobs.length,0);o.dispose();
 io.submit=async(actor,body,key)=>{calls.push({actor,body,key});return {job:job('job-1',1,key),replayed:true};};
 const restored=new QualityJobObserver(io,'a','tab-1',()=>{},storage,()=>assert.fail('retry must not mint a key'));
 await restored.submit({...input,request:{different:true}as any});assert.deepEqual(calls[0],calls[1]);assert.equal(restored.snapshot().jobs.length,1);assert.equal(restored.snapshot().pending,null);restored.dispose();
});

test('dispose/actor/client switch fences DOM while valid ignored-abort receipts settle only their original keys',async()=>{
 const io=transport(),store=memory(),gate=deferred<{job:QualityJob;replayed:boolean}>();let cancelled=0,published=0;
 io.cancel=async()=>{cancelled++;return job();};io.submit=()=>gate.promise;
 const old=new QualityJobObserver(io,'a','tab-1',()=>{published++;},store,()=> 'key');const request=old.submit(input);old.dispose();const count=published;
 const actor=new QualityJobObserver(io,'b','tab-1',()=>{},store);assert.equal(actor.snapshot().pending,null);
 const client=new QualityJobObserver(io,'a','tab-2',()=>{},store);assert.equal(client.snapshot().pending,null);
 gate.resolve({job:job(),replayed:false});await request;assert.equal(published,count);assert.equal(cancelled,0);assert.equal(store.getItem('voidplayer-quality-pending:a:tab-1'),null,'valid late receipt settles its original key without publishing to a disposed view');
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
test('zero CTS does not select an immediate-output decoder: bounded candidates carry explicit complete GOP',async()=>{
 const {proof,doc}=await fixture();doc.packets[1][4]=0;
 const page=qualityFrameCandidates(proof,doc,{afterAu:0,limit:50});assert.equal(page.entries.length,2);
 for(const target of page.entries)assert.deepEqual(target.decode,{mode:'packet-identity-gop-v1',startAu:0,endAu:1});
});
test('duplicate/invalid clocks reject; nonzero CTS candidates require explicit GOP identity without implicit cache rebuild',async()=>{
 const {proof,doc}=await fixture();doc.packets[1][2]=doc.packets[0][2];assert.deepEqual(qualityFrameCandidates(proof,doc,{afterAu:0,limit:50}).entries,[]);
 doc.packets[1][2]++;doc.packets[1][4]=0;const reordered=qualityFrameCandidates(proof,doc,{afterAu:0,limit:50}).entries;assert.deepEqual(reordered.map(p=>p.picture.au),[0,1]);assert.deepEqual(reordered[1].decode,{mode:'packet-identity-gop-v1',startAu:0,endAu:1});assert.equal(reordered[1].sourcePtsUs,doc.packets[1][2]);
 doc.packets[1][3]=doc.packets[0][3];assert.deepEqual(qualityFrameCandidates(proof,doc,{afterAu:0,limit:50}).entries.map(p=>p.picture.au),[0]);
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
 assert.deepEqual(o.snapshot().jobs.map(j=>j.id),['fresh']);assert.equal(count,2,'resync starts a fresh page immediately and the late old page is ignored');assert.equal(sent,0);o.dispose();
});

test('independent ROI uses its own source grid, even snapping and strict bounds, never playback transforms',async()=>{
 const {qualityRoi,draggedQualityRoi}=await import('../../shared/review/quality-roi.ts');
 for(const scale of [0.25,1,3.5])for(const dpr of [1,2,3]){
  const rect={left:123,top:57,width:32*scale*dpr,height:32*scale*dpr};
  const point=(x:number,y:number)=>({x:(rect.left+x*rect.width-rect.left)/rect.width,y:(rect.top+y*rect.height-rect.top)/rect.height});
  assert.deepEqual(draggedQualityRoi(32,32,point(2/32,4/32),point(26/32,24/32)),{x:2,y:4,width:24,height:20});
  assert.deepEqual(draggedQualityRoi(32,32,point(26/32,24/32),point(2/32,4/32)),{x:2,y:4,width:24,height:20});
 }
 assert.deepEqual(draggedQualityRoi(32,32,{x:2.6/32,y:4.4/32},{x:25.6/32,y:24.3/32}),{x:2,y:4,width:24,height:20});
 for(const roi of [{x:1,y:0,width:2,height:2},{x:0,y:0,width:33,height:2},{x:-2,y:0,width:2,height:2},{x:0,y:0,width:0,height:2},{x:0,y:0,width:Infinity,height:2}])assert.throws(()=>qualityRoi(32,32,roi));
 assert.throws(()=>draggedQualityRoi(32,32,{x:-0.01,y:0},{x:1,y:1}));assert.throws(()=>draggedQualityRoi(32,32,{x:0,y:0},{x:0.01,y:0.01}));
});

test('candidate preflight uses the complete HTTP operation validator before storage or fetch',async()=>{
 const {qualityCandidateOperation,createQualityCandidate}=await import('../../src/review/quality-evidence-client.ts');
 const client={kind:'gui' as const,id:'candidate-tab'},base={space:'default',id:'candidate-id',operationId:'candidate-op',candidate:{text:'Explicit candidate',severity:2},evidence:{jobId:'job-valid',attemptId:'attempt-valid',digest:'1'.repeat(64),side:'reference' as const}};
 const valid=qualityCandidateOperation(base,client);assert.equal(valid.action,'create-quality-candidate');assert.equal(valid.revision,0);assert.deepEqual(valid.candidate,base.candidate);
 const invalid=[...[0,-1,6,1.5,NaN,Infinity].map(severity=>({...base,candidate:{...base.candidate,severity}})),{...base,candidate:{...base.candidate,text:' '}},{...base,space:'bad/space'},{...base,space:undefined as unknown as string},{...base,space:null as unknown as string},{...base,id:''},{...base,evidence:{...base.evidence,digest:'bad'}}];
 const original=globalThis.fetch;let sent=0;globalThis.fetch=async()=>{sent++;throw new Error('unexpected POST');};
 try{for(const command of invalid){assert.throws(()=>qualityCandidateOperation(command,client));assert.throws(()=>createQualityCandidate(command,client,'actor'));}assert.throws(()=>qualityCandidateOperation(base,{kind:'gui',id:'invalid/client'}));assert.equal(sent,0);}finally{globalThis.fetch=original;}
});

// Shared operation and observation protocols, exercised without DOM or machine-speed races.
test('unknown receipt followed by actor rejection retains the original body/key, then confirms the original operation',async()=>{
 const store=memory(),journal=new FrozenSubmissionJournal(store,a=>'pending:'+a,v=>v as {n:number},undefined,()=> 'original');
 const p=journal.freeze('a',{n:1}),seen:unknown[]=[];
 await assert.rejects(journal.execute('a',p.key,async frozen=>{seen.push(frozen.body);throw new TypeError('lost response');},()=>{}));
 await assert.rejects(journal.execute('a',p.key,async frozen=>{seen.push(frozen.body);throw new ApiError(409,'Actor changed','actor-changed');},()=>{}));
 assert.equal(journal.pending('a')?.key,p.key);assert.deepEqual(journal.pending('a')?.body,{n:1});
 const r=await journal.execute('a',p.key,async frozen=>{seen.push(frozen.body);return {id:'original-job'};},r=>assert.equal(r.id,'original-job'));
 assert.equal(r.id,'original-job');assert.equal(journal.pending('a')?.confirmed,true);assert.deepEqual(seen,[{n:1},{n:1},{n:1}]);
});
test('legacy pending is uncertain; a definite first rejection frees only a provably unsent key',async()=>{
 const store=memory(),journal=new FrozenSubmissionJournal(store,a=>a,v=>v,undefined,()=> 'fresh');
 store.setItem('legacy',JSON.stringify({body:{n:1},key:'old'}));
 await assert.rejects(journal.execute('legacy','old',async()=>{throw new ApiError(409,'actor','actor-changed');},()=>{}));assert.ok(journal.pending('legacy'));
 const p=journal.freeze('fresh',{n:2});await assert.rejects(journal.execute('fresh',p.key,async()=>{throw new ApiError(400,'Rejected');},()=>{}));assert.equal(journal.pending('fresh'),null);
});
test('submission coalesces duplicate clicks; persisted attempts and valid receipts outlive observation',async()=>{
 const store=memory(),journal=new FrozenSubmissionJournal(store,a=>a,v=>v,undefined,()=> 'key'),gate=deferred<{id:string}>();let sends=0;
 const p=journal.freeze('a',{n:1}),send=()=>{sends++;return gate.promise;},check=(r:{id:string})=>assert.equal(r.id,'job');
 const first=journal.execute('a',p.key,send,check),second=journal.execute('a',p.key,send,check);assert.equal(first,second);await Promise.resolve();assert.equal(sends,1);
 gate.resolve({id:'job'});await first;assert.equal(journal.pending('a')?.confirmed,true);
 const old=deferred<{id:string}>();journal.clearConfirmed('a');const again=journal.freeze('a',{n:2});const late=journal.execute('a',again.key,()=>old.promise,check);await Promise.resolve();
 store.setItem('a',JSON.stringify({key:'newer',body:{n:3},attempted:false}));old.resolve({id:'job'});await late;assert.equal(journal.pending('a')?.key,'newer');assert.equal(journal.pending('a')?.confirmed,undefined);
});
test('storage or acknowledgement validation failure cannot manufacture acceptance or issue an unrecoverable POST',async()=>{
 const store=memory(),journal=new FrozenSubmissionJournal(store,a=>a,v=>v,undefined,()=> 'key');let sends=0;
 const p=journal.freeze('a',{n:1});const original=store.setItem;store.setItem=()=>{throw Error('Storage denied');};
 await assert.rejects(journal.execute('a',p.key,async()=>{sends++;return {};},()=>{}));assert.equal(sends,0);store.setItem=original;
 await assert.rejects(journal.execute('a',p.key,async()=>({}),()=>{throw Error('Incomplete receipt');}));assert.notEqual(journal.pending('a')?.confirmed,true);
});
test('observation coalesces slow history without invalidating successful responses; selection has its own scope',async()=>{
 const scope=new QualityObservationScope(),gate=deferred<number>();let reads=0,commits=0;
 const first=scope.run('history','actor',async()=>{const c=scope.capture('actor');reads++;const value=await gate.promise;if(c.current())commits++;return value;});
 for(let n=0;n<5;n++)assert.equal(scope.run('history','actor',async()=>assert.fail('overlap')),first);
 await Promise.resolve();const selected=scope.capture();scope.select();assert.equal(selected.current(),false);
 gate.resolve(1);await first;assert.equal(reads,1);assert.equal(commits,1);scope.close();
});
test('ignored abort replies cannot publish to a new identity, target or request slot',async()=>{
 const scope=new QualityObservationScope(),old=deferred<void>(),fresh=deferred<void>();let writes=0;
 const a=scope.run('detail','selection',async()=>{const c=scope.capture();await old.promise;if(c.current())writes++;});await Promise.resolve();
 scope.invalidate();const b=scope.run('detail','selection',async()=>{const c=scope.capture();await fresh.promise;if(c.current())writes++;});await Promise.resolve();
 old.resolve();await a;assert.equal(writes,0);assert.equal(scope.run('detail','selection',async()=>assert.fail('old completion removed fresh slot')),b);
 fresh.resolve();await b;assert.equal(writes,1);scope.close();
});
test('candidate evidence assembles completely before commit and retries a failed later annotation',async()=>{
 const receipt={policy:{space:'default'},createdIds:['one','two']};let reads=0,fail=true;
 const read=async(space:string,id:string)=>{reads++;if(id==='two'&&fail)throw Error('Temporary annotation read');return {space,id,deleted:false} as AnnotationRecord;};
 await assert.rejects(candidateAnnotations(receipt,read));assert.equal(reads,2);fail=false;
 assert.equal((await candidateAnnotations(receipt,read)).length,2);assert.equal(reads,4);
 await assert.rejects(candidateAnnotations({...receipt,createdIds:['one','one']},read));
});

test('late valid PSNR acceptance confirms its key without selecting the old job over a newer target',async()=>{
 const io=transport(),store=memory(),gate=deferred<{job:QualityJob;replayed:boolean}>();
 io.submit=()=>gate.promise;io.get=async(_actor,id)=>job(id);
 const observer=new QualityJobObserver(io,'a','tab-1',()=>{},store,()=> 'key');
 const submitting=observer.submit(input);await observer.select('new-target');gate.resolve({job:job('accepted-original'),replayed:false});await submitting;
 assert.equal(observer.snapshot().detail?.id,'new-target');assert.equal(observer.snapshot().pending,null);assert.equal(observer.snapshot().busy,false);assert.equal(store.getItem('voidplayer-quality-pending:a:tab-1'),null);observer.dispose();
});

test('a previously rejected operation becomes unknown again before a replay can be accepted',async()=>{
 const store=memory(),journal=new FrozenSubmissionJournal(store,a=>a,v=>v,undefined,()=> 'key'),p=journal.freeze('a',{n:1});
 await assert.rejects(journal.execute('a',p.key,async()=>{throw new ApiError(409,'Not accepted');},()=>{},false,'mark'));
 assert.equal(journal.pending('a')?.rejected?.verified,true);
 await assert.rejects(journal.execute('a',p.key,async()=>{throw new TypeError('Accepted but receipt lost');},()=>{},false,'mark'));
 assert.equal(journal.pending('a')?.rejected,undefined);assert.equal(journal.pending('a')?.attempted,true);
 await assert.rejects(journal.execute('a',p.key,async()=>{throw new ApiError(409,'Actor changed','actor-changed');},()=>{},false,'mark'));
 assert.equal(journal.pending('a')?.rejected,undefined);
});


test('PSNR receipt compares canonical v1 defaults without rewriting the frozen wire body',()=>{
 const raw=structuredClone(input),before=JSON.stringify(raw),p={key:'key',body:raw};
 assert.equal(raw.request.budget,undefined);
 assertJobReceipt({job:job(),replayed:true},'a',p,normalizeQualityJobInput(raw));
 assert.equal(JSON.stringify(raw),before);
 const changed=job();changed.input.request.roi.width-=2;
 assert.throws(()=>assertJobReceipt({job:changed,replayed:true},'a',p,normalizeQualityJobInput(raw)),/acknowledgement/);
});
test('a validator error after HTTP success cannot mark or discard an unknown operation',async()=>{
 const journal=new FrozenSubmissionJournal(memory(),a=>a,v=>v,undefined,()=> 'key'),p=journal.freeze('a',{n:1});
 await assert.rejects(journal.execute('a',p.key,async()=>({}),()=>{throw new ApiError(400,'Malformed successful receipt');},false,'mark'));
 assert.equal(journal.pending('a')?.key,p.key);assert.equal(journal.pending('a')?.rejected,undefined);
});
test('replacing one read slot preserves unrelated actor and selection reads',async()=>{
 const scope=new QualityObservationScope(),gate=deferred<void>();let history,detail,frames;
 const a=scope.run('history','actor',async()=>{history=scope.capture('actor','history');await gate.promise;});
 const b=scope.run('detail','selection',async()=>{detail=scope.capture('selection','detail');await gate.promise;});
 const c=scope.run('frames','selection',async()=>{frames=scope.capture('selection','frames');await gate.promise;});
 scope.cancel('frames');assert.equal(frames!.current(),false);assert.equal(detail!.current(),true);assert.equal(history!.current(),true);
 gate.resolve();await Promise.all([a,b,c]);scope.close();
});


test('malformed persisted submission is retained and cannot be overwritten or sent under a new key',async()=>{
 const storage=memory(),raw='{incomplete';storage.setItem('a',raw);
 const journal=new FrozenSubmissionJournal(storage,a=>a,v=>v);let sent=0;
 assert.throws(()=>journal.freeze('a',{n:2}));
 await assert.rejects(journal.execute('a','old-key',async()=>{sent++;return {};},()=>{}));
 assert.equal(sent,0);assert.equal(storage.getItem('a'),raw);
});

test('relation/plan receipts bind normalized full inputs, original actor/key and the correct envelope',async()=>{
 const {correspondenceFixture}=await import('../helpers/correspondence-fixture.ts');
 const {normalizeCorrespondenceInput}=await import('../../shared/analysis/quality/correspondence.ts');
 const f=await correspondenceFixture(),pending={key:'plan-key',body:f.request};
 const receipt={replayed:false,plan:{id:'plan',actor:{id:'owner'},key:pending.key,input:normalizeCorrespondenceInput(f.request)}};
 assert.doesNotThrow(()=>assertJobReceipt(receipt,'owner',pending,normalizeCorrespondenceInput(pending.body),'plan'));
 for(const mutate of [
  (r:any)=>delete r.replayed,(r:any)=>{r.plan.actor.id='other';},(r:any)=>{r.plan.key='different';},
  (r:any)=>{r.plan.input.recipe.roi.width=64;},(r:any)=>{r.plan.input.relation.id='different';},
  (r:any)=>{r.plan.input.referenceBuildId='other';},(r:any)=>{r.plan.input.planningBudget.maxElapsedMs=1;},
 ]){const invalid=structuredClone(receipt);mutate(invalid);assert.throws(()=>assertJobReceipt(invalid,'owner',pending,normalizeCorrespondenceInput(pending.body),'plan'),/acknowledgement/);}
 assert.throws(()=>assertJobReceipt({replayed:false,job:receipt.plan},'owner',pending,normalizeCorrespondenceInput(pending.body),'plan'));
 assert.doesNotThrow(()=>assertJobReceipt({replayed:true,relation:f.relation},'owner',{key:f.relation.key,body:f.relation.input},f.relation.input,'relation'));
 assert.equal(pending.body.recipe.budget?.maxPackets,undefined,'validating defaulted receipt must not rewrite the original wire body');
});

test('correspondence acknowledgement requires a complete durable plan/relation before confirming a frozen key',async()=>{
 const {assertCorrespondenceReceipt}=await import('../../src/services/correspondence-receipt.ts');
 const {correspondenceFixture}=await import('../helpers/correspondence-fixture.ts');
 const {normalizeCorrespondenceInput}=await import('../../shared/analysis/quality/correspondence.ts');
 const f=await correspondenceFixture(),pending={key:'plan-key',body:f.request};
 const plan={id:'22222222-2222-4222-8222-222222222222',actor:f.relation.actor,key:pending.key,requestId:'request',revision:1,createdAt:1,startedAt:null,endedAt:null,attemptId:null,state:'queued',reason:null,resultDigest:null,relation:f.relation,input:normalizeCorrespondenceInput(f.request)};
 assert.doesNotThrow(()=>assertCorrespondenceReceipt({plan,replayed:false},'owner',pending,'plan'));
 for(const field of ['id','actor','key','requestId','revision','createdAt','startedAt','endedAt','attemptId','state','reason','resultDigest','relation','input']){
  const invalid:any=structuredClone(plan);delete invalid[field];assert.throws(()=>assertCorrespondenceReceipt({plan:invalid,replayed:true},'owner',pending,'plan'),field);
 }
 const wrong=structuredClone(plan);wrong.relation.id='33333333-3333-4333-8333-333333333333';assert.throws(()=>assertCorrespondenceReceipt({plan:wrong,replayed:false},'owner',pending,'plan'));
 assert.doesNotThrow(()=>assertCorrespondenceReceipt({relation:f.relation,replayed:true},'owner',{key:f.relation.key,body:f.relation.input},'relation'));
 const incomplete:any=structuredClone(f.relation);delete incomplete.assessment;assert.throws(()=>assertCorrespondenceReceipt({relation:incomplete,replayed:false},'owner',{key:f.relation.key,body:f.relation.input},'relation'));
});

test('observation coalesces the same page but a different cursor supersedes its old publication',async()=>{
 const scope=new QualityObservationScope(),gate=deferred<void>(),published:number[]=[];let oldSignal:AbortSignal|undefined;
 const first=scope.run('history','actor',async()=>{const c=scope.capture('actor','history');oldSignal=c.signal;await gate.promise;if(c.current())published.push(0);},'first:0');
 assert.equal(scope.run('history','actor',async()=>assert.fail('same page must share its request'),'first:0'),first);
 const next=scope.run('history','actor',async()=>{const c=scope.capture('actor','history');if(c.current())published.push(2);},'more:2');
 try{assert.equal(oldSignal!.aborted,true,'a different pagination intent cannot reuse the first-page request');}finally{gate.resolve();}
 await Promise.all([first,next]);assert.deepEqual(published,[2]);scope.close();
});
