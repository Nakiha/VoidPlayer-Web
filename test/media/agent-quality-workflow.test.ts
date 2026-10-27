import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
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
  plan:{interval:{startAu:0,endAu:mode==='single'?0:mode==='range'?2:7},sampling:{mode:'all'},recipe:{roi:{x:0,y:0,width:mode==='vmaf'?128:32,height:mode==='vmaf'?96:32},ssim:{variant:'ffmpeg-uniform-8x8-step4-v1'},...(mode==='vmaf'?{}:{spatial:{blockWidth:16,blockHeight:16}}),budget:{maxReadBytes:1048576,maxInputBytes:1048576}},budget:{maxReadBytes:32*1048576,maxInputBytes:32*1048576,maxPackets:4096,maxOutputFrames:4096,maxElapsedMs:120000},planningBudget:{maxIndexBytes:1048576,maxIndexPackets:4096,maxElapsedMs:30000}},
  vmaf:{model:'vmaf_v0_6_1',cadenceUs:250000,metrics:{psnr:true,ssim:true},budget:{maxRawBytes:8*1048576,maxElapsedMs:120000,nativeCpuSeconds:30,nativeMemoryBytes:512*1048576}},
  candidate:mode==='single'?{space:'default',side:'reference',id:randomUUID(),operationId:randomUUID(),text:'Explicit HTTP measurement candidate',severity:3}:mode==='range'?{space:'default',side:'reference',metric:'psnr',maxDb:120,limit:1,minAuDistance:1,text:'Explicit HTTP range candidate',severity:3}:{space:'default',side:'reference',maxScore:100,limit:1,minFrameDistance:1,text:'Explicit HTTP VMAF candidate',severity:3}};
}

for(const [mode,containers]of [['single',['flv','flv']],['range',['mp4','flv']],['vmaf',['flv','mp4']]]as const)test(`cold HTTP from llms.txt, no frontend: ${mode} ${containers.join('→')}`,{timeout:120000,skip:mode==='vmaf'&&(process.platform!=='linux'||process.arch!=='x64')},async t=>{
 const f=await nativeFixture({prepare:false,distorted:true,containers,component:mode==='vmaf',staticDir:'public'});t.after(()=>f.close());
 const input=inputFor(f,mode),trace:{method:string;path:string;key:string|null;body:string|undefined}[]=[],lost={prepare:false,compute:false,candidate:false};
 const fetchImpl=async(url:any,options:any)=>{
  const path=new URL(url).pathname,method=options?.method??'GET';trace.push({method,path,key:options?.headers?.['idempotency-key']??null,body:options?.body});
  const response=await fetch(url,options);
  // Consume the real accepted/committed response, then lose its acknowledgement.
  const kind=path==='/api/library/preparations'?'prepare':path==='/api/quality/jobs'||path.endsWith('/execute')||path==='/api/quality/vmaf/jobs'?'compute':path.endsWith('/candidates')||path==='/api/annotations/spaces/default'?'candidate':null;
  if(method==='POST'&&kind&&!lost[kind]&&response.ok){lost[kind]=true;await response.arrayBuffer();throw new TypeError('test transport loss after real server commit');}
  return response;
 };
 const before=await runHttpQuality(f.base,input,{fetchImpl});assert.equal(trace[0].path,'/llms.txt');assert.ok(trace.every(r=>r.method==='GET'),'default authorizes no writes, including identity selection');assert.equal((await fetch(f.base)).status,404);assert.ok(before.next.length);
 const unprepared=await f.request(`/api/media/${input.reference.id}/psnr-source?v=${input.reference.version}`);assert.equal(unprepared.status,409);assert.equal((await unprepared.json()).code,'cache-miss');
 const report=await runHttpQuality(f.base,input,{allow,fetchImpl,pollMs:10});assert.equal(report.job.job?.state??report.job.state,'completed');assert.equal(report.annotations.length,1);assert.ok(report.events.some((e:any)=>e.id===report.annotations[0].id));
 const evidence=report.annotations[0].document.mark.qualityEvidence[0];assert.equal(evidence.verification,'server-verified');assert.equal(evidence.value.result.ssim.variant,'ffmpeg-uniform-8x8-step4-v1');assert.equal(evidence.value.result.metric.roi.width,mode==='vmaf'?128:32);assert.equal(evidence.value.result.provenance.reference.mediaId,input.reference.id);
 assert.deepEqual(lost,{prepare:true,compute:true,candidate:true});
 for(const path of new Set(trace.filter(r=>r.method==='POST').map(r=>r.path))){const rows=trace.filter(r=>r.method==='POST'&&r.path===path);if(rows.length===2&&path!=='/api/library/preparations'){assert.equal(rows[0].body,rows[1].body);assert.equal(rows[0].key,rows[1].key);}}
 if(mode==='single'){assert.ok(report.result.value.result.metric.aggregate.sse>0);assert.equal(report.result.value.result.metric.spatial.blocks.length,4);}
 if(mode==='range'){assert.equal(report.job.coverage.complete,true);assert.equal(report.results.length,3);assert.equal(report.job.job.summary.scoredPairs,3);}
 if(mode==='vmaf'){const oracle=await officialOracle(f,8);assert.deepEqual(report.result.vmaf.frames,oracle.result.frames.map((v:any)=>({index:v.frameNum,score:v.metrics.vmaf})));assert.deepEqual(report.result.vmaf.pooled,oracle.result.pooled_metrics.vmaf);assert.equal(report.frames.length,8);}
 // The same attributed actor and stable original input replay all receipts, without
 // preparing, planning or computing again; changed identity creation is not repeated.
 const replayInput={...input,identity:{id:report.actor.id}},replay=await runHttpQuality(f.base,replayInput,{allow,pollMs:10});assert.equal(replay.job.job?.id??replay.job.id,report.job.job?.id??report.job.id);assert.deepEqual(replay.publication.createdIds,report.publication.createdIds);assert.equal(replay.annotations[0].revision,1);
 const other='guest-'+randomUUID(),jobId=mode==='range'?report.job.job.id:report.job.id,path=mode==='single'?'/api/quality/jobs/':mode==='range'?'/api/quality/ranges/':'/api/quality/vmaf/jobs/';assert.equal((await fetch(f.base+path+jobId,{headers:{cookie:'voidplayer-user='+other,'x-voidplayer-actor':other}})).status,404);
 console.log(JSON.stringify({mode,containers,jobId,candidate:report.publication.createdIds[0],requests:report.requests,unknownResponseReplays:lost,noFrontend:true}));
});

test('HTTP prerequisites: unknown metadata, cache miss, missing native, changed source and actor stop safely',{timeout:120000},async t=>{
 const f=await nativeFixture({prepare:false,component:false,staticDir:'public'});t.after(()=>f.close());const input=inputFor(f),seen:string[]=[];
 const fetchImpl=async(url:any,options:any)=>{seen.push(`${options?.method??'GET'} ${new URL(url).pathname}`);return fetch(url,options);};
 const unknown=await runHttpQuality(f.base,{query:{codec:'h264',includeUnknown:'1',limit:'1'}},{fetchImpl});assert.equal(unknown.discovery.length,2);assert.ok(unknown.discovery.some((e:any)=>e.decision.state==='unknown'));
 const cli=await promisify(execFile)(process.execPath,['examples/http-quality.mjs',f.base],{timeout:30000,maxBuffer:1048576});const cliReport=JSON.parse(cli.stdout);assert.equal(cliReport.discovery.length,2);assert.deepEqual(cliReport.writesAuthorized,[]);
 const missing=await runHttpQuality(f.base,input,{allow:{identity:true},fetchImpl});assert.equal(missing.reason,'cache-miss');assert.ok(missing.next[0].endsWith('library.prepare'));assert.ok(!seen.includes('POST /api/library/preparations'));
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
