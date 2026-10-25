// @ts-ignore test readiness adapter
import {waitForAnnotationMedia} from '../../scripts/testing/agent-annotations-ready.mjs';
// @ts-ignore independent BigInt SSIM oracle
import {ssimOracle} from '../helpers/ssim-oracle.mjs';
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';import {pathToFileURL} from 'node:url';import {createHash,randomUUID} from 'node:crypto';
import {Worker} from 'node:worker_threads';
import {FramePairClient} from '../../src/analysis/quality/pair-client.ts';import type {PairWorker} from '../../src/analysis/quality/pair-client.ts';
import {preparedPair,pairRequest} from '../helpers/frame-pair-fixture.ts';
import {encodedForwardFixture} from '../helpers/forward-pair-fixture.ts';
import {SSIM_VARIANT} from '../../shared/analysis/quality/ssim.ts';
import {qualityEvidenceValue} from '../../shared/review/quality-evidence.ts';
import {loadConfig} from '../../server/config.ts';import {startService} from '../../server/runtime.ts';
import type {QualityJobInput} from '../../shared/analysis/quality/jobs.ts';
import type {AddressInfo} from 'node:net';
const baseFile=pathToFileURL(resolve('public/index.html')).href;
function client(){return new FramePairClient(()=>{const w=new Worker(new URL('../helpers/frame-pair-worker.ts',import.meta.url));let exited=false;
 const a:PairWorker={onmessage:null,onerror:null,onmessageerror:null,postMessage:data=>w.postMessage(data),async terminate(){await w.terminate();assert.equal(exited,true,'physical exit precedes permit release');}};
 w.on('message',data=>a.onmessage?.({data}as MessageEvent));w.on('error',error=>a.onerror?.({message:String(error)}as ErrorEvent));w.on('exit',()=>{exited=true;});return a;});}
const samples=JSON.parse(await readFile(new URL('../helpers/quality-forward-samples.json',import.meta.url),'utf8')).samples;
const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
for(const [codec,depth]of [['h264',8],['hevc',10]]as const){
 test(`forward ${codec} ${depth}: every ordinary AU has exact native planes/PTS and bounded dependency provenance`,{timeout:90000},async()=>{
  const sample=samples.find((s:any)=>s.codec===codec&&s.depth===depth),bytes=Buffer.from(sample.flv,'base64'),native=Buffer.from(sample.allNative,'base64'),frameBytes=1536*(depth===8?1:2);
  assert.equal(sha(bytes),sample.flvSha256);assert.equal(sha(native),sample.allNativeSha256);
  const left=await preparedPair(bytes),owner=client();
  for(let au=1;au<8;au++){
   const right=await preparedPair(bytes,'d'.repeat(24),au);right.target.decode={mode:'forward-one-output-per-au-v1',startAu:0};
   const req=pairRequest(left.target,right.target);req.roi={x:0,y:0,width:32,height:32};req.ssim={variant:SSIM_VARIANT};req.spatial={blockWidth:16,blockHeight:16};
   const result=await owner.measure(req,[left.source,right.source],baseFile,new AbortController().signal);
   let expected=0n;const a=native.subarray(0,frameBytes),b=native.subarray(au*frameBytes,(au+1)*frameBytes);
   for(let at=0;at<frameBytes;at+=depth===8?1:2){const d=BigInt(depth===8?a[at]-b[at]:a.readUInt16LE(at)-b.readUInt16LE(at));expected+=d*d;}
   assert.equal(result.metric.aggregate.sse,Number(expected));const oracle=ssimOracle(a,b,depth,32,32,req.roi);assert.ok(Math.abs(result.ssim!.aggregate.score-oracle.all)<1e-12);
   assert.equal(result.provenance.distorted.sourcePtsUs,2000000+au*100000);assert.equal(result.provenance.distorted.picture.au,au);
   assert.deepEqual(result.provenance.distorted.dependency!.packets.map(p=>p.au),Array.from({length:au+1},(_,i)=>i));
   assert.equal(result.work.packets,au+2);assert.equal(result.work.outputFrames,au+2);assert.equal(result.decoder.packetIdentity,'forward-one-output-per-au-v1');
   assert.equal(result.metric.spatial!.blocks.reduce((n,b)=>n+b.aggregate.sse,0),Number(expected));
  }
 });
 test(`forward ${codec} ${depth}: live FFmpeg HTTP durable candidate→score→immutable evidence and restart`,{timeout:90000},async t=>{
  const dir=await mkdtemp(join(tmpdir(),'vp-forward-http-')),media=join(dir,'media');let service:Awaited<ReturnType<typeof startService>>|undefined;
  t.after(async()=>{await service?.close();await rm(dir,{recursive:true,force:true});});await mkdir(media);
  const sample=samples.find((s:any)=>s.codec===codec&&s.depth===depth);
  const f=process.versions.bun?{bytes:Buffer.from(sample.flv,'base64'),native:Buffer.from(sample.allNative,'base64')}:await encodedForwardFixture(dir,codec,depth);
  await writeFile(join(media,'dependent.flv'),f.bytes);
  const config=await loadConfig([],'production',dir,{staticDir:resolve('public'),dataDir:join(dir,'data'),logsDir:join(dir,'logs'),allowEmptyRoots:true});config.mediaRoots=[media];config.logsDir=null;config.indexWatch=false;config.port=0;
  const start=async()=>{service=await startService(config,false);await service.library.refresh();return `http://127.0.0.1:${(service.server.address()as AddressInfo).port}`;};let base=await start();
  const cookie=`voidplayer-user=guest-${randomUUID()}`,headers={cookie,origin:base,'content-type':'application/json','x-voidplayer-action':'quality-job'};
  const [entry]=await waitForAnnotationMedia(service!.library,['dependent.flv']);
  const missing=await fetch(`${base}/api/media/${entry.id}/psnr-frames?v=${entry.version}`,{headers});assert.notEqual(missing.status,200);
  assert.equal((await fetch(`${base}/api/media/${entry.id}/frame-index?v=${entry.version}&build=1`)).status,200);
  const page=await fetch(`${base}/api/media/${entry.id}/psnr-frames?v=${entry.version}`,{headers}).then(r=>r.json());assert.equal(page.entries.length,8);
  const reference=page.entries.find((p:any)=>p.picture.au===2),distorted=page.entries.find((p:any)=>p.picture.au===5);assert.ok(reference.decode&&distorted.decode);assert.deepEqual(reference.decode,{mode:'forward-one-output-per-au-v1',startAu:0});
  const input:QualityJobInput={schema:'voidplayer-psnr-frame-job',version:1,client:{id:'forward-http',kind:'agent'},request:{pairing:'caller-specified',reference,distorted,roi:{x:0,y:0,width:32,height:32},spatial:{blockWidth:16,blockHeight:16},ssim:{variant:SSIM_VARIANT}}};
  const submit=await fetch(base+'/api/quality/jobs',{method:'POST',headers:{...headers,'idempotency-key':'exact-window'},body:JSON.stringify(input)});assert.equal(submit.status,202);let job=(await submit.json()).job;
  for(let n=0;n<300&&!['completed','failed','cancelled'].includes(job.state);n++){await new Promise(r=>setTimeout(r,25));job=await fetch(`${base}/api/quality/jobs/${job.id}`,{headers}).then(r=>r.json());}assert.equal(job.state,'completed',JSON.stringify(job));assert.equal(job.progress.decodedFrames,9);
  const stored=await fetch(`${base}/api/quality/jobs/${job.id}/result`,{headers}).then(r=>r.json());qualityEvidenceValue(stored.value);
  const frameBytes=1536*(depth===8?1:2),native=Buffer.concat([f.native.subarray(frameBytes*2,frameBytes*3),f.native.subarray(frameBytes*5,frameBytes*6)]);let sse=0n;
  for(let at=0;at<frameBytes;at+=depth===8?1:2){const d=BigInt(depth===8?native[at]-native[frameBytes+at]:native.readUInt16LE(at)-native.readUInt16LE(frameBytes+at));sse+=d*d;}
  assert.equal(stored.value.result.metric.aggregate.sse,Number(sse));assert.ok(sse>0n);assert.equal(stored.value.result.work.packets,9);
  const oracle=ssimOracle(native.subarray(0,frameBytes),native.subarray(frameBytes),depth,32,32,input.request.roi);assert.ok(Math.abs(stored.value.result.ssim.aggregate.score-oracle.all)<1e-12);
  const discovery=await fetch(base+'/api/agent',{headers}).then(r=>r.json());
  assert.deepEqual(discovery.qualityJobs.source.forward.guarantee,{pixels:'exact-decoder-output-of-verified-input-window',referenceIntegrity:'not-certified',concealmentDetection:'unavailable'});
  for(const side of ['reference','distorted']as const)assert.deepEqual(stored.value.result.provenance[side].dependency.guarantee,discovery.qualityJobs.source.forward.guarantee);
  let counterResult:any;
  if(codec==='h264'){
   // Fixed encoded bytes make the concealment counterexample independent of
   // the host's encoder version. Delete a complete intermediate reference AU.
   const intact=Buffer.from(sample.flv,'base64'),indexed=await preparedPair(intact),packet=indexed.source.index!.packets[1];
   const damaged=Buffer.concat([intact.subarray(0,packet[0]-16),intact.subarray(packet[0]+packet[1]+4)]);
   await writeFile(join(media,'counter-original.flv'),intact);await writeFile(join(media,'counter-missing.flv'),damaged);await service!.library.refresh();
   const counterEntries=await waitForAnnotationMedia(service!.library,['counter-original.flv','counter-missing.flv']),targets=[];
   for(const [name,au]of [['counter-original.flv',5],['counter-missing.flv',4]]as const){
    const entry=counterEntries.find((e:any)=>e.name===name);assert.ok(entry);
    assert.equal((await fetch(`${base}/api/media/${entry.id}/frame-index?v=${entry.version}&build=1`)).status,200);
    const candidates=await fetch(`${base}/api/media/${entry.id}/psnr-frames?v=${entry.version}`,{headers}).then(r=>r.json()),target=candidates.entries.find((p:any)=>p.picture.au===au);assert.ok(target?.decode);assert.equal(target.sourcePtsUs,2500000);targets.push(target);
   }
   const counter=await fetch(base+'/api/quality/jobs',{method:'POST',headers:{...headers,'idempotency-key':'missing-reference-is-not-certified'},body:JSON.stringify({...input,request:{...input.request,reference:targets[0],distorted:targets[1]}})});assert.equal(counter.status,202);let job=(await counter.json()).job;
   for(let n=0;n<300&&!['completed','failed'].includes(job.state);n++){await new Promise(r=>setTimeout(r,25));job=await fetch(`${base}/api/quality/jobs/${job.id}`,{headers}).then(r=>r.json());}
   assert.equal(job.state,'completed',JSON.stringify(job));counterResult=await fetch(`${base}/api/quality/jobs/${job.id}/result`,{headers}).then(r=>r.json());qualityEvidenceValue(counterResult.value);
   assert.ok(counterResult.value.result.metric.aggregate.sse>0,'a concealed output differs from the original undamaged stream');
   assert.equal(counterResult.value.result.provenance.distorted.dependency.guarantee.referenceIntegrity,'not-certified');assert.equal(counterResult.value.result.provenance.distorted.dependency.guarantee.concealmentDetection,'unavailable');
   t.diagnostic(JSON.stringify({counterexample:'missing-intermediate-reference-au',state:job.state,sse:counterResult.value.result.metric.aggregate.sse,guarantee:counterResult.value.result.provenance.distorted.dependency.guarantee}));
  }
  const modified=structuredClone(input);modified.request.reference.decode!.startAu=1;
  const collision=await fetch(base+'/api/quality/jobs',{method:'POST',headers:{...headers,'idempotency-key':'exact-window'},body:JSON.stringify(modified)});assert.equal(collision.status,409);
  for(const mutate of [(v:any)=>{v.result.provenance.reference.dependency.packets[1].au++;},(v:any)=>{v.result.provenance.reference.decode.startAu++;},(v:any)=>{v.result.work.outputFrames=2;},(v:any)=>{v.result.decoder.packetIdentity='isolated-closed-au-v1';},(v:any)=>{v.result.provenance.reference.dependency.guarantee.referenceIntegrity='certified';},(v:any)=>{delete v.result.provenance.reference.dependency.guarantee;}]){const bad=structuredClone(stored.value);mutate(bad);assert.throws(()=>qualityEvidenceValue(bad));}
  const ah={...headers,'x-voidplayer-action':'annotation'},document={media:[{id:'media',name:entry.name,size:entry.size,lastModified:entry.lastModified,codec,decoder:'ffmpeg-wasm',width:32,height:32,durationUs:800000,firstPtsUs:2000000,source:{kind:'library',id:entry.id,url:`${base}/api/media/${entry.id}?v=${entry.version}`}}],mark:{id:'forward-mark',text:'Existing ordinary-frame observation',severity:3,origin:'agent',createdAt:new Date().toISOString(),slot:'A',mediaId:'media',frame:{ptsUs:reference.sourcePtsUs-2000000,sourcePtsUs:reference.sourcePtsUs,durationUs:100000},comparison:[],region:null}};
  assert.equal((await fetch(base+'/api/annotations/spaces/default',{method:'POST',headers:ah,body:JSON.stringify({action:'put',id:'forward-mark',operationId:'create',revision:0,document})})).status,200);
  const attached=await fetch(base+'/api/annotations/spaces/default',{method:'POST',headers:ah,body:JSON.stringify({action:'attach-quality-result',id:'forward-mark',operationId:'attach',revision:1,evidence:{jobId:job.id,attemptId:job.attempt.id,digest:job.result.digest,side:'reference'}})});assert.equal(attached.status,200,await attached.clone().text());assert.deepEqual((await attached.json()).document.mark.qualityEvidence[0].value,stored.value);
  await service!.close();service=undefined;base=await start();headers.origin=base;
  assert.deepEqual(await fetch(`${base}/api/quality/jobs/${job.id}/result`,{headers}).then(r=>r.json()),stored);
  if(counterResult)assert.deepEqual(await fetch(`${base}/api/quality/jobs/${counterResult.jobId}/result`,{headers}).then(r=>r.json()),counterResult);
  const replay=await fetch(base+'/api/quality/jobs',{method:'POST',headers:{...headers,'idempotency-key':'exact-window'},body:JSON.stringify(input)});assert.equal(replay.status,200);assert.equal((await replay.json()).replayed,true);
 });
}

test('forward windows reject absent start, duplicate/wrong PTS, changed dependency tag and tight packet/output/read budgets',{timeout:30000},async()=>{
 const sample=samples[0],bytes=Buffer.from(sample.flv,'base64'),left=await preparedPair(bytes,'a'.repeat(24),2),right=await preparedPair(bytes,'d'.repeat(24),5);for(const side of [left,right])side.target.decode={mode:'forward-one-output-per-au-v1',startAu:0};
 for(const mutate of [(r:any)=>{r.reference.decode.startAu=1;},(r:any)=>{r.reference.sourcePtsUs++;},(r:any)=>{r.budget={maxPackets:8};},(r:any)=>{r.budget={maxOutputFrames:8};},(r:any)=>{r.budget={maxReadBytes:1};}]){const r=pairRequest(left.target,right.target);mutate(r);await assert.rejects(client().measure(r,[left.source,right.source],baseFile,new AbortController().signal));}
 const duplicate=structuredClone(left.source);duplicate.index!.packets[1][2]=duplicate.index!.packets[2][2];await assert.rejects(client().measure(pairRequest(left.target,right.target),[duplicate,right.source],baseFile,new AbortController().signal),/unique|duplicate/i);
 const changed=Buffer.from(bytes);changed[left.source.index!.packets[1][0]-1]^=1;const source={...left.source,file:new Blob([changed])};await assert.rejects(client().measure(pairRequest(left.target,right.target),[source,right.source],baseFile,new AbortController().signal),/tag identity/);
});

test('real B-frame streams are not offered as forward candidates or approximated',{timeout:90000},async t=>{
 const dir=await mkdtemp(join(tmpdir(),'vp-forward-b-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const {qualityFrameCandidates}=await import('../../shared/analysis/quality/selection.ts');
 for(const [codec,depth]of [['h264',8],['hevc',10]]as const){const f=await encodedForwardFixture(dir,codec,depth,{bframes:2}),p=await preparedPair(f.bytes);assert.ok(f.packets.some(p=>p.pts!==p.dts));
  const candidates=qualityFrameCandidates({binding:p.source.binding,producer:{}as any},p.source.index!,{afterAu:0,limit:50});assert.ok(candidates.entries.every(e=>!e.decode));
  const target=await preparedPair(f.bytes,'d'.repeat(24),2);target.target.decode={mode:'forward-one-output-per-au-v1',startAu:0};await assert.rejects(client().measure(pairRequest(p.target,target.target),[p.source,target.source],baseFile,new AbortController().signal),/zero-CTS|reordering/);
 }
});

test('forward window admits the exact 32-AU-per-side / 64-output boundary and rejects the next AU',{timeout:30000},async t=>{
 const dir=await mkdtemp(join(tmpdir(),'vp-forward-limit-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const f=await encodedForwardFixture(dir,'h264',8,{frames:34,keyint:60}),p=await preparedPair(f.bytes,'a'.repeat(24),31);p.target.decode={mode:'forward-one-output-per-au-v1',startAu:0};
 const request=pairRequest(p.target),result=await client().measure(request,[p.source,p.source],baseFile,new AbortController().signal);assert.equal(result.work.packets,64);assert.equal(result.work.outputFrames,64);assert.equal(result.metric.aggregate.sse,0);
 const over=await preparedPair(f.bytes,'d'.repeat(24),32);over.target.decode={mode:'forward-one-output-per-au-v1',startAu:0};assert.throws(()=>client().measure(pairRequest(p.target,over.target),[p.source,over.source],baseFile,new AbortController().signal),/32 AUs/);
});

test('cancel during actual forward native decoding waits for physical exit before readmission',{timeout:15000},async()=>{
 const sample=samples[0],source=await preparedPair(Buffer.from(sample.flv,'base64'),'a'.repeat(24),5);source.target.decode={mode:'forward-one-output-per-au-v1',startAu:0};
 let entered!:()=>void;const started=new Promise<void>(r=>entered=r),gate=new SharedArrayBuffer(4);let exits=0;
 const owner=new FramePairClient(()=>{const w=new Worker(new URL('../helpers/forward-cancel-worker.ts',import.meta.url),{workerData:{gate}});let exited=false;
  const a:PairWorker={onmessage:null,onerror:null,onmessageerror:null,postMessage:data=>w.postMessage(data),async terminate(){await w.terminate();assert.equal(exited,true);}};
  w.on('message',data=>{if(data.decodeBoundary){assert.equal(data.decodeBoundary,3);entered();}else a.onmessage?.({data}as MessageEvent);});w.on('error',error=>a.onerror?.({message:String(error)}as ErrorEvent));w.on('exit',()=>{exited=true;exits++;});return a;});
 const controller=new AbortController(),request=pairRequest(source.target),running=owner.measure(request,[source.source,source.source],baseFile,controller.signal),rejected=assert.rejects(running,{name:'AbortError'});
 await started;controller.abort();await assert.rejects(owner.measure(request,[source.source,source.source],baseFile,new AbortController().signal),/already running/);await rejected;assert.equal(exits,1);
 const next=new AbortController(),again=owner.measure(request,[source.source,source.source],baseFile,next.signal);next.abort();await assert.rejects(again);assert.equal(exits,2);
});

test('intermediate dependency repeated SPS is byte-bound: identical accepted, one-byte change refused',{timeout:30000},async()=>{
 const sample=samples[0],bytes=Buffer.from(sample.flv,'base64'),original=await preparedPair(bytes),configuration=original.source.index!.description;
 const length=configuration[6]*256+configuration[7],nal=Buffer.from(configuration.slice(8,8+length)),repeat=Buffer.alloc(4+length);repeat.writeUInt32BE(length,0);repeat.set(nal,4);
 const packet=original.source.index!.packets[1],offset=packet[0],size=packet[1],header=offset-16;
 const repeated=Buffer.concat([bytes.subarray(0,offset),repeat,bytes.subarray(offset)]);repeated.writeUIntBE(size+repeat.length+5,header+1,3);repeated.writeUInt32BE(11+size+repeat.length+5,offset+repeat.length+size);
 async function run(body:Buffer){const a=await preparedPair(body,'a'.repeat(24),2),b=await preparedPair(body,'d'.repeat(24),5);for(const side of [a,b])side.target.decode={mode:'forward-one-output-per-au-v1',startAu:0};return client().measure(pairRequest(a.target,b.target),[a.source,b.source],baseFile,new AbortController().signal);}
 const expected=await run(bytes),accepted=await run(repeated);assert.deepEqual(accepted.metric,expected.metric);
 const changed=Buffer.from(repeated);changed[offset+repeat.length-1]^=1;await assert.rejects(run(changed),/changes parameter sets/);
});
