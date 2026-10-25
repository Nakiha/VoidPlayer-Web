import {ssimOracle} from '../test/helpers/ssim-oracle.mjs';
// Actual compiled Bun Worker and local file source, with no decoder executable in PATH.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn,spawnSync,execFileSync} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {createServer} from 'node:net';
import {trackChildShutdown} from './testing/lifecycle.mjs';
const root=path.resolve(import.meta.dirname,'..'),archive=path.resolve(process.argv[2]??JSON.parse(await readFile(path.join(root,'artifacts/latest-release.json'),'utf8')).archive);
const temp=await mkdtemp(path.join(tmpdir(),'vp-quality-release-'));let stopChild,output='';
try{
 const tar=process.platform==='win32'?path.join(process.env.SystemRoot,'System32','tar.exe'):'tar';execFileSync(tar,['-xzf',archive,'-C',temp]);
 const directory=path.join(temp,path.basename(archive,'.tar.gz')),manifest=JSON.parse(await readFile(path.join(directory,'release.json'),'utf8'));
 const media=path.join(temp,'media'),data=path.join(temp,'data'),cwd=path.join(temp,'unrelated'),empty=path.join(temp,'empty-path');
 for(const directory of [media,data,cwd,empty])await mkdir(directory);
 const samples=[...JSON.parse(await readFile(path.join(root,'test/helpers/quality-http-samples.json'),'utf8')).samples.filter(s=>s.tagged),...JSON.parse(await readFile(path.join(root,'test/helpers/quality-forward-samples.json'),'utf8')).samples.map(s=>({...s,forward:true})),...JSON.parse(await readFile(path.join(root,'test/helpers/quality-reordered-samples.json'),'utf8')).samples.filter(s=>s.frames===16).map(s=>({...s,gop:true}))];
 const sampleName=s=>`${s.codec}-${s.depth}${s.gop?'-gop':s.forward?'-forward':''}.flv`;
 for(const sample of samples){const bytes=Buffer.from(sample.flv,'base64');assert.equal(createHash('sha256').update(bytes).digest('hex'),sample.flvSha256);await writeFile(path.join(media,sampleName(sample)),bytes);}
 const socket=createServer();await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));const base=`http://127.0.0.1:${port}`;
 await writeFile(path.join(data,'voidplayer.config.json'),JSON.stringify({host:'127.0.0.1',port,mediaRoots:[{id:'quality-qa',name:'Quality QA',path:media}],indexWatch:false,logsDir:null}));
 const env={...process.env,PATH:empty};for(const key of Object.keys(env))if(key.startsWith('VOIDPLAYER_')||['BUN_OPTIONS','BUN_INSPECT'].includes(key))delete env[key];
 let child;
 const waitUntil=async(test,label)=>{for(let i=0;i<200;i++){if(child.exitCode!==null)throw new Error(output);if(await test())return;await new Promise(resolve=>setTimeout(resolve,50));}throw new Error(`${label}\n${output}`);};
 async function start(){
  child=spawn(path.join(directory,manifest.executable),['--data-dir',data],{cwd,env,stdio:['ignore','pipe','pipe']});stopChild=trackChildShutdown(child);child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
  await waitUntil(()=>fetch(base+'/api/ready').then(r=>r.ok).catch(()=>false),'Native quality startup timed out');
 }
 await start();
 const viewer=await fetch(base+'/quality.html');assert.equal(viewer.status,200);assert.match(viewer.headers.get('content-type'),/text\/html/);
 const viewerHtml=await viewer.text(),viewerModule=/<script[^>]+type="module"[^>]+src="([^"]+)"/.exec(viewerHtml)?.[1];assert.ok(viewerModule,'compiled package includes the explicit snapshot viewer entry');
 const viewerAsset=await fetch(new URL(viewerModule,base));assert.equal(viewerAsset.status,200);assert.match(viewerAsset.headers.get('content-type'),/(javascript|ecmascript)/);await viewerAsset.body.cancel();
 let entries;await waitUntil(async()=>{entries=(await fetch(base+'/api/library').then(r=>r.json())).entries;return samples.every(s=>entries.some(e=>e.name===sampleName(s)&&e.state==='ready'));},'Native quality library did not settle');
 const cookie=`voidplayer-user=guest-${randomUUID()}`,headers={cookie,origin:base,'content-type':'application/json','x-voidplayer-action':'quality'},rows=[];
 for(const sample of samples){
  const entry=entries.find(e=>e.name===sampleName(sample));
  const built=await fetch(`${base}/api/media/${entry.id}/frame-index?v=${entry.version}&build=1`);assert.equal(built.status,200);const cache=await built.json();assert.equal(cache.index.packets.length,sample.gop?16:sample.forward?8:2);
  const lookup=await fetch(`${base}/api/media/${entry.id}/psnr-source?v=${entry.version}`,{headers:{cookie}});const binding=await lookup.json();assert.equal(lookup.status,200,JSON.stringify(binding));
  const target=au=>({...binding.binding,sourcePtsUs:cache.index.packets[au][2],picture:{sourceVersion:`${entry.id}@${entry.version}`,stream:'video',configuration:0,au,picture:0,layer:0,field:'frame'},...(sample.gop?{decode:{mode:'packet-identity-gop-v1',startAu:0,endAu:15}}:sample.forward?{decode:{mode:'forward-one-output-per-au-v1',startAu:0}}:{})});
  const selectedAus=sample.forward||sample.gop?sample.selectedAus:[0,1];
  const request={pairing:'caller-specified',reference:target(selectedAus[0]),distorted:target(selectedAus[1]),roi:{x:2,y:4,width:24,height:20},spatial:{blockWidth:10,blockHeight:8}};
  const response=await fetch(base+'/api/quality/psnr-pair',{method:'POST',headers,body:JSON.stringify(request)}),value=await response.json();assert.equal(response.status,200,JSON.stringify(value));
  assert.equal(value.execution.runtime,'bun');assert.equal(value.execution.host,'node-worker');assert.equal(value.execution.runtimeVersion,manifest.runtime.version);assert.equal(value.result.metric.bitDepth,sample.depth);
  assert.equal(value.result.decoder.buildId,manifest.decoder.source.revision);assert.deepEqual(value.sources.reference,binding);assert.deepEqual(value.sources.distorted,binding);
  if(sample.forward){for(const side of ['reference','distorted'])assert.deepEqual(value.result.provenance[side].dependency.guarantee,{pixels:'exact-decoder-output-of-verified-input-window',referenceIntegrity:'not-certified',concealmentDetection:'unavailable'});assert.equal(value.result.work.packets,9);assert.equal(value.result.work.outputFrames,9);assert.equal(value.result.decoder.packetIdentity,'forward-one-output-per-au-v1');for(const side of ['reference','distorted'])assert.equal(value.result.provenance[side].dependency.outputFrames,request[side].picture.au+1);}
  if(sample.gop){assert.equal(value.result.decoder.packetIdentity,'packet-identity-gop-v1');assert.equal(value.result.decoder.packetIdentityAbi,1);assert.equal(value.result.work.packets,32);assert.equal(value.result.work.outputFrames,32);
   for(const side of ['reference','distorted']){const proof=value.result.provenance[side].dependency;assert.deepEqual(proof.outputIdentity.outputs.map(o=>o.au),sample.displayAuOrder);assert.ok(proof.outputIdentity.outputs.some(o=>o.phase==='drain'));assert.equal(proof.guarantee.referenceIntegrity,'not-certified');assert.equal(proof.guarantee.concealmentDetection,'unavailable');}}
  const raw=Buffer.from(sample.native,'base64');assert.equal(createHash('sha256').update(raw).digest('hex'),sample.nativeSha256);
  const bytes=sample.depth===8?1:2,frame=1536*bytes;let aggregate=0;
  for(const [i,name] of ['y','u','v'].entries()){
   const width=i?16:32,offset=[0,1024,1280][i],scale=i?2:1;let sse=0,samples=0;
   for(let y=4/scale;y<24/scale;y++)for(let x=2/scale;x<26/scale;x++){
    const at=(offset+y*width+x)*bytes,a=bytes===1?raw[at]:raw.readUInt16LE(at),b=bytes===1?raw[frame+at]:raw.readUInt16LE(frame+at);sse+=(a-b)**2;samples++;
   }
   assert.equal(value.result.metric.planes[name].sse,sse);assert.equal(value.result.metric.planes[name].samples,samples);aggregate+=sse;
  }
  assert.equal(value.result.metric.aggregate.sse,aggregate);assert.ok(aggregate>0);assert.equal(value.request.actorId,cookie.slice('voidplayer-user='.length));assert.equal(value.request.id,response.headers.get('x-request-id'));
  const grid=value.result.metric.spatial;assert.equal(grid.blocks.length,9);
  for(const block of grid.blocks){const r=block.roi;let sum=0;for(const [i,name]of ['y','u','v'].entries()){const width=i?16:32,offset=[0,1024,1280][i],scale=i?2:1;let sse=0,samples=0;
   for(let y=r.y/scale;y<(r.y+r.height)/scale;y++)for(let x=r.x/scale;x<(r.x+r.width)/scale;x++){const at=(offset+y*width+x)*bytes,a=bytes===1?raw[at]:raw.readUInt16LE(at),b=bytes===1?raw[frame+at]:raw.readUInt16LE(frame+at);sse+=(a-b)**2;samples++;}
   assert.equal(block.planes[name].sse,sse);assert.equal(block.planes[name].samples,samples);sum+=sse;
  }assert.equal(block.aggregate.sse,sum);}
  assert.equal(grid.blocks.reduce((n,b)=>n+b.aggregate.sse,0),aggregate);assert.deepEqual(grid.worst,grid.blocks.map(b=>b.index).sort((a,b)=>grid.blocks[b].aggregate.mse-grid.blocks[a].aggregate.mse||a-b).slice(0,8));
  const input={schema:'voidplayer-psnr-frame-job',version:1,client:{id:'compiled-acceptance',kind:'agent'},request:{...request,spatial:undefined,ssim:{variant:'ffmpeg-uniform-8x8-step4-v1'}}};
  const jobHeaders={...headers,'x-voidplayer-action':'quality-job','idempotency-key':`compiled-${sample.codec}-${sample.depth}${sample.gop?'-gop':sample.forward?'-forward':''}`};
  const submitted=await fetch(base+'/api/quality/jobs',{method:'POST',headers:jobHeaders,body:JSON.stringify(input)}),accepted=await submitted.json();assert.equal(submitted.status,202,JSON.stringify(accepted));
  assert.equal(accepted.job.submitted.requestId,submitted.headers.get('x-request-id'));let job;
  await waitUntil(async()=>{job=await fetch(`${base}/api/quality/jobs/${accepted.job.id}`,{headers:{cookie}}).then(r=>r.json());if(['failed','cancelled','interrupted'].includes(job.state))throw Error(JSON.stringify(job));return job.state==='completed';},'Compiled durable job did not finish');
  if(sample.gop)assert.equal(job.progress.decodedFrames,32);else if(sample.forward)assert.equal(job.progress.decodedFrames,9);
  const stored=await fetch(`${base}/api/quality/jobs/${job.id}/result`,{headers:{cookie}}).then(r=>r.json());
  assert.equal(stored.jobId,job.id);assert.equal(stored.attemptId,job.attempt.id);assert.equal(stored.submitted.actorId,cookie.slice('voidplayer-user='.length));
  const {spatial:unused,...wholeMetric}=value.result.metric;assert.deepEqual(stored.value.result.metric,wholeMetric);
  const oracle=ssimOracle(raw.subarray(0,frame),raw.subarray(frame),sample.depth,32,32,request.roi);
  assert.ok(Math.abs(stored.value.result.ssim.aggregate.score-oracle.all)<=1e-12);
  for(const key of ['y','u','v'])assert.ok(Math.abs(stored.value.result.ssim.planes[key].score-oracle[key].score)<=1e-12);assert.deepEqual(stored.value.result.provenance,value.result.provenance);
  assert.deepEqual(stored.value.result.decoder,value.result.decoder);assert.deepEqual(stored.value.sources,value.sources);assert.deepEqual(stored.value.execution,value.execution);
  const annotationHeaders={...headers,'x-voidplayer-action':'annotation'},annotationId=`evidence-${sample.codec}-${sample.depth}${sample.gop?'-gop':sample.forward?'-forward':''}`;
  const annotationDocument={media:[{id:'snapshot',name:entry.name,size:entry.size,lastModified:entry.lastModified,codec:sample.codec,decoder:'ffmpeg-wasm',width:32,height:32,durationUs:2000000,firstPtsUs:request.reference.sourcePtsUs,source:{kind:'library',id:entry.id,url:`${base}/api/media/${entry.id}?v=${entry.version}`}}],mark:{id:annotationId,text:'Compiled PSNR observation',severity:3,origin:'agent',createdAt:new Date().toISOString(),slot:'H',mediaId:'snapshot',frame:{ptsUs:0,sourcePtsUs:request.reference.sourcePtsUs,durationUs:1000000},comparison:[],region:null}};
  const createAnnotation=await fetch(base+'/api/annotations/spaces/default',{method:'POST',headers:annotationHeaders,body:JSON.stringify({id:annotationId,operationId:'create-'+annotationId,revision:0,action:'put',document:annotationDocument})});assert.equal(createAnnotation.status,200,await createAnnotation.clone().text());
  const attach={id:annotationId,operationId:'attach-'+annotationId,revision:1,action:'attach-quality-result',evidence:{jobId:job.id,attemptId:job.attempt.id,digest:job.result.digest,side:'reference'}};
  const attachment=await fetch(base+'/api/annotations/spaces/default',{method:'POST',headers:annotationHeaders,body:JSON.stringify(attach)});const attached=await attachment.json();assert.equal(attachment.status,200,JSON.stringify(attached));
  assert.equal(attached.document.mark.qualityEvidence[0].verification,'server-verified');assert.deepEqual(attached.document.mark.qualityEvidence[0].value,stored.value);
  rows.push({request,requestId:value.request.id,codec:sample.codec,depth:sample.depth,sse:aggregate,decoder:value.result.decoder,source:binding,execution:value.execution,
    annotation:{attach,attached},durable:{input,job,stored,key:jobHeaders['idempotency-key']}});
 }
 const duplicate=spawnSync(path.join(directory,manifest.executable),['--data-dir',data],{cwd,env,encoding:'utf8',timeout:10000,maxBuffer:1024*1024});
 assert.equal(duplicate.error,undefined);assert.notEqual(duplicate.status,0);assert.match(duplicate.stdout+duplicate.stderr,/另一个实例/,'second compiled instance must not recover a live owner');
 await stopChild();stopChild=null;await start();
 for(const row of rows){
  const historical=await fetch(`${base}/api/annotations/spaces/default/${row.annotation.attached.id}`).then(r=>r.json());assert.deepEqual(historical,row.annotation.attached);
  const attachmentReplay=await fetch(base+'/api/annotations/spaces/default',{method:'POST',headers:{...headers,'x-voidplayer-action':'annotation'},body:JSON.stringify(row.annotation.attach)});assert.equal(attachmentReplay.status,200);assert.deepEqual(await attachmentReplay.json(),historical);
  const job=await fetch(`${base}/api/quality/jobs/${row.durable.job.id}`,{headers:{cookie}}).then(r=>r.json());assert.deepEqual(job,row.durable.job);
  const stored=await fetch(`${base}/api/quality/jobs/${job.id}/result`,{headers:{cookie}}).then(r=>r.json());assert.deepEqual(stored,row.durable.stored);
  const replay=await fetch(base+'/api/quality/jobs',{method:'POST',headers:{...headers,'x-voidplayer-action':'quality-job','idempotency-key':row.durable.key},body:JSON.stringify(row.durable.input)});
  assert.equal(replay.status,200);const receipt=await replay.json();assert.equal(receipt.replayed,true);assert.deepEqual(receipt.job,job,'restart replay creates no new attempt');
 }
 const first=rows[0],entry=entries.find(e=>e.name===`${first.codec}-${first.depth}.flv`);
 const rebound=await fetch(`${base}/api/media/${entry.id}/psnr-source?v=${entry.version}`,{headers:{cookie}});assert.equal(rebound.status,200);assert.deepEqual(await rebound.json(),first.source,'restart retains the actual server producer/cache binding');
 const rerun=await fetch(base+'/api/quality/psnr-pair',{method:'POST',headers,body:JSON.stringify(first.request)}),again=await rerun.json();assert.equal(rerun.status,200,JSON.stringify(again));assert.equal(again.result.metric.aggregate.sse,first.sse);assert.notEqual(again.request.id,first.requestId,'a fresh one-shot execution is not a cached task result');
 const capabilities=await fetch(base+'/api/agent',{headers:{cookie}}).then(r=>r.json());assert.equal(capabilities.capabilities.find(c=>c.id==='quality.jobs').implemented,true);assert.equal(capabilities.capabilities.find(c=>c.id==='quality.jobs').readiness,'per-source');assert.equal(capabilities.capabilities.find(c=>c.id==='quality.frame-pair').requiresBrowser,false);
 assert.deepEqual(capabilities.qualityJobs.metrics,['psnr','ssim']);assert.equal(capabilities.qualityJobs.scope,'single-explicit-frame-pair');assert.equal(capabilities.qualityJobs.submit,'/api/quality/jobs');assert.equal(capabilities.qualityJobs.automaticRetry,false);assert.equal(capabilities.qualityJobs.sharedWork,false);
 const report=path.resolve(process.env.VOIDPLAYER_TEST_ARTIFACTS??path.join(root,'.run/quality-release'));await mkdir(report,{recursive:true});await writeFile(path.join(report,'native-quality.json'),JSON.stringify({target:manifest.target,rows},null,2)+'\n');
 console.log(`PASS ${manifest.target}: compiled Bun quality Worker, real library/cache HTTP, 8/10-bit native SSE/provenance, durable jobs/annotation evidence/idempotency/history restart, second-instance rejection, empty PATH`);
}finally{if(stopChild)await stopChild();await rm(temp,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
