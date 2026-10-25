import test from 'node:test';import assert from 'node:assert/strict';
import {readFile,mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {randomUUID} from 'node:crypto';import {resolve,join} from 'node:path';import {pathToFileURL} from 'node:url';import {createHash} from 'node:crypto';
import {preparedPair,pairRequest,flvTag} from '../helpers/frame-pair-fixture.ts';
import {inspectFlvFramePair,measureFlvFramePair} from '../../shared/analysis/quality/frame-pair.ts';
import {qualityFrameCandidates} from '../../shared/analysis/quality/selection.ts';
import {openPairDecoder} from '../../src/analysis/quality/wasm-decoder.ts';
import {loadConfig} from '../../server/config.ts';import {startService} from '../../server/runtime.ts';
// @ts-ignore shared library readiness harness
import {waitForAnnotationMedia} from '../../scripts/testing/agent-annotations-ready.mjs';
import type {AddressInfo} from 'node:net';
import {parseFlvIndex} from '../../shared/media/indexing/flv-index-cache.ts';
import {qualityEvidenceValue} from '../../shared/review/quality-evidence.ts';
const fixture=JSON.parse(await readFile(new URL('../helpers/quality-reordered-samples.json',import.meta.url),'utf8')),samples=fixture.samples,delayedSamples=fixture.delayedSamples;
const base=pathToFileURL(resolve('public/vendor/voidplayer-core/voidplayer-core.js')).href;
const binary=new Uint8Array(await readFile(resolve('public/vendor/voidplayer-core/voidplayer-core.wasm')));
const sha=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
for(const s of [...samples,...delayedSamples]){
 test(`reordered ${s.codec}/${s.depth}/${s.frames}: token-bound selected outputs equal fixed native bytes including drain`,{timeout:60000},async()=>{
  const bytes=Buffer.from(s.flv,'base64'),native=Buffer.from(s.allNative,'base64'),frame=1536*(s.depth===8?1:2);assert.equal(sha(bytes),s.flvSha256);assert.equal(sha(native),s.allNativeSha256);
  const p=await preparedPair(bytes),candidates=qualityFrameCandidates({binding:p.source.binding,producer:{}as any},p.source.index!,{afterAu:0,limit:50});assert.equal(candidates.entries.length,s.frames);
  assert.ok(candidates.entries.every(p=>p.decode?.mode==='packet-identity-gop-v1'&&p.decode.startAu===0&&p.decode.endAu===s.frames-1));
  for(const target of candidates.entries){
   const request=pairRequest(target);request.roi={x:0,y:0,width:32,height:32};
   const result=await inspectFlvFramePair(request,[p.open(),p.open()],budget=>openPairDecoder(base,binary,budget.maxHeapBytes),new AbortController().signal);
   const display=s.displayAuOrder.indexOf(target.picture.au),expected=native.subarray(display*frame,(display+1)*frame);
   for(const output of result.frames)assert.deepEqual(Buffer.from(output.pixels),expected,`AU${target.picture.au} mapped by returned identity token`);
   assert.equal(result.decoder.packetIdentity,'packet-identity-gop-v1');assert.equal(result.decoder.packetIdentityAbi,1);assert.equal(result.work.outputFrames,2*s.frames);assert.equal(result.work.packets,2*s.frames);
   const proof=result.provenance.reference.dependency!.outputIdentity!;assert.deepEqual(proof.outputs.map(o=>o.au),s.displayAuOrder);assert.ok(proof.outputs.some(o=>o.phase==='drain'));if(s.zeroCts){assert.ok(proof.outputs.every(o=>o.phase==='drain'));assert.ok(p.source.index!.packets.every(p=>p[2]===p[3]));}
   for(const output of proof.outputs){assert.equal(output.token,String(output.au+1));assert.equal(output.decodeErrorFlags,0);}
  }
 });
 if(s.zeroCts){test(`zero CTS ${s.codec}: legacy forward remains strict rather than switching modes`,async()=>{const p=await preparedPair(Buffer.from(s.flv,'base64'),'a'.repeat(24),1);p.target.decode={mode:'forward-one-output-per-au-v1',startAu:0};await assert.rejects(measureFlvFramePair(pairRequest(p.target),[p.open(),p.open()],b=>openPairDecoder(base,binary,b.maxHeapBytes),new AbortController().signal),/immediate|exactly one|output/i);});continue;}
 test(`reordered ${s.codec}/${s.frames}: PSNR/SSIM/grid and strict immutable identity evidence`,{timeout:30000},async()=>{
  const bytes=Buffer.from(s.flv,'base64'),a=await preparedPair(bytes,'a'.repeat(24),2),b=await preparedPair(bytes,'d'.repeat(24),5);
  for(const x of [a,b])x.target.decode={mode:'packet-identity-gop-v1',startAu:0,endAu:s.frames-1};
  const request=pairRequest(a.target,b.target);request.roi={x:0,y:0,width:32,height:32};request.spatial={blockWidth:16,blockHeight:16};request.ssim={variant:'ffmpeg-uniform-8x8-step4-v1'};
  const result=await measureFlvFramePair(request,[a.open(),b.open()],budget=>openPairDecoder(base,binary,budget.maxHeapBytes),new AbortController().signal);
  const raw=Buffer.from(s.native,'base64'),frame=raw.length/2,step=s.depth===8?1:2;let expected=0n;
  for(let i=0;i<frame;i+=step){const d=BigInt(step===1?raw[i]-raw[frame+i]:raw.readUInt16LE(i)-raw.readUInt16LE(frame+i));expected+=d*d;}
  assert.equal(result.metric.aggregate.sse,Number(expected));assert.ok(expected>0n);assert.equal(result.metric.spatial!.blocks.reduce((n,b)=>n+b.aggregate.sse,0),Number(expected));
  const proof=(p:typeof a)=>({binding:p.source.binding,producer:{producer:'server-flv-scan-v1',sourceVersion:p.target.picture.sourceVersion,size:bytes.length,epoch:1,packetCommitId:'synthetic-test',documentSha256:'0'.repeat(64),sourceStat:{size:String(bytes.length),dev:'1',ino:'2',mtimeNs:'3',ctimeNs:'4'}}});
  const value:any={schema:'voidplayer-library-frame-pair-psnr',version:1,execution:{host:'node-worker',runtime:'node',runtimeVersion:process.versions.node,sourceIdentity:'stat-version-v1'},result,sources:{reference:proof(a),distorted:proof(b)}};qualityEvidenceValue(value);
  for(const mutate of [(v:any)=>{v.result.provenance.reference.dependency.outputIdentity.outputs[0].token='999';},(v:any)=>{v.result.provenance.reference.dependency.outputIdentity.outputs[1].au=0;},(v:any)=>{v.result.provenance.reference.dependency.outputIdentity.outputs[0].decodeErrorFlags=1;},(v:any)=>{delete v.result.provenance.reference.dependency.outputIdentity;},(v:any)=>{v.result.provenance.reference.decode.endAu--;},(v:any)=>{v.result.provenance.reference.dependency.guarantee.referenceIntegrity='certified';}]){const bad=structuredClone(value);mutate(bad);assert.throws(()=>qualityEvidenceValue(bad));}
 });
}


test('actual reordered native send cancellation terminates Worker before readmission',{timeout:15000},async()=>{
 const {Worker}=await import('node:worker_threads');const {FramePairClient}=await import('../../src/analysis/quality/pair-client.ts');
 const sample=samples[0],p=await preparedPair(Buffer.from(sample.flv,'base64'),'a'.repeat(24),5);p.target.decode={mode:'packet-identity-gop-v1',startAu:0,endAu:15};
 let entered!:()=>void;const started=new Promise<void>(r=>entered=r),gate=new SharedArrayBuffer(4);let exits=0;
 const client=new FramePairClient(()=>{const worker=new Worker(new URL('../helpers/forward-cancel-worker.ts',import.meta.url),{workerData:{gate,identity:true}});let exited=false;
  const transport:any={onmessage:null,onerror:null,onmessageerror:null,postMessage:(data:unknown)=>worker.postMessage(data),async terminate(){await worker.terminate();assert.equal(exited,true);}};
  worker.on('message',data=>{if(data.decodeBoundary){assert.equal(data.decodeBoundary,3);entered();}else transport.onmessage?.({data});});worker.on('error',error=>transport.onerror?.({message:String(error)}));worker.on('exit',()=>{exited=true;exits++;});return transport;});
 const abort=new AbortController(),request=pairRequest(p.target),running=client.measure(request,[p.source,p.source],pathToFileURL(resolve('public/index.html')).href,abort.signal),rejected=assert.rejects(running,{name:'AbortError'});
 await started;abort.abort();await assert.rejects(client.measure(request,[p.source,p.source],'',new AbortController().signal),/already running/);await rejected;assert.equal(exits,1);
 const next=new AbortController(),second=client.measure(request,[p.source,p.source],'',next.signal);next.abort();await assert.rejects(second);assert.equal(exits,2);
});


for(const sample of [...samples.filter((s:any)=>s.frames===16),...delayedSamples]){
 test(`${sample.zeroCts?'zero-CTS delayed':'reordered'} ${sample.codec}: real HTTP source build, durable window/result/evidence and restart`,{timeout:60000},async t=>{
  const dir=await mkdtemp(join(tmpdir(),'vp-gop-http-')),media=join(dir,'media');let service:Awaited<ReturnType<typeof startService>>|undefined;
  t.after(async()=>{await service?.close();await rm(dir,{recursive:true,force:true});});await mkdir(media);await writeFile(join(media,'gop.flv'),Buffer.from(sample.flv,'base64'));
  const config=await loadConfig([],'production',dir,{staticDir:resolve('public'),dataDir:join(dir,'data'),logsDir:join(dir,'logs'),allowEmptyRoots:true});config.mediaRoots=[media];config.logsDir=null;config.indexWatch=false;config.port=0;
  const start=async()=>{service=await startService(config,false);await service.library.refresh();return `http://127.0.0.1:${(service.server.address()as AddressInfo).port}`;};let base=await start();
  const [entry]=await waitForAnnotationMedia(service!.library,['gop.flv']),headers={cookie:`voidplayer-user=guest-${randomUUID()}`,origin:base,'content-type':'application/json','x-voidplayer-action':'quality-job'};
  assert.equal((await fetch(`${base}/api/media/${entry.id}/frame-index?v=${entry.version}&build=1`)).status,200);
  const page=await fetch(`${base}/api/media/${entry.id}/psnr-frames?v=${entry.version}`,{headers}).then(r=>r.json());assert.equal(page.entries.length,sample.frames);if(sample.zeroCts)assert.ok(page.entries.every((p:any)=>p.decode?.mode==='packet-identity-gop-v1'&&p.decode.endAu===1));
  const request={pairing:'caller-specified',reference:page.entries.find((p:any)=>p.picture.au===(sample.zeroCts?1:2)),distorted:page.entries.find((p:any)=>p.picture.au===(sample.zeroCts?1:5)),roi:{x:0,y:0,width:32,height:32},spatial:{blockWidth:16,blockHeight:16},ssim:{variant:'ffmpeg-uniform-8x8-step4-v1'}};
  const input={schema:'voidplayer-psnr-frame-job',version:1,client:{id:'gop-http',kind:'agent'},request};const send=(value:unknown)=>fetch(base+'/api/quality/jobs',{method:'POST',headers:{...headers,'idempotency-key':'gop-once'},body:JSON.stringify(value)});
  for(const [i,decode]of [null,[],{mode:'packet-identity-gop-v1',startAu:0},{mode:'packet-identity-gop-v1',startAu:0,endAu:15.5}].entries()){
   const invalid=structuredClone(input);invalid.request.reference.decode=decode;
   const rejected=await fetch(base+'/api/quality/jobs',{method:'POST',headers:{...headers,'idempotency-key':`invalid-decode-${i}`},body:JSON.stringify(invalid)});
   assert.equal(rejected.status,400,await rejected.clone().text());assert.equal((await rejected.json()).code,'invalid-request');
   const one=await fetch(base+'/api/quality/psnr-pair',{method:'POST',headers:{...headers,'x-voidplayer-action':'quality'},body:JSON.stringify(invalid.request)});
   assert.equal(one.status,400,await one.clone().text());assert.equal((await one.json()).code,'invalid-request');
  }
  const untouched=await fetch(base+'/api/quality/jobs',{headers}).then(r=>r.json());assert.deepEqual(untouched.entries,[]);assert.equal(untouched.resources.activeAttempts,0);assert.equal(untouched.resources.queued,0);
  const response=await send(input);assert.equal(response.status,202);let job=(await response.json()).job;
  for(let n=0;n<300&&!['completed','failed','cancelled'].includes(job.state);n++){await new Promise(r=>setTimeout(r,25));job=await fetch(`${base}/api/quality/jobs/${job.id}`,{headers}).then(r=>r.json());}
  assert.equal(job.state,'completed',JSON.stringify(job));assert.equal(job.progress.decodedFrames,2*sample.frames);
  const result=await fetch(`${base}/api/quality/jobs/${job.id}/result`,{headers}).then(r=>r.json());qualityEvidenceValue(result.value);assert.equal(result.value.result.work.outputFrames,2*sample.frames);
  for(const side of ['reference','distorted']){assert.deepEqual(result.value.result.provenance[side].dependency.outputIdentity.outputs.map((o:any)=>o.au),sample.displayAuOrder);if(sample.zeroCts)assert.ok(result.value.result.provenance[side].dependency.outputIdentity.outputs.every((o:any)=>o.phase==='drain'));}if(sample.zeroCts)assert.equal(result.value.result.metric.aggregate.sse,0);
  const changed=structuredClone(input);if(sample.zeroCts)changed.request.distorted=page.entries[0];else changed.request.distorted.decode.endAu--;assert.equal((await send(changed)).status,409);
  const ah={...headers,'x-voidplayer-action':'annotation'},document={media:[{id:'m',name:entry.name,size:entry.size,lastModified:entry.lastModified,codec:sample.codec,decoder:'ffmpeg-wasm',width:32,height:32,durationUs:1600000,firstPtsUs:2000000,source:{kind:'library',id:entry.id,url:`${base}/api/media/${entry.id}?v=${entry.version}`}}],mark:{id:'gop-evidence',text:'Exact B-frame observation',severity:3,origin:'agent',createdAt:new Date().toISOString(),slot:'H',mediaId:'m',frame:{ptsUs:request.reference.sourcePtsUs-2000000,sourcePtsUs:request.reference.sourcePtsUs,durationUs:100000},comparison:[],region:null}};
  assert.equal((await fetch(base+'/api/annotations/spaces/default',{method:'POST',headers:ah,body:JSON.stringify({action:'put',id:'gop-evidence',operationId:'create-gop',revision:0,document})})).status,200);
  const attach={action:'attach-quality-result',id:'gop-evidence',operationId:'attach-gop',revision:1,evidence:{jobId:job.id,attemptId:job.attempt.id,digest:job.result.digest,side:'reference'}};
  const attached=await fetch(base+'/api/annotations/spaces/default',{method:'POST',headers:ah,body:JSON.stringify(attach)});assert.equal(attached.status,200);const facts=await attached.json();assert.deepEqual(facts.document.mark.qualityEvidence[0].value,result.value);
  await service!.close();service=undefined;base=await start();headers.origin=base;ah.origin=base;
  assert.deepEqual(await fetch(`${base}/api/quality/jobs/${job.id}/result`,{headers}).then(r=>r.json()),result);
  const replay=await send(input);assert.equal(replay.status,200);assert.equal((await replay.json()).job.id,job.id);
  assert.deepEqual(await fetch(base+'/api/annotations/spaces/default',{method:'POST',headers:ah,body:JSON.stringify(attach)}).then(r=>r.json()),facts);
 });
 if(sample.zeroCts)continue;
 test(`reordered ${sample.codec}: next IDR boundary is byte-validated; incomplete windows and clocks fail`,{timeout:30000},async()=>{
  const original=Buffer.from(sample.flv,'base64'),a=await preparedPair(original),index=parseFlvIndex(a.source.index!,original.length);
  const header=(p:typeof index.packets[number])=>{const cts=Buffer.alloc(3);cts.writeUIntBE(((p.pts-p.dts)/1000)&0xffffff,0,3);return sample.codec==='hevc'?Buffer.concat([Buffer.from([p.key?0x91:0xa1]),Buffer.from('hvc1'),cts]):Buffer.concat([Buffer.from([p.key?0x17:0x27,1]),cts]);};
  const suffix=index.packets.map(p=>flvTag(Buffer.concat([header(p),original.subarray(p.offset,p.offset+p.size)]),p.dts/1000+1600));
  const bytes=Buffer.concat([original,...suffix]),source=await preparedPair(bytes,'a'.repeat(24),2);source.target.decode={mode:'packet-identity-gop-v1',startAu:0,endAu:15};
  const result=await measureFlvFramePair(pairRequest(source.target),[source.open(),source.open()],b=>openPairDecoder(base,binary,b.maxHeapBytes),new AbortController().signal);
  assert.equal(result.provenance.reference.dependency!.boundary!.au,16);assert.equal(result.work.outputFrames,32);
  for(const mutate of [(r:any)=>{r.reference.decode.endAu=14;},(r:any)=>{r.reference.decode.startAu=1;},(r:any)=>{r.reference.sourcePtsUs++;},(r:any)=>{r.budget={maxPackets:31};},(r:any)=>{r.budget={maxOutputFrames:31};},(r:any)=>{r.budget={maxReadBytes:1};}]){const request=pairRequest(source.target);mutate(request);await assert.rejects(measureFlvFramePair(request,[source.open(),source.open()],b=>openPairDecoder(base,binary,b.maxHeapBytes),new AbortController().signal));}
  const next=source.source.index!.packets[16],damaged=Buffer.from(bytes);damaged[next[0]-1]^=1;
  const altered={...source.source,file:new Blob([damaged])};const {blobPairSource}=await import('../../src/analysis/quality/source.ts');await assert.rejects(measureFlvFramePair(pairRequest(source.target),[blobPairSource(altered),source.open()],b=>openPairDecoder(base,binary,b.maxHeapBytes),new AbortController().signal),/tag identity/);
 });
}
