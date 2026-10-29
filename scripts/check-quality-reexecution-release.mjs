// Real packaged executable only; this driver has no access to its job services.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import path from 'node:path';
import {execFileSync,spawn} from 'node:child_process';import {createServer} from 'node:net';
import {nativeFixture,until} from '../test/helpers/native-vmaf.mjs';
import {xpsnrComponent} from '../test/helpers/native-xpsnr.mjs';
import {trackChildShutdown} from './testing/lifecycle.mjs';
const archive=path.resolve(process.argv[2]??JSON.parse(await readFile('artifacts/latest-release.json','utf8')).archive),temp=await mkdtemp(path.join(tmpdir(),'vp-reexecution-release-')),native=process.platform==='linux'&&process.arch==='x64',rows=[];
try{
 const tar=process.platform==='win32'?path.join(process.env.SystemRoot,'System32','tar.exe'):'tar';execFileSync(tar,['-xzf',archive,'-C',temp]);const directory=path.join(temp,path.basename(archive,'.tar.gz')),release=JSON.parse(await readFile(path.join(directory,'release.json'),'utf8')),empty=path.join(temp,'empty');await mkdir(empty);
 for(const kind of native?['single','range','vmaf','xpsnr']:['single','range','vmaf']){let f;try{
  f=await nativeFixture({distorted:true,component:false,containers:['mp4','flv'],start:async config=>{
   if(kind==='xpsnr')config.nativeXpsnr=await xpsnrComponent();
   const socket=createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));await mkdir(config.dataDir,{recursive:true});await writeFile(path.join(config.dataDir,'voidplayer.config.json'),JSON.stringify({host:'127.0.0.1',port,mediaRoots:config.mediaRoots,indexWatch:false,logsDir:null,...(kind==='xpsnr'?{nativeXpsnr:config.nativeXpsnr}:{})}));
   const env={...process.env,PATH:empty};for(const key of Object.keys(env))if(key.startsWith('VOIDPLAYER_')||['BUN_OPTIONS','BUN_INSPECT','NODE_OPTIONS'].includes(key))delete env[key];const child=spawn(path.join(directory,release.executable),['--data-dir',config.dataDir],{cwd:empty,env,stdio:['ignore','pipe','pipe']}),stop=trackChildShutdown(child);let output='';child.stdout.on('data',b=>output=(output+b).slice(-65536));child.stderr.on('data',b=>output=(output+b).slice(-65536));try{await until(async()=>{if(child.exitCode!==null)throw Error(output);return fetch(`http://127.0.0.1:${port}/api/ready`).then(r=>r.ok).catch(()=>false);},Boolean,'Compiled startup');return {server:{address:()=>({port})},close:stop};}catch(e){await stop();throw e;}
  }});
  if(kind==='xpsnr'){const {model,...input}=f.input;f.input={...input,schema:'voidplayer-native-xpsnr-job',recipe:'ffmpeg-xpsnr-reference-first-temporal-v1'};}
  const frozen=await f.json('/api/quality/correspondence-plans/'+f.input.plan.id+'/range-input'),collection=kind==='single'?'/api/quality/jobs':kind==='range'?'/api/quality/ranges':'/api/quality/'+kind+'/jobs';
  const original=(await f.json(collection,kind==='single'?{schema:'voidplayer-psnr-frame-job',version:1,client:{id:'compiled-reexecution',kind:'agent'},request:frozen.pairs[0]}:kind==='range'?frozen:f.input,'compiled-original')).job,url=collection+'/'+original.id;
  const read=async(id=original.id)=>{const v=await f.json(collection+'/'+id);return kind==='range'?v.job:v;};
  // Poll a factual published contract, then explicitly cancel the real execution.
  // There is no sleep, retry-on-success or product deadline adjustment.
  await until(async()=>{const j=await read();assert.notEqual(j.state,'completed','The controlled cancellation must reach live computation');if(kind==='range'&&j.samples[0])return (await f.json('/api/quality/jobs/'+j.samples[0].jobId)).executionContract;return j.executionContract;},Boolean,'Compiled executor witness');
  await f.json(url+'/cancel',{});const stopped=await until(()=>read(),j=>['cancelled','partial','failed'].includes(j.state),'Compiled physical stop');const before=JSON.stringify(stopped),reason='Explicit compiled full recomputation';
  const plan=await f.json(url+'/reexecution-plan',{reason});assert.equal(plan.eligible,true,JSON.stringify(plan));assert.equal(plan.contract.environment.runtime,'bun');assert.equal(plan.contract.environment.producerBuild.kind,'compiled-content');
  const request={schema:'voidplayer-quality-reexecution',version:1,reason,planDigest:plan.digest,confirm:plan.cost},accepted=await f.json(url+'/reexecutions',request,'compiled-frozen-reexecution');assert.notEqual(accepted.job.id,original.id);assert.equal(accepted.job.retryOf.generation,2);assert.equal((await f.json(url+'/reexecutions',request,'compiled-frozen-reexecution')).job.id,accepted.job.id);
  const result=await until(()=>read(accepted.job.id),j=>!['queued','preparing','running','cancelling'].includes(j.state),'Compiled full recomputation');assert.equal(result.state,'completed',JSON.stringify(result));assert.equal(JSON.stringify(await read()),before);assert.equal((await f.json(url+'/reexecutions')).successor.id,result.id);if(kind==='single')assert.equal(result.attempt.number,1);
  const details=await f.json('/api/tasks/'+kind+'/'+original.id);assert.ok(details.related.some(r=>r.relation==='reexecution'&&r.id===result.id));
  rows.push({kind,original:stopped.state,successor:result.state,generation:result.retryOf.generation,producerBuild:plan.contract.environment.producerBuild});
 }finally{await f?.close();}}
 const out=path.resolve(process.env.VOIDPLAYER_TEST_ARTIFACTS??'.run/reexecution/compiled');await mkdir(out,{recursive:true});await writeFile(path.join(out,'reexecution.json'),JSON.stringify({target:release.target,emptyPath:true,rows},null,2));console.log(JSON.stringify({passed:true,target:release.target,reexecution:rows}));
}finally{await rm(temp,{recursive:true,force:true});}
