import assert from 'node:assert/strict';import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';import path from 'node:path';import {tmpdir} from 'node:os';import {execFileSync,spawn} from 'node:child_process';
import {nativeFixture,officialOracle,until} from '../test/helpers/native-vmaf.mjs';
import {trackChildShutdown} from './testing/lifecycle.mjs';
assert.equal(process.platform,'linux');assert.equal(process.arch,'x64');
const root=path.resolve(import.meta.dirname,'..'),archive=path.resolve(process.argv[2]??JSON.parse(await readFile(path.join(root,'artifacts/latest-release.json'),'utf8')).archive),temp=await mkdtemp(path.join(tmpdir(),'vp-native-vmaf-release-'));
try{
 execFileSync('tar',['-xzf',archive,'-C',temp]);const directory=path.join(temp,path.basename(archive,'.tar.gz')),release=JSON.parse(await readFile(path.join(directory,'release.json'),'utf8')),empty=path.join(temp,'empty');await mkdir(empty);
 const results=[];
 for(const depth of [8,10]){let f;try{
  f=await nativeFixture({depth,distorted:true,start:async config=>{
   await writeFile(path.join(config.dataDir,'voidplayer.config.json'),JSON.stringify({host:'127.0.0.1',port:0,mediaRoots:config.mediaRoots,indexWatch:false,logsDir:null,nativeVmaf:config.nativeVmaf}));
   const env={...process.env,PATH:empty};for(const k of Object.keys(env))if(k.startsWith('VOIDPLAYER_')||['BUN_OPTIONS','BUN_INSPECT','NODE_OPTIONS'].includes(k))delete env[k];
   const child=spawn(path.join(directory,release.executable),['--data-dir',config.dataDir],{cwd:empty,env,stdio:['ignore','pipe','pipe']}),stop=trackChildShutdown(child);let output='';child.stdout.on('data',b=>output=(output+b).slice(-65536));child.stderr.on('data',b=>output=(output+b).slice(-65536));
   try{const port=await until(()=>{if(child.exitCode!==null)throw Error(output);return Number(/媒体服务: http:\/\/127\.0\.0\.1:(\d+)/.exec(output)?.[1])||null;},Boolean,'Compiled VMAF startup');return {server:{address:()=>({port})},close:stop};}catch(e){await stop();throw e;}
  }});
  const capability=await f.json('/api/quality/vmaf/capability');assert.equal(capability.enabled,true,JSON.stringify(capability));assert.equal((await f.json('/api/agent')).capabilities.find(c=>c.id==='quality.vmaf').enabled,true);
  const created=await f.json('/api/quality/vmaf/jobs',f.input,'compiled-native'),j=await f.wait(created.job.id);assert.equal(j.state,'completed',JSON.stringify(j));const result=await f.json(`/api/quality/vmaf/jobs/${j.id}/result`),oracle=await officialOracle(f,depth);assert.deepEqual(result.vmaf.frames,oracle.result.frames.map(v=>({index:v.frameNum,score:v.metrics.vmaf})));assert.deepEqual(result.vmaf.pooled,oracle.result.pooled_metrics.vmaf);assert.equal(result.raw.referenceSha256,oracle.hashes[0]);assert.equal(result.raw.distortedSha256,oracle.hashes[1]);
  const p=await f.json(`/api/quality/vmaf/jobs/${j.id}/candidates`,{space:'default',side:'reference',maxScore:100,limit:1,minFrameDistance:1,text:'Compiled native sequence candidate',severity:2});assert.equal(p.createdIds.length,1);const a=await f.json('/api/annotations/spaces/default/'+p.createdIds[0]);assert.equal(a.document.mark.qualityEvidence[0].value.execution.runtime,'bun');assert.equal(a.document.mark.qualityEvidence[0].value.sequenceVmaf.recipe.bitDepth,depth);results.push({depth,frames:result.vmaf.frames.length,component:result.vmaf.component,resources:result.vmaf.resources,pooled:result.vmaf.pooled});
 }finally{await f?.close();}}
 const report=path.resolve(process.env.VOIDPLAYER_TEST_ARTIFACTS??'.run/native-vmaf/compiled');await mkdir(report,{recursive:true});await writeFile(path.join(report,'results.json'),JSON.stringify({target:release.target,emptyPath:true,results},null,2));console.log('PASS compiled Linux x64 Bun + installed fixed native component, 8/10-bit official sequence oracle, candidate evidence, empty PATH');
}finally{await rm(temp,{recursive:true,force:true});}
