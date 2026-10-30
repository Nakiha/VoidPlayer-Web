import {assertOfficial,assertVmafOfficial} from '../helpers/official-quality-oracle.mjs';
import {xpsnrFixture,xpsnrOracle} from '../helpers/native-xpsnr.mjs';
import {parseXpsnrStatistics} from '../../shared/analysis/quality/xpsnr.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {startService} from '../../server/runtime.ts';
import {httpFetch} from '../http-request.ts';
import {nativeFixture,officialOracle,until} from '../helpers/native-vmaf.mjs';
// @ts-ignore shared fixture readiness, outside the ordinary HTTP example
import {waitForAnnotationMedia} from '../../scripts/testing/agent-annotations-ready.mjs';
// The example imports only Node built-ins. All product interaction is public HTTP.
// @ts-ignore standalone ordinary HTTP client
import {runHttpQuality} from '../../examples/http-quality.mjs';

const allow={identity:true,prepare:true,plan:true,compute:true,candidate:true,retryUnknown:true};
function inputFor(f:any,mode='single'){
 const [reference,distorted]=f.entries.map((e:any)=>({id:e.id,version:e.version}));
 return {mode,key:'http-'+randomUUID(),identity:{mode:'create',name:'HTTP-only reviewer'},client:{id:'ordinary-http',name:'Ordinary HTTP example'},reference,distorted,
  declaration:'Explicit caller relation for committed fixtures; not content certification',clock:{mode:'piecewise-exact-source-pts-offset',segments:[{id:'declared',referenceStartUs:0,referenceEndUs:10000000,offsetUs:0}]},
  plan:{interval:{startAu:0,endAu:mode==='single'?0:mode==='range'?2:7},sampling:{mode:'all'},recipe:{roi:{x:0,y:0,width:(mode==='vmaf'||mode==='xpsnr')?128:32,height:(mode==='vmaf'||mode==='xpsnr')?96:32},ssim:{variant:'ffmpeg-uniform-8x8-step4-v1'},...((mode==='vmaf'||mode==='xpsnr')?{}:{spatial:{blockWidth:16,blockHeight:16}}),budget:{maxReadBytes:1048576,maxInputBytes:1048576}},budget:{maxReadBytes:32*1048576,maxInputBytes:32*1048576,maxPackets:4096,maxOutputFrames:4096,maxElapsedMs:120000},planningBudget:{maxIndexBytes:1048576,maxIndexPackets:4096,maxElapsedMs:30000}},
  xpsnr:{recipe:'ffmpeg-xpsnr-reference-first-temporal-v1',cadenceUs:250000,metrics:{psnr:true,ssim:true},budget:{maxRawBytes:8*1048576,maxElapsedMs:120000,nativeCpuSeconds:30,nativeMemoryBytes:512*1048576}},
  vmaf:{model:'vmaf_v0_6_1',cadenceUs:250000,metrics:{psnr:true,ssim:true},budget:{maxRawBytes:8*1048576,maxElapsedMs:120000,nativeCpuSeconds:30,nativeMemoryBytes:512*1048576}},
  candidate:mode==='single'?{space:'default',side:'reference',id:randomUUID(),operationId:randomUUID(),text:'Explicit HTTP measurement candidate',severity:3}:mode==='range'?{space:'default',side:'reference',metric:'psnr',maxDb:120,limit:1,minAuDistance:1,text:'Explicit HTTP range candidate',severity:3}:{space:'default',side:'reference',maxScore:100,limit:1,minFrameDistance:1,text:'Explicit HTTP VMAF candidate',severity:3}};
}

for(const [mode,containers]of [['single',['flv','flv']],['range',['mp4','flv']],['vmaf',['flv','mp4']],['xpsnr',['mp4','flv']]]as const)test(`cold HTTP from llms.txt, no frontend: ${mode} ${containers.join('→')}`,{timeout:120000},async t=>{
 const f=await (mode==='xpsnr'?xpsnrFixture:nativeFixture)({prepare:false,distorted:true,containers,component:false,staticDir:'public'});t.after(()=>f.close());
 const input=inputFor(f,mode),trace:{method:string;path:string;key:string|null;body:string|undefined}[]=[],lost={prepare:false,compute:false,candidate:false};
 const fetchImpl=async(url:any,options:any)=>{
  const path=new URL(url).pathname,method=options?.method??'GET';trace.push({method,path,key:options?.headers?.['idempotency-key']??null,body:options?.body});
  const response=await fetch(url,options);
  // Consume the real accepted/committed response, then lose its acknowledgement.
  const kind=path==='/api/library/preparations'?'prepare':path==='/api/quality/jobs'||path.endsWith('/execute')||(path==='/api/quality/vmaf/jobs'||path==='/api/quality/xpsnr/jobs')?'compute':path.endsWith('/candidates')||path==='/api/annotations/spaces/default'?'candidate':null;
  if(method==='POST'&&kind&&!lost[kind]&&response.ok){lost[kind]=true;await response.arrayBuffer();throw new TypeError('test transport loss after real server commit');}
  return response;
 };
 const before=await runHttpQuality(f.base,input,{fetchImpl});assert.equal(trace[0].path,'/llms.txt');assert.ok(trace.every(r=>r.method==='GET'),'default authorizes no writes, including identity selection');assert.equal((await fetch(f.base)).status,404);assert.ok(before.next.length);
 const unprepared=await f.request(`/api/media/${input.reference.id}/psnr-source?v=${input.reference.version}`);assert.equal(unprepared.status,409);assert.equal((await unprepared.json()).code,'cache-miss');
 const report=await runHttpQuality(f.base,input,{allow,fetchImpl,pollMs:10});assert.equal(report.job.job?.state??report.job.state,'completed');assert.equal(report.annotations.length,1);assert.ok(report.events.some((e:any)=>e.id===report.annotations[0].id));
 const evidence=report.annotations[0].document.mark.qualityEvidence[0];assert.equal(evidence.verification,'server-verified');assert.equal(evidence.value.result.ssim.variant,'ffmpeg-uniform-8x8-step4-v1');assert.equal(evidence.value.result.metric.roi.width,(mode==='vmaf'||mode==='xpsnr')?128:32);assert.equal(evidence.value.result.provenance.reference.mediaId,input.reference.id);
 assert.deepEqual(lost,{prepare:true,compute:true,candidate:true});
 for(const path of new Set(trace.filter(r=>r.method==='POST').map(r=>r.path))){const rows=trace.filter(r=>r.method==='POST'&&r.path===path);if(rows.length===2&&path!=='/api/library/preparations'){assert.equal(rows[0].body,rows[1].body);assert.equal(rows[0].key,rows[1].key);}}
 if(mode==='single'){assert.ok(report.result.value.result.metric.aggregate.sse>0);assert.equal(report.result.value.result.metric.spatial.blocks.length,4);}
 if(mode==='range'){assert.equal(report.job.coverage.complete,true);assert.equal(report.results.length,3);assert.equal(report.job.job.summary.scoredPairs,3);}
 if(mode==='xpsnr'){const oracle=parseXpsnrStatistics(await xpsnrOracle(f,8),8);assertOfficial(report.result.xpsnr.frames,oracle.frames,0.000051);assertOfficial(report.result.xpsnr.pooled,oracle.pooled,0.000051);assert.equal(report.frames.length,8);}
 if(mode==='vmaf'){const oracle=await officialOracle(f,8);assertVmafOfficial(report.result.vmaf.frames,oracle.result.frames.map((v:any)=>({index:v.frameNum,score:v.metrics.vmaf})));assertVmafOfficial(report.result.vmaf.pooled,oracle.result.pooled_metrics.vmaf);assert.equal(report.frames.length,8);}
 // The same attributed actor and stable original input replay all receipts, without
 // preparing, planning or computing again; changed identity creation is not repeated.
 const replayInput={...input,identity:{id:report.actor.id}},replay=await runHttpQuality(f.base,replayInput,{allow,pollMs:10});assert.equal(replay.job.job?.id??replay.job.id,report.job.job?.id??report.job.id);assert.deepEqual(replay.publication.createdIds,report.publication.createdIds);assert.equal(replay.annotations[0].revision,1);
 const other='guest-'+randomUUID(),jobId=mode==='range'?report.job.job.id:report.job.id,path=mode==='single'?'/api/quality/jobs/':mode==='range'?'/api/quality/ranges/':`/api/quality/${mode}/jobs/`;assert.equal((await fetch(f.base+path+jobId,{headers:{cookie:'voidplayer-user='+other,'x-voidplayer-actor':other}})).status,404);
 console.log(JSON.stringify({mode,containers,jobId,candidate:report.publication.createdIds[0],requests:report.requests,unknownResponseReplays:lost,noFrontend:true}));
});

test('HTTP prerequisites: unknown metadata, cache miss, missing analysis artifact, changed source and actor stop safely',{timeout:120000},async t=>{
 const f=await nativeFixture({prepare:false,component:false,staticDir:'public'});t.after(()=>f.close());const input=inputFor(f),seen:string[]=[];
 const fetchImpl=async(url:any,options:any)=>{seen.push(`${options?.method??'GET'} ${new URL(url).pathname}`);return fetch(url,options);};
 const unknown=await runHttpQuality(f.base,{query:{codec:'h264',includeUnknown:'1',limit:'1'}},{fetchImpl});assert.equal(unknown.discovery.length,2);assert.ok(unknown.discovery.some((e:any)=>e.decision.state==='unknown'));
 const cli=await promisify(execFile)(process.execPath,['examples/http-quality.mjs',f.base],{timeout:30000,maxBuffer:1048576});const cliReport=JSON.parse(cli.stdout);assert.equal(cliReport.discovery.length,2);assert.deepEqual(cliReport.writesAuthorized,[]);
 const missing=await runHttpQuality(f.base,input,{allow:{identity:true},fetchImpl});assert.equal(missing.reason,'cache-miss');assert.ok(missing.next[0].endsWith('library.prepare'));assert.ok(!seen.includes('POST /api/library/preparations'));
 (f.service.library.qualityVmaf as any).runner.analysisDir=join(f.directory,'missing-analysis');
 const unavailable=await runHttpQuality(f.base,{...input,mode:'vmaf',identity:{id:missing.actor.id}},{allow,fetchImpl});assert.equal(unavailable.nativeCapability.enabled,false);assert.ok(!seen.includes('POST /api/quality/vmaf/jobs'));assert.ok(!seen.includes('POST /api/quality/correspondence-plans'));
 await assert.rejects(()=>runHttpQuality(f.base,input,{cookie:'voidplayer-user='+f.actor,actor:'guest-'+randomUUID(),allow}),{code:'actor-changed'});
 const original=await readFile(join(f.media,f.entries[0].name));await writeFile(join(f.media,f.entries[0].name),Buffer.concat([original,Buffer.from([0])]));await f.service.library.refresh();
 await assert.rejects(()=>runHttpQuality(f.base,input,{allow,fetchImpl}),{code:'source-selection-changed'});
 const source=await readFile(new URL('../../examples/http-quality.mjs',import.meta.url),'utf8');for(const match of source.matchAll(/from ['"]([^'"]+)['"]/g))assert.ok(match[1].startsWith('node:'),'example has no product imports');assert.doesNotMatch(source,/playwright|puppeteer|\bwindow\.|\blocalStorage\.|\bdocument\.(?:createElement|querySelector|getElement)/);
});

test('HTTP example restarts only read cursors, fences uncertain writes by actor, and never cancels on observation loss',{timeout:120000},async t=>{
 const f=await nativeFixture({prepare:false,component:false});t.after(()=>f.close());const input=inputFor(f),original=await readFile(join(f.media,f.entries[0].name));
 let changed=false,resets=0;
 const cursorFetch=async(url:any,options:any)=>{
  const u=new URL(url),r=await fetch(url,options);
  if(u.pathname==='/api/library/discovery'&&!changed){changed=true;await r.clone().arrayBuffer();await writeFile(join(f.media,'later.flv'),original);await f.service.library.refresh();await waitForAnnotationMedia(f.service.library,['later.flv']);}
  else if(u.pathname==='/api/library/discovery'&&r.status===409)resets++;
  return r;
 };
 const page=await runHttpQuality(f.base,{query:{limit:'1',includeUnknown:'1'}},{fetchImpl:cursorFetch});assert.equal(resets,1);assert.equal(page.discovery.length,3);assert.equal(new Set(page.discovery.map((e:any)=>e.source.id)).size,3);
 // Refresh explicit user selection after the changed version, before any write.
 const sources=page.discovery;input.reference=sources.find((e:any)=>e.file.name===f.entries[0].name).source;input.distorted=sources.find((e:any)=>e.file.name===f.entries[1].name).source;
 let switched=false,submitted=0,firstId='',firstActor='';
 const switchFetch=async(url:any,options:any)=>{
  const u=new URL(url),headers={...options.headers,...(switched?{cookie:'voidplayer-user=guest-'+other}:{})};
  const response=await fetch(url,{...options,headers});
  if(u.pathname==='/api/library/preparations'&&options.method==='POST'){submitted++;firstActor=options.headers['x-voidplayer-actor'];firstId=(await response.clone().json()).job.id;await response.arrayBuffer();switched=true;throw new TypeError('Real submission response lost, cookie owner changed');}
  return response;
 },other=randomUUID();
 await assert.rejects(()=>runHttpQuality(f.base,input,{allow,fetchImpl:switchFetch,pollMs:10}),{code:'actor-changed'});assert.equal(submitted,1,'unknown submission is never carried to another actor');assert.ok(firstId);
 const originalDone=await until(async()=>{const response=await fetch(f.base+'/api/library/preparations/'+firstId,{headers:{cookie:'voidplayer-user='+firstActor,'x-voidplayer-actor':firstActor}});assert.equal(response.status,200);return response.json();},(j:any)=>!['queued','running','cancelling'].includes(j.state));assert.equal(originalDone.state,'completed');
 const trace:string[]=[],inMemoryInput={...input,key:'observe-'+randomUUID()},stopFetch=(url:any,opts:any)=>{trace.push(`${opts.method} ${new URL(url).pathname}`);return fetch(url,opts);};let preparationId='';
 await assert.rejects(()=>runHttpQuality(f.base,inMemoryInput,{allow,actor:f.actor,cookie:f.cookie,fetchImpl:stopFetch,pollMs:10,onObservation:({operation,value}:any)=>{if(operation==='library.preparation'){preparationId=value.id;return false;}return true;}}),{code:'observation-stopped'});
 assert.ok(preparationId);const completed=await until(()=>f.json('/api/library/preparations/'+preparationId),(j:any)=>!['queued','running','cancelling'].includes(j.state));assert.equal(completed.state,'completed');assert.ok(trace.every(s=>!s.includes('/cancel')));
 // No automatic replay permission: expose the frozen request, never credentials,
 // so even a later source/cache change cannot encourage a newly constructed key.
 let posts=0;const unknownFetch=async(url:any,opts:any)=>{const response=await fetch(url,opts);if(opts.method==='POST'&&new URL(url).pathname==='/api/quality/reference-relations'){posts++;await response.arrayBuffer();throw new TypeError('Committed relation acknowledgement lost');}return response;};
 const frozenInput={...input,key:'unknown-'+randomUUID()};await assert.rejects(()=>runHttpQuality(f.base,frozenInput,{actor:f.actor,cookie:f.cookie,allow:{plan:true},fetchImpl:unknownFetch}), (e:any)=>{assert.equal(e.code,'unknown-post-outcome');assert.equal(e.details.key,frozenInput.key+':relation.create');assert.equal(e.details.body.schema,'voidplayer-quality-reference-relation');assert.equal(e.details.actor,f.actor);assert.ok(!JSON.stringify(e.details).includes(f.cookie));return true;});assert.equal(posts,1);
});

test('incomplete 2xx acknowledgements retain the exact committed operation; known 4xx and actor changes do not replay',{timeout:120000},async t=>{
 const f=await nativeFixture({component:false,distorted:true});t.after(()=>f.close());
 const variants:Record<string,()=>Response>={
  empty201:()=>new Response(null,{status:201}),
  null201:()=>new Response('null',{status:201}),
  missingStructure:()=>new Response('{"relation":{},"replayed":false}',{status:201}),
  nonJson:()=>new Response('<html>unreadable acknowledgement</html>',{status:201}),
  truncated:()=>new Response('{"relation":',{status:201}),
  readFailure:()=>new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('{"relation":'));queueMicrotask(()=>controller.error(new TypeError('Controlled response stream failure')));}}),{status:201}),
  overBudget:()=>new Response(' '.repeat(4*1024*1024+1),{status:201}),
 };
 for(const [name,corrupt]of Object.entries(variants)){
  const input=inputFor(f),sent:any[]=[];let committed='';
  const fetchImpl=async(url:any,opts:any)=>{const response=await fetch(url,opts);if(opts.method==='POST'&&new URL(url).pathname==='/api/quality/reference-relations'){assert.ok(response.ok);committed=(await response.json()).relation.id;sent.push({body:opts.body,key:opts.headers['idempotency-key'],actor:opts.headers['x-voidplayer-actor']});return corrupt();}return response;};
  await assert.rejects(()=>runHttpQuality(f.base,input,{allow:{plan:true},actor:f.actor,cookie:f.cookie,fetchImpl}), (error:any)=>{
   assert.equal(error.code,'unknown-post-outcome',name);assert.equal(error.details.operation,'relation.create');assert.equal(error.details.actor,f.actor);assert.equal(error.details.key,sent[0].key);assert.equal(JSON.stringify(error.details.body),sent[0].body);assert.equal(error.details.replay,'idempotency-key');assert.ok(!JSON.stringify(error.details).includes(f.cookie));return true;
  });assert.equal(sent.length,1,name);assert.equal((await f.json('/api/quality/reference-relations/'+committed)).id,committed);
  // Resolve the original receipt with the same actor/body/key, using real HTTP.
  let replayBody='';const replayFetch=async(url:any,opts:any)=>{if(opts.method==='POST'&&new URL(url).pathname==='/api/quality/reference-relations')replayBody=opts.body;return fetch(url,opts);};
  const replay=await runHttpQuality(f.base,input,{allow:{plan:true},actor:f.actor,cookie:f.cookie,fetchImpl:replayFetch,pollMs:10});assert.equal(replay.plan.plan.relation.id,committed);assert.equal(replayBody,sent[0].body,name);
 }
 for(const kind of ['missingActor','wrongName','emptyValue','wrongActor']){
  const identityInput=inputFor(f);identityInput.identity.name='Incomplete identity '+kind;let identities=0,lostCookie='';
  const identityFetch=async(url:any,opts:any)=>{const response=await fetch(url,opts);if(opts.method==='POST'&&new URL(url).pathname==='/api/identity'){identities++;assert.equal(response.status,200);lostCookie=response.headers.get('set-cookie')!;const body=await response.json(),header=kind==='wrongName'?'wrong=garbage; Path=/; HttpOnly':kind==='emptyValue'?'voidplayer-user=; Path=/; HttpOnly':kind==='wrongActor'?'voidplayer-user=guest-'+randomUUID()+'; Path=/; HttpOnly':lostCookie;return new Response(JSON.stringify(kind==='missingActor'?{actor:{}}:body),{status:200,headers:{'set-cookie':header}});}return response;};
  await assert.rejects(()=>runHttpQuality(f.base,identityInput,{allow:{identity:true,plan:true,retryUnknown:true},fetchImpl:identityFetch}),(error:any)=>{assert.equal(error.code,'unknown-post-outcome',kind);assert.equal(error.details.actor,null);assert.equal(error.details.key,null);assert.equal(error.details.replay,'none');assert.deepEqual(error.details.body,identityInput.identity);assert.ok(!JSON.stringify(error.details).includes(lostCookie.split(';')[0]));return true;});assert.equal(identities,1,'invalid identity receipt is never automatically recreated');assert.equal((await (await fetch(f.base+'/api/users')).json()).users.filter((u:any)=>u.name===identityInput.identity.name).length,1);
 }
 for(const malformedError of [false,true]){
  const input=inputFor(f);input.clock.segments[0].referenceEndUs=0;let posts=0;
  const fetchImpl=async(url:any,opts:any)=>{const response=await fetch(url,opts);if(opts.method==='POST'&&new URL(url).pathname==='/api/quality/reference-relations'){posts++;assert.equal(response.status,400);if(malformedError){await response.arrayBuffer();return new Response('bad error body',{status:400});}}return response;};
  await assert.rejects(()=>runHttpQuality(f.base,input,{allow:{plan:true,retryUnknown:true},actor:f.actor,cookie:f.cookie,fetchImpl}),(error:any)=>{assert.equal(error.details.status,400);assert.notEqual(error.code,'unknown-post-outcome');return true;});assert.equal(posts,1,'known 4xx never enters automatic replay');
 }
 let switched=false,posts=0,original:any;const input=inputFor(f),other='guest-'+randomUUID();
 const switchFetch=async(url:any,opts:any)=>{const response=await fetch(url,{...opts,headers:{...opts.headers,...(switched?{cookie:'voidplayer-user='+other}:{})}});if(opts.method==='POST'&&new URL(url).pathname==='/api/quality/reference-relations'){assert.ok(response.ok);posts++;original={body:opts.body,key:opts.headers['idempotency-key']};await response.arrayBuffer();switched=true;return variants.empty201();}return response;};
 await assert.rejects(()=>runHttpQuality(f.base,input,{allow:{plan:true,retryUnknown:true},actor:f.actor,cookie:f.cookie,fetchImpl:switchFetch}),(error:any)=>{assert.equal(error.code,'actor-changed');assert.equal(error.details.originalRequest.actor,f.actor);assert.equal(error.details.originalRequest.key,original.key);assert.equal(JSON.stringify(error.details.originalRequest.body),original.body);assert.ok(!JSON.stringify(error.details).includes(f.cookie));return true;});assert.equal(posts,1,'bad 2xx receipt cannot carry a replay to the new actor');
});

test('malformed task/candidate acknowledgements safely replay one real job and one atomic candidate',{timeout:120000},async t=>{
 const f=await nativeFixture({component:false,distorted:true});t.after(()=>f.close());let cases=0;
 for(const [target,body]of [['job',''],['job',' '.repeat(4*1024*1024+1)],['candidate','{}'],['candidate','{"id":']]as const){
  const input=inputFor(f),sent:any[]=[];let originalId='';
  const fetchImpl=async(url:any,opts:any)=>{const path=new URL(url).pathname,response=await fetch(url,opts);if(opts.method==='POST'&&path===(target==='job'?'/api/quality/jobs':'/api/annotations/spaces/default')){assert.ok(response.ok);sent.push({body:opts.body,key:opts.headers['idempotency-key'],actor:opts.headers['x-voidplayer-actor']});if(sent.length===1){const accepted=await response.json();originalId=target==='job'?accepted.job.id:accepted.id;return new Response(body,{status:response.status});}}return response;};
  const report=await runHttpQuality(f.base,input,{allow,actor:f.actor,cookie:f.cookie,fetchImpl,pollMs:10});assert.equal(sent.length,2);assert.deepEqual(sent[0],sent[1],'replay is the original body/key/actor');assert.equal(originalId,target==='job'?report.job.id:report.annotations[0].id);assert.equal(report.annotations[0].revision,1);assert.equal(report.events.filter((e:any)=>e.id===input.candidate.id).length,1);
  const jobs=await f.json('/api/quality/jobs');assert.equal(new Set(jobs.entries.map((j:any)=>j.id)).size,++cases,'each acknowledged workflow created exactly one job');
 }
});

test('normal HTTP/HTTPS identity cookies with attributes bind the selected actor',{timeout:120000},async t=>{
 const f=await nativeFixture({component:false,start:async(config:any)=>{config.tls={hosts:['127.0.0.1']};config.httpPort=null;return startService(config,false);}});t.after(()=>f.close());
 for(const secure of [false,true]){
  const input=inputFor(f),base=secure?f.base.replace('http:','https:'):f.base;input.identity.name=secure?'HTTPS attributed client':'HTTP attributed client';let chosen='',setCookie='';
  const fetchImpl=async(url:any,opts:any)=>{
   const response=secure?await httpFetch(String(url),{...opts,ca:f.service.tls.ca}):await fetch(url,opts);
   if(new URL(url).pathname==='/api/identity'&&opts.method==='POST'){
    const body=await response.json();chosen=body.actor.id;setCookie=response.headers.get('set-cookie')!;assert.equal(setCookie.includes('; Secure'),secure);
    // Additional fields and an Expires comma must not hide the actual identity.
    const headers=new Headers(response.headers);headers.delete('set-cookie');headers.append('set-cookie','other=unrelated; Expires=Wed, 21 Oct 2037 07:28:00 GMT; Path=/');headers.append('set-cookie',setCookie);
    return new Response(JSON.stringify(body),{status:response.status,headers});
   }
   if(opts.method==='POST'){assert.equal(opts.headers.cookie,'voidplayer-user='+encodeURIComponent(chosen));assert.equal(opts.headers.origin,base);}
   return response;
  };
  const report=await runHttpQuality(base,input,{allow:{identity:true,plan:true},fetchImpl,pollMs:10});assert.equal(report.actor.id,chosen);assert.equal(report.plan.plan.actor.id,chosen);assert.equal(report.plan.plan.state,'completed');assert.ok(!JSON.stringify(report).includes(setCookie));
 }
});
