import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {openIndexDatabase} from '../../server/sqlite.ts';
import {AnnotationStore} from '../../server/annotations.ts';
import {loadConfig} from '../../server/config.ts';
import {startService} from '../../server/runtime.ts';
import {encodedPair} from '../helpers/library-pair-fixture.ts';
import {compressWorkspace,readWorkspaceFile,parseWorkspace} from '../../shared/review/workspace-file.ts';
import {annotationWorkspace} from '../../shared/review/annotation-record.ts';
import {evidenceApplies} from '../../shared/review/quality-evidence.ts';
import type {QualityJob} from '../../shared/analysis/quality/jobs.ts';
import type {AnnotationDocument,AnnotationOperation,AnnotationRecord} from '../../shared/review/annotation-record.ts';
import type {PairTarget} from '../../shared/analysis/quality/frame-pair.ts';

for(const [codec,depth]of [['h264',8],['hevc',8],['hevc',10]]as const)test(`annotation evidence real HTTP ${codec}/${depth}: immutable sharing, binding and restart`,{timeout:90000},async t=>{
 const dir=await mkdtemp(join(tmpdir(),'vp-annotation-quality-')),media=join(dir,'media');let service:Awaited<ReturnType<typeof startService>>|undefined;
 t.after(async()=>{await service?.close();await rm(dir,{recursive:true,force:true});});
 await mkdir(media);const fixture=await encodedPair(dir,codec,depth);await writeFile(join(media,'sample.flv'),fixture.bytes);
 const config=await loadConfig([], 'production', dir,{staticDir:resolve('public'),dataDir:join(dir,'data'),logsDir:join(dir,'logs'),allowEmptyRoots:true});
 config.mediaRoots=[media];config.logsDir=null;config.indexWatch=false;config.port=0;
 service=await startService(config,false);await service.library.refresh();
 const base=`http://127.0.0.1:${(service.server.address()as any).port}`;config.port=(service.server.address()as any).port;
 const actor={id:`guest-${randomUUID()}`,name:'访客'},cookie=`voidplayer-user=${actor.id}`,other=`voidplayer-user=guest-${randomUUID()}`;
 const headers={cookie,origin:base,'content-type':'application/json','x-voidplayer-action':'annotation'};
 let entry:any;for(let n=0;n<100;n++){entry=(await fetch(base+'/api/library').then(r=>r.json())).entries.find((e:any)=>e.state==='ready');if(entry)break;await new Promise(r=>setTimeout(r,25));}assert.ok(entry);
 const cacheResponse=await fetch(`${base}/api/media/${entry.id}/frame-index?v=${entry.version}&build=1`);assert.equal(cacheResponse.status,200);const cache=await cacheResponse.json();
 const proof=await fetch(`${base}/api/media/${entry.id}/psnr-source?v=${entry.version}`,{headers:{cookie}}).then(r=>r.json());
 const target=(au:number):PairTarget=>({...proof.binding,sourcePtsUs:cache.index.packets[au][2],picture:{sourceVersion:`${entry.id}@${entry.version}`,stream:'video',configuration:0,au,picture:0,layer:0,field:'frame'}});
 const input={schema:'voidplayer-psnr-frame-job',version:1,client:{id:'private-client',kind:'agent'},request:{pairing:'caller-specified',reference:target(0),distorted:target(1),roi:{x:2,y:4,width:24,height:20},spatial:{blockWidth:10,blockHeight:8}}};
 const submitted=await fetch(base+'/api/quality/jobs',{method:'POST',headers:{...headers,'x-voidplayer-action':'quality-job','idempotency-key':'private-secret-key'},body:JSON.stringify(input)});assert.equal(submitted.status,202);const accepted=await submitted.json();let job:QualityJob=accepted.job;
 for(let n=0;n<300&&!['completed','failed','cancelled','interrupted'].includes(job.state);n++){await new Promise(r=>setTimeout(r,20));job=await fetch(`${base}/api/quality/jobs/${job.id}`,{headers:{cookie}}).then(r=>r.json());}assert.equal(job.state,'completed',JSON.stringify(job));
 const original=await fetch(base+job.result.url,{headers:{cookie}}).then(r=>r.json());
 const document:AnnotationDocument={media:[{id:'snapshot',name:'sample.flv',size:entry.size,lastModified:entry.lastModified,codec,decoder:'ffmpeg-wasm',width:32,height:32,durationUs:2000000,firstPtsUs:target(0).sourcePtsUs,source:{kind:'library',id:entry.id,url:`${base}/api/media/${entry.id}?v=${entry.version}`}}],
   mark:{id:'mark',text:'Existing observation',severity:3,origin:'agent',createdAt:'2026-10-24',slot:'H',mediaId:'snapshot',frame:{ptsUs:0,sourcePtsUs:target(0).sourcePtsUs,durationUs:1000000},comparison:[],region:{left:2/32,top:4/32,width:24/32,height:20/32}}};
 const post=async(op:AnnotationOperation,status=200,custom:Record<string,string>=headers)=>{const response=await fetch(base+'/api/annotations/spaces/default',{method:'POST',headers:custom,body:JSON.stringify(op)});const result=await response.json();assert.equal(response.status,status,JSON.stringify(result));return result as AnnotationRecord;};
 const candidateOp:AnnotationOperation={id:'candidate',operationId:'create-candidate',revision:0,action:'create-quality-candidate',client:{kind:'agent',id:'candidate-agent'},candidate:{text:'Explicit measured observation; not a subjective defect judgment',severity:3},evidence:{jobId:job.id,attemptId:job.attempt!.id,digest:job.result.digest!,side:'distorted'}};
 assert.equal((await post(candidateOp,404,{...headers,cookie:other})as any).code,'job-not-found');assert.equal((await fetch(base+'/api/annotations/spaces/default/candidate')).status,404);
 assert.equal((await post(candidateOp,409,{...headers,cookie:other,'x-voidplayer-actor':actor.id})as any).code,'actor-changed');
 const simultaneous=await Promise.all([post(candidateOp),post(candidateOp)]);assert.deepEqual(simultaneous[0],simultaneous[1]);const candidate=simultaneous[0];assert.equal(candidate.revision,1);
 assert.equal(candidate.document.mark.qualityCandidate?.assessment,'not-subjectively-assessed');assert.equal(candidate.document.mark.origin,'agent');assert.equal(candidate.document.mark.resolved,false);
 assert.equal(candidate.document.mark.frame.sourcePtsUs,target(1).sourcePtsUs);assert.equal(candidate.document.mark.frame.ptsUs,target(1).sourcePtsUs-target(0).sourcePtsUs);
 assert.equal(candidate.document.mark.qualityEvidence![0].verification,'server-verified');assert.equal(evidenceApplies(candidate.document,candidate.document.mark.qualityEvidence![0]),true);
 assert.deepEqual(candidate.document.mark.region,document.mark.region);assert.ok(!JSON.stringify(candidate).includes('private-client'));assert.ok(!JSON.stringify(candidate).includes('private-secret-key'));
 assert.equal((await post({...candidateOp,candidate:{...candidateOp.candidate!,text:'Changed intent'}},409)as any).code,'operation-id-reused');
 await post({...candidateOp,id:'forged-candidate',operationId:'forged-candidate',document},400);
 const candidateBackup=annotationWorkspace([candidate.document],base);assert.equal(candidateBackup.version,3);assert.equal(candidateBackup.marks[0].qualityCandidate?.assessment,'not-subjectively-assessed');assert.equal(candidateBackup.marks[0].qualityEvidence![0].verification,'historical');
 assert.deepEqual(await readWorkspaceFile(await compressWorkspace(candidateBackup),base),parseWorkspace(candidateBackup));assert.deepEqual(await readWorkspaceFile(new Blob([JSON.stringify(candidateBackup)]),base),parseWorkspace(candidateBackup));assert.throws(()=>parseWorkspace({...candidateBackup,version:2}));
 const oldEdit=structuredClone(candidate.document);delete oldEdit.mark.qualityCandidate;delete oldEdit.mark.qualityEvidence;oldEdit.mark.text='Text edited by an older client';const edited=await post({id:'candidate',operationId:'candidate-edit',revision:1,action:'put',document:oldEdit});assert.deepEqual(edited.document.mark.qualityCandidate,candidate.document.mark.qualityCandidate);assert.deepEqual(edited.document.mark.qualityEvidence,candidate.document.mark.qualityEvidence);
 const regionEdit=structuredClone(edited.document);regionEdit.mark.region={left:0,top:0,width:1,height:1};regionEdit.mark.replies=[{id:'candidate-reply',text:'Human follow-up',createdAt:new Date().toISOString(),author:{id:actor.id,name:actor.name}}];const regionEdited=await post({id:'candidate',operationId:'candidate-region-reply',revision:2,action:'put',document:regionEdit});assert.deepEqual(regionEdited.document.mark.qualityCandidate,candidate.document.mark.qualityCandidate);assert.deepEqual(regionEdited.document.mark.qualityEvidence,candidate.document.mark.qualityEvidence);assert.equal(evidenceApplies(regionEdited.document,regionEdited.document.mark.qualityEvidence![0]),false);
 const forgedCandidate=structuredClone(regionEdited.document);(forgedCandidate.mark.qualityCandidate as any).assessment='certified-defect';await post({id:'candidate',operationId:'forge-candidate-assessment',revision:3,action:'put',document:forgedCandidate},400);
 const historicalCandidate=structuredClone(candidate.document);historicalCandidate.mark.id='candidate-copy';const candidateCopy=await post({id:'candidate-copy',operationId:'candidate-copy',revision:0,action:'put',document:historicalCandidate});assert.equal(candidateCopy.document.mark.qualityEvidence![0].verification,'historical');assert.equal(candidateCopy.document.mark.qualityCandidate?.assessment,'not-subjectively-assessed');
 const atomicDb=openIndexDatabase(join(config.dataDir,'annotations.sqlite'));try{atomicDb.exec("CREATE TRIGGER fail_candidate_event BEFORE INSERT ON annotation_events WHEN json_extract(NEW.event,'$.operationId')='atomic-candidate' BEGIN SELECT RAISE(FAIL,'candidate rollback'); END;");await post({...candidateOp,id:'atomic-candidate',operationId:'atomic-candidate'},500);assert.equal(atomicDb.prepare("SELECT count(*) AS n FROM annotations WHERE id='atomic-candidate'").get()!.n,0);assert.equal(atomicDb.prepare("SELECT count(*) AS n FROM annotation_operations WHERE id='atomic-candidate'").get()!.n,0);}finally{atomicDb.exec('DROP TRIGGER fail_candidate_event');atomicDb.close();}
 assert.equal((await post({...candidateOp,id:'atomic-candidate',operationId:'atomic-candidate'})).revision,1);
 const replayStore=new AnnotationStore(join(config.dataDir,'annotations.sqlite'));try{assert.deepEqual(replayStore.mutate('default',candidateOp,actor,'after-result-reclaimed'),candidate,'receipt replays after result resolver/source availability is gone');}finally{replayStore.close();}
 const create:AnnotationOperation={operationId:'create',id:'mark',revision:0,action:'put',document};let record=await post(create);
 const attach:AnnotationOperation={operationId:'attach',id:'mark',revision:1,action:'attach-quality-result',client:{kind:'agent'},evidence:{jobId:job.id,attemptId:job.attempt!.id,digest:job.result.digest!,side:'reference'}};
 // A different actor gets the same 404 for a private job as a nonexistent one.
 const foreign=await post({...attach,operationId:'foreign'},404,{...headers,cookie:other});assert.equal((foreign as any).code,'job-not-found');
 for(const [field,value]of [['attemptId','wrong'],['digest','0'.repeat(64)]]as const)assert.equal((await post({...attach,operationId:field,evidence:{...attach.evidence!,[field]:value}},409)as any).code,'evidence-unavailable');
 for(const [name,change]of [['pts',(d:AnnotationDocument)=>d.mark.frame.sourcePtsUs++],['version',(d:AnnotationDocument)=>d.media[0].source!.url=`${base}/api/media/${entry.id}?v=${'0'.repeat(24)}`],['origin',(d:AnnotationDocument)=>d.media[0].source!.url=d.media[0].source!.url.replace(base,'http://foreign.invalid')],['roi',(d:AnnotationDocument)=>d.mark.region!.left=0]]as const){
  const changed=structuredClone(document);changed.mark.id=name;change(changed);await post({...create,operationId:'create-'+name,id:name,document:changed});
  assert.equal((await post({...attach,operationId:'attach-'+name,id:name},409)as any).code,'evidence-anchor-conflict');
 }
 assert.equal((await post({...attach,operationId:'wrong-side',evidence:{...attach.evidence!,side:'distorted'}},409)as any).code,'evidence-anchor-conflict');
 const distortedDoc=structuredClone(document);distortedDoc.mark.id='distorted';distortedDoc.mark.frame.ptsUs=1000000;distortedDoc.mark.frame.sourcePtsUs=target(1).sourcePtsUs;await post({...create,operationId:'create-distorted',id:'distorted',document:distortedDoc});
 const distortedAttachment=await post({...attach,id:'distorted',operationId:'attach-distorted',evidence:{...attach.evidence!,side:'distorted'}});assert.equal(distortedAttachment.document.mark.qualityEvidence![0].ref.side,'distorted');
 record=await post(attach);const evidence=record.document.mark.qualityEvidence![0];
 let expectedSse=0;const sampleBytes=depth===8?1:2,frameBytes=1536*sampleBytes,raw=new DataView(fixture.native.buffer,fixture.native.byteOffset,fixture.native.byteLength);
 for(const [plane,offset]of [0,1024,1280].entries()){const scale=plane?2:1,width=plane?16:32;for(let y=4/scale;y<24/scale;y++)for(let x=2/scale;x<26/scale;x++){const at=(offset+y*width+x)*sampleBytes;const read=(n:number)=>sampleBytes===1?raw.getUint8(n):raw.getUint16(n,true);expectedSse+=(read(at)-read(frameBytes+at))**2;}}
 assert.equal(evidence.value.result.metric.aggregate.sse,expectedSse,'shared snapshot keeps exact independently summed native plane SSE');
 assert.equal(evidence.value.result.metric.spatial!.blocks.length,9);assert.equal(evidence.value.result.metric.spatial!.blocks.reduce((n,b)=>n+b.aggregate.sse,0),expectedSse);
 assert.equal(evidence.verification,'server-verified');assert.equal(evidence.ref.digest,job.result.digest);assert.deepEqual(evidence.value,original.value);assert.equal(evidence.value.result.metric.bitDepth,depth);assert.ok(evidence.value.result.metric.aggregate.sse>0);assert.equal(evidenceApplies(record.document,evidence),true);
 assert.ok(!JSON.stringify(record).includes('private-secret-key'));assert.ok(!JSON.stringify(record).includes('private-client'));
 const shared=await fetch(base+'/api/annotations/spaces/default/mark',{headers:{cookie:other}}).then(r=>r.json());assert.deepEqual(shared,record);assert.equal((await fetch(base+job.result.url,{headers:{cookie:other}})).status,404);
 assert.deepEqual(await post(attach),record,'lost response replay has one attachment/event');
 const receipts=new AnnotationStore(join(config.dataDir,'annotations.sqlite'));try { assert.deepEqual(receipts.mutate('default',attach,actor,'after-result-unavailable'),record,'receipt precedes resolver availability and current revision'); } finally { receipts.close(); }
 const forged=structuredClone(record.document);forged.mark.qualityEvidence![0].value.result.metric.aggregate.sse++;
 // A legacy-shaped value may pass the old scalar structural validator, but
 // cannot strip the grid or replace the already committed immutable facts.
 delete forged.mark.qualityEvidence![0].value.result.metric.spatial;
 assert.equal((await post({operationId:'forge',id:'mark',revision:2,action:'put',document:forged},409)as any).code,'evidence-immutable');
 const stripped=structuredClone(record.document);delete stripped.mark.qualityEvidence![0].value.result.metric.spatial;
 assert.equal((await post({operationId:'strip-grid',id:'mark',revision:2,action:'put',document:stripped},409)as any).code,'evidence-immutable');
 const forgedGrid=structuredClone(record.document);forgedGrid.mark.qualityEvidence![0].value.result.metric.spatial!.blocks[0].roi.x+=2;
 await post({operationId:'forge-grid',id:'mark',revision:2,action:'put',document:forgedGrid},400);
 const budgetDoc=structuredClone(document);budgetDoc.mark.id='budget';await post({...create,operationId:'create-budget',id:'budget',document:budgetDoc});
 for(let n=0;n<4;n++)await post({...attach,operationId:'budget-'+n,id:'budget',revision:n+1});
 assert.equal((await post({...attach,operationId:'budget-overflow',id:'budget',revision:5},413)as any).code,'evidence-limit');
 if(codec==='h264'){
  const larger={...input,request:{...input.request,spatial:{blockWidth:4,blockHeight:2}}};
  const submission=await fetch(base+'/api/quality/jobs',{method:'POST',headers:{...headers,'x-voidplayer-action':'quality-job','idempotency-key':'grid-byte-budget'},body:JSON.stringify(larger)});assert.equal(submission.status,202);let gridJob=(await submission.json()).job;
  for(let n=0;n<300&&!['completed','failed'].includes(gridJob.state);n++){await new Promise(r=>setTimeout(r,20));gridJob=await fetch(`${base}/api/quality/jobs/${gridJob.id}`,{headers:{cookie}}).then(r=>r.json());}assert.equal(gridJob.state,'completed');
  const gridDoc=structuredClone(document);gridDoc.mark.id='grid-bytes';await post({...create,operationId:'grid-bytes-create',id:'grid-bytes',document:gridDoc});let revision=1,rejected=false;
  for(let n=0;n<5;n++){const op={...attach,id:'grid-bytes',revision,operationId:'grid-bytes-'+n,evidence:{jobId:gridJob.id,attemptId:gridJob.attempt.id,digest:gridJob.result.digest,side:'reference'}};
   const response=await fetch(base+'/api/annotations/spaces/default',{method:'POST',headers,body:JSON.stringify(op)}),value=await response.json();
   if(response.status===413){assert.equal(value.code,'evidence-limit');assert.ok(n>0&&n<=4);rejected=true;break;}
   assert.equal(response.status,200,JSON.stringify(value));assert.equal(value.document.mark.qualityEvidence.at(-1).value.result.metric.spatial.blocks.length,60);assert.ok(Buffer.byteLength(JSON.stringify(value.document.mark.qualityEvidence))<=128*1024);revision++;
  }
  assert.equal(rejected,true,'the existing 128 KiB/four-attachment budget still rejects overflow');
  const saved=await fetch(base+'/api/annotations/spaces/default/grid-bytes').then(r=>r.json());assert.equal(saved.revision,revision,'budget rejection does not mutate the annotation');
  const oversized=structuredClone(saved.document);Object.assign(oversized.mark.qualityEvidence[0].value,{untrustedPadding:'x'.repeat(128*1024)});
  assert.ok(Buffer.byteLength(JSON.stringify(oversized.mark.qualityEvidence))>128*1024);
  const rejectedImport=await post({id:'grid-bytes',revision,operationId:'oversized-grid-import',action:'put',document:oversized},400);assert.equal((rejectedImport as any).code,'invalid-annotation-document');
  assert.deepEqual(await fetch(base+'/api/annotations/spaces/default/grid-bytes').then(r=>r.json()),saved,'oversized imported facts leave the committed grid unchanged');
 }
 const raceDoc=structuredClone(document);raceDoc.mark.id='race';await post({...create,operationId:'create-race',id:'race',document:raceDoc});
 const races=await Promise.all(['one','two'].map(operationId=>fetch(base+'/api/annotations/spaces/default',{method:'POST',headers,body:JSON.stringify({...attach,id:'race',operationId})})));
 assert.deepEqual(races.map(r=>r.status).sort(),[200,409],'concurrent attachment intents never overwrite a committed revision');
 const rollbackDoc=structuredClone(document);rollbackDoc.mark.id='rollback';await post({...create,operationId:'create-rollback',id:'rollback',document:rollbackDoc});
 const trigger=openIndexDatabase(join(config.dataDir,'annotations.sqlite'));
 try { trigger.exec("CREATE TRIGGER reject_attachment_event BEFORE INSERT ON annotation_events WHEN json_extract(NEW.event,'$.operationId')='rollback-evidence' BEGIN SELECT RAISE(FAIL,'evidence test rollback'); END;");
  await post({...attach,operationId:'rollback-evidence',id:'rollback'},500);
  const unchanged=await fetch(base+'/api/annotations/spaces/default/rollback').then(r=>r.json());assert.equal(unchanged.revision,1);assert.equal(unchanged.document.mark.qualityEvidence,undefined);
  assert.equal(trigger.prepare("SELECT count(*) AS n FROM annotation_operations WHERE id='rollback-evidence'").get()!.n,0);
 } finally { trigger.exec('DROP TRIGGER reject_attachment_event');trigger.close(); }
 assert.equal((await post({...attach,operationId:'rollback-evidence',id:'rollback'})).revision,2,'failed event commit leaves no receipt or attachment');
 const edit=structuredClone(record.document);delete edit.mark.qualityEvidence;edit.mark.text='Ordinary text edit by old client';edit.mark.replies=[{id:'reply',text:'Reply',author:actor,createdAt:'old'}];edit.mark.region={left:0,top:0,width:.5,height:.5};
 record=await post({operationId:'edit',id:'mark',revision:2,action:'put',document:edit});assert.deepEqual(record.document.mark.qualityEvidence,[evidence]);assert.equal(evidenceApplies(record.document,evidence),false,'region edit retains immutable facts and changes applicability');
 const backup=annotationWorkspace([record.document],base);assert.equal(backup.version,2);assert.equal(backup.marks[0].qualityEvidence![0].verification,'historical');
 assert.deepEqual(backup.marks[0].qualityEvidence![0].value.result.metric.spatial,evidence.value.result.metric.spatial);
 const imported=parseWorkspace({...backup,marks:[{...record.document.mark,mediaId:backup.media[0].id}]});assert.equal(imported.marks[0].qualityEvidence![0].verification,'historical');
 assert.deepEqual(await readWorkspaceFile(await compressWorkspace(backup),base),parseWorkspace(backup));
 assert.deepEqual(await readWorkspaceFile(new Blob([JSON.stringify(backup)]),base),parseWorkspace(backup));
 assert.throws(()=>parseWorkspace({...backup,version:1}),/version 2/);assert.throws(()=>parseWorkspace({...backup,version:3}),/版本/);
 const copy=structuredClone(record.document);copy.mark.id='copy';const copied=await post({...create,operationId:'copy',id:'copy',document:copy});assert.equal(copied.document.mark.qualityEvidence![0].verification,'historical','generic create cannot mint verification');
 assert.equal((await post({...attach,operationId:'after-roi-edit',revision:record.revision},409)as any).code,'evidence-anchor-conflict');
 const events=await fetch(base+'/api/annotations/events/default').then(r=>r.json());assert.equal(events.events.filter((e:any)=>e.action==='attach-quality-result'&&e.id==='mark').length,1);
 const before=await fetch(base+'/api/annotations/spaces/default/mark').then(r=>r.json());await service.close();service=await startService(config,false);
 assert.deepEqual(await fetch(base+'/api/annotations/spaces/default/mark').then(r=>r.json()),before);
 assert.deepEqual(await post(attach),shared,'restart preserves original receipt even after later text/ROI edits');
 if(codec==='h264') {
  service.library.frameIndexes.remove();
  const failedResponse=await fetch(base+'/api/quality/jobs',{method:'POST',headers:{...headers,'x-voidplayer-action':'quality-job','idempotency-key':'expected-failed-job'},body:JSON.stringify(input)});assert.equal(failedResponse.status,202);let failed=(await failedResponse.json()).job;
  for(let n=0;n<200&&!['failed','completed','interrupted','cancelled'].includes(failed.state);n++){await new Promise(r=>setTimeout(r,20));failed=await fetch(`${base}/api/quality/jobs/${failed.id}`,{headers:{cookie}}).then(r=>r.json());}assert.equal(failed.state,'failed');assert.equal(failed.reason.code,'cache-miss');
  assert.equal((await post({...attach,operationId:'reject-failed',id:'pts',evidence:{jobId:failed.id,attemptId:failed.attempt.id,digest:'0'.repeat(64),side:'reference'}},409)as any).code,'evidence-unavailable');
  const changed=Buffer.from(fixture.bytes);changed[changed.length-5]^=1;await writeFile(join(media,'sample.flv'),changed);
  assert.deepEqual(await fetch(base+'/api/annotations/spaces/default/mark').then(r=>r.json()),before,'source/cache change cannot rewrite shared historical facts');
 }
 // Simulated retention cleanup: receipts and explicitly shared facts outlive the private result.
 const history=openIndexDatabase(join(config.dataDir,'library.sqlite.quality.sqlite'));
 try {history.prepare('UPDATE quality_jobs SET result_json=NULL,result_sha=NULL WHERE id=?').run(job.id);}finally{history.close();}
 assert.equal((await fetch(base+job.result.url,{headers:{cookie}})).status,409);
 assert.deepEqual(await post(attach),shared,'receipt replay never depends on an evicted result');
 assert.deepEqual(await post(candidateOp),candidate,'candidate HTTP receipt survives actual result reclamation and service restart');
 assert.equal((await post({...candidateOp,id:'late-candidate',operationId:'late-candidate'},409)as any).code,'evidence-unavailable');
 assert.equal((await fetch(base+'/api/annotations/spaces/default/late-candidate')).status,404);
 const candidateEvents=await fetch(base+'/api/annotations/events/default').then(r=>r.json());assert.equal(candidateEvents.events.filter((e:any)=>e.id==='candidate'&&e.action==='create-quality-candidate').length,1);
 assert.deepEqual(await fetch(base+'/api/annotations/spaces/default/mark').then(r=>r.json()),before);

 t.diagnostic(JSON.stringify({codec,depth,sse:evidence.value.result.metric.aggregate.sse,job:job.id,attachment:evidence.id}));
});
