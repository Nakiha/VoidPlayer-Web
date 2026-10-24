// Actual compiled Bun Worker and local file source, with no decoder executable in PATH.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
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
 const samples=JSON.parse(await readFile(path.join(root,'test/helpers/quality-http-samples.json'),'utf8')).samples.filter(s=>s.tagged);
 for(const sample of samples){const bytes=Buffer.from(sample.flv,'base64');assert.equal(createHash('sha256').update(bytes).digest('hex'),sample.flvSha256);await writeFile(path.join(media,`${sample.codec}-${sample.depth}.flv`),bytes);}
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
 let entries;await waitUntil(async()=>{entries=(await fetch(base+'/api/library').then(r=>r.json())).entries;return samples.every(s=>entries.some(e=>e.name===`${s.codec}-${s.depth}.flv`&&e.state==='ready'));},'Native quality library did not settle');
 const cookie=`voidplayer-user=guest-${randomUUID()}`,headers={cookie,origin:base,'content-type':'application/json','x-voidplayer-action':'quality'},rows=[];
 for(const sample of samples){
  const entry=entries.find(e=>e.name===`${sample.codec}-${sample.depth}.flv`);
  const built=await fetch(`${base}/api/media/${entry.id}/frame-index?v=${entry.version}&build=1`);assert.equal(built.status,200);const cache=await built.json();assert.equal(cache.index.packets.length,2);
  const lookup=await fetch(`${base}/api/media/${entry.id}/psnr-source?v=${entry.version}`,{headers:{cookie}});const binding=await lookup.json();assert.equal(lookup.status,200,JSON.stringify(binding));
  const target=au=>({...binding.binding,sourcePtsUs:cache.index.packets[au][2],picture:{sourceVersion:`${entry.id}@${entry.version}`,stream:'video',configuration:0,au,picture:0,layer:0,field:'frame'}});
  const request={pairing:'caller-specified',reference:target(0),distorted:target(1),roi:{x:2,y:4,width:24,height:20}};
  const response=await fetch(base+'/api/quality/psnr-pair',{method:'POST',headers,body:JSON.stringify(request)}),value=await response.json();assert.equal(response.status,200,JSON.stringify(value));
  assert.equal(value.execution.runtime,'bun');assert.equal(value.execution.host,'node-worker');assert.equal(value.execution.runtimeVersion,manifest.runtime.version);assert.equal(value.result.metric.bitDepth,sample.depth);
  assert.equal(value.result.decoder.buildId,manifest.decoder.source.revision);assert.deepEqual(value.sources.reference,binding);assert.deepEqual(value.sources.distorted,binding);
  const raw=Buffer.from(sample.native,'base64');assert.equal(createHash('sha256').update(raw).digest('hex'),sample.nativeSha256);
  const bytes=sample.depth===8?1:2,frame=1536*bytes;let aggregate=0;
  for(const [i,name] of ['y','u','v'].entries()){
   const width=i?16:32,offset=[0,1024,1280][i],scale=i?2:1;let sse=0,samples=0;
   for(let y=4/scale;y<24/scale;y++)for(let x=2/scale;x<26/scale;x++){
    const at=(offset+y*width+x)*bytes,a=bytes===1?raw[at]:raw.readUInt16LE(at),b=bytes===1?raw[frame+at]:raw.readUInt16LE(frame+at);sse+=(a-b)**2;samples++;
   }
   assert.equal(value.result.metric.planes[name].sse,sse);assert.equal(value.result.metric.planes[name].samples,samples);aggregate+=sse;
  }
  assert.equal(value.result.metric.aggregate.sse,aggregate);assert.ok(aggregate>0);assert.equal(value.request.actorId,cookie.slice('voidplayer-user='.length));assert.equal(value.request.id,response.headers.get('x-request-id'));rows.push({request,requestId:value.request.id,codec:sample.codec,depth:sample.depth,sse:aggregate,decoder:value.result.decoder,source:binding,execution:value.execution});
 }
 await stopChild();stopChild=null;await start();
 const first=rows[0],entry=entries.find(e=>e.name===`${first.codec}-${first.depth}.flv`);
 const rebound=await fetch(`${base}/api/media/${entry.id}/psnr-source?v=${entry.version}`,{headers:{cookie}});assert.equal(rebound.status,200);assert.deepEqual(await rebound.json(),first.source,'restart retains the actual server producer/cache binding');
 const rerun=await fetch(base+'/api/quality/psnr-pair',{method:'POST',headers,body:JSON.stringify(first.request)}),again=await rerun.json();assert.equal(rerun.status,200,JSON.stringify(again));assert.equal(again.result.metric.aggregate.sse,first.sse);assert.notEqual(again.request.id,first.requestId,'a fresh one-shot execution is not a cached task result');
 const capabilities=await fetch(base+'/api/agent',{headers:{cookie}}).then(r=>r.json());assert.equal(capabilities.capabilities.find(c=>c.id==='quality.jobs').implemented,false);assert.equal(capabilities.capabilities.find(c=>c.id==='quality.frame-pair').requiresBrowser,false);
 const report=path.resolve(process.env.VOIDPLAYER_TEST_ARTIFACTS??path.join(root,'.run/quality-release'));await mkdir(report,{recursive:true});await writeFile(path.join(report,'native-quality.json'),JSON.stringify({target:manifest.target,rows},null,2)+'\n');
 console.log(`PASS ${manifest.target}: compiled Bun quality Worker, real library/cache HTTP, 8/10-bit native SSE/provenance, producer restart, empty PATH`);
}finally{if(stopChild)await stopChild();await rm(temp,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
