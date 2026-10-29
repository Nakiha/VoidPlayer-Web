import {retimeQualityMp4} from './quality-clock-fixture.mjs';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,readFile,writeFile,copyFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';import path from 'node:path';import {createHash,randomUUID} from 'node:crypto';import {execFileSync} from 'node:child_process';import {gunzipSync} from 'node:zlib';
import {loadConfig} from '../../server/config.ts';import {startService} from '../../server/runtime.ts';
import {waitForAnnotationMedia} from '../../scripts/testing/agent-annotations-ready.mjs';
export const sha=b=>createHash('sha256').update(b).digest('hex');
export const until=async(read,predicate,label='Native VMAF did not finish')=>{for(const deadline=performance.now()+60000;performance.now()<deadline;){const r=await read();if(predicate(r))return r;await new Promise(r=>setTimeout(r,10));}assert.fail(label);};
export async function nativeComponent(){const directory=path.resolve(process.env.VOIDPLAYER_VMAF_COMPONENT??'.run/components/vmaf');return {directory,manifestSha256:sha(await readFile(path.join(directory,'manifest.json')))};}
export async function nativeFixture({depth=8,distorted=false,staticDir='public',start=startService,component=false,frames=8,tagged=true,codec=depth===10?'hevc':'h264',containers=['flv','flv'],prepare=true,frameRate,roi,sequence=false}={}){
 const directory=await mkdtemp(path.join(tmpdir(),'vp-native-vmaf-')),media=path.join(directory,'media');await mkdir(media);let service;
 try{
  const sample=JSON.parse(await readFile(new URL(sequence?'./analysis-quality-sequence.json':'./native-vmaf-samples.json',import.meta.url),'utf8')).samples.find(s=>s.codec===codec&&s.depth===depth&&s.tagged===tagged);assert.ok(sample,'Committed fixture missing');
  if(sequence){frames=sample.frames;frameRate=sample.rate;containers=['mp4','mp4'];}
  assert.equal(frames,sample.frames);assert.equal(containers.length,2);assert.ok(containers.every(c=>['flv','mp4'].includes(c)));const oracles={},names=['reference','distorted'].map((name,i)=>name+'.'+containers[i]);
  const mp4=sequence?sample:containers.includes('mp4')?JSON.parse(await readFile(new URL('./native-vmaf-mp4-samples.json',import.meta.url),'utf8')).samples.find(s=>s.codec===codec&&s.depth===depth):null;
  for(const [ordinal,name]of ['reference','distorted'].entries()){
   const item=sample[distorted?name:'reference'];
   if(item.rawGzip){const raw=gunzipSync(Buffer.from(item.rawGzip,'base64'),{maxOutputLength:1048576});assert.equal(sha(raw),item.rawSha256);oracles[name]=raw;}
   if(containers[ordinal]==='mp4'){const item=mp4[distorted?name:'reference'],encoded=Buffer.from(item.mp4,'base64');assert.equal(sha(encoded),item.mp4Sha256);await writeFile(path.join(media,names[ordinal]),frameRate&&!sequence?retimeQualityMp4(encoded,frameRate):encoded);}
   else {const bytes=Buffer.from(item.flv,'base64');assert.equal(sha(bytes),item.flvSha256);await writeFile(path.join(media,names[ordinal]),bytes);}
  }
  const config=await loadConfig([],'production',directory,{staticDir:path.resolve(staticDir),dataDir:path.join(directory,'data'),allowEmptyRoots:true});Object.assign(config,{logsDir:null,mediaRoots:[media],indexWatch:false,port:0,...(component?{nativeVmaf:await nativeComponent()}: {})});
  service=await start(config,false);await service.library?.refresh();const base=`http://127.0.0.1:${service.server.address().port}`,actor='guest-'+randomUUID(),cookie='voidplayer-user='+actor,headers={cookie,origin:base,'content-type':'application/json','x-voidplayer-action':'quality-job','x-voidplayer-actor':actor};
  let entries;if(service.library)entries=await waitForAnnotationMedia(service.library,names);else entries=await until(async()=>{const list=(await fetch(base+'/api/library').then(r=>r.json())).entries;return names.map(name=>list.find(e=>e.name===name));},e=>e.every(v=>v?.state==='ready'),'Compiled library not ready');
  const request=async(url,body,key='vmaf-test',extra={})=>fetch(base+url,{method:body===undefined?'GET':'POST',headers:{...headers,'idempotency-key':key,...extra},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const json=async(url,body,key,extra)=>{const r=await request(url,body,key,extra);assert.ok(r.ok,`${r.status}: ${await r.clone().text()}`);return r.json();};
  const fixture={directory,media,config,service,entries,base,actor,cookie,headers,request,json,oracles,containers,sample,wait:id=>until(()=>json('/api/quality/vmaf/jobs/'+id),j=>!['queued','preparing','running','cancelling'].includes(j.state)),async stop(){const prior=service;service=undefined;await prior?.close();},async close(){await service?.close();await rm(directory,{recursive:true,force:true});}};
  if(!prepare)return fixture;
  const bindings=[];
  if(containers.includes('mp4'))for(const e of entries)assert.equal((await request(`/api/media/${e.id}/psnr-source?v=${e.version}`)).status,409);
  for(const e of entries){
   if(containers.includes('mp4')){
    const discovery=await json(`/api/library/discovery?search=${encodeURIComponent(e.name)}&includeUnknown=1&limit=32`);assert.ok(discovery.entries.some(x=>x.source.id===e.id&&x.source.version===e.version));
    const accepted=await json('/api/library/preparations',{source:{id:e.id,version:e.version},operation:'quality-index',client:{id:'native-vmaf-mp4',name:'Native MP4 VMAF test'}},'prepare-'+e.id,{'x-voidplayer-action':'library-preparation'});
    const done=await until(()=>json('/api/library/preparations/'+accepted.job.id),j=>!['queued','running','cancelling'].includes(j.state),'Explicit quality preparation');assert.equal(done.state,'completed',JSON.stringify(done));bindings.push(done.result.binding);
   }else{const r=await json(`/api/media/${e.id}/psnr-index`,{version:e.version},e.id,{'x-voidplayer-action':'quality-source-build'});bindings.push(r.binding);}
  }
  const client={id:'native-vmaf-test',kind:'agent'},relation=(await json('/api/quality/reference-relations',{schema:'voidplayer-quality-reference-relation',version:1,client,reference:{mediaId:entries[0].id,mediaVersion:entries[0].version,stream:'video',configuration:0},distorted:{mediaId:entries[1].id,mediaVersion:entries[1].version,stream:'video',configuration:0},declaration:'Explicit test relation; not a content certificate',clock:{mode:'piecewise-exact-source-pts-offset',segments:[{id:'same',referenceStartUs:0,referenceEndUs:10000000,offsetUs:0}]}},'relation')).relation;
  const planInput={schema:'voidplayer-quality-correspondence-plan',version:1,client,relation:{id:relation.id,revision:1},referenceBuildId:bindings[0].indexBuildId,distortedBuildId:bindings[1].indexBuildId,interval:{startAu:0,endAu:frames-1},sampling:{mode:'all'},recipe:{roi:roi??{x:0,y:0,width:sample.width,height:sample.height},budget:{maxReadBytes:1048576,maxInputBytes:1048576}},budget:{maxReadBytes:Math.max(32,frames)*1048576,maxInputBytes:Math.max(32,frames)*1048576,maxPackets:Math.max(4096,frames*128),maxOutputFrames:Math.max(4096,frames*128),maxElapsedMs:120000},planningBudget:{maxIndexBytes:1048576,maxIndexPackets:4096,maxElapsedMs:30000}};
  const plan=(await json('/api/quality/correspondence-plans',planInput,'plan')).plan,done=await until(()=>json('/api/quality/correspondence-plans/'+plan.id),r=>!['queued','running'].includes(r.plan.state),'C plan');assert.equal(done.plan.state,'completed',JSON.stringify(done));
  const input={schema:'voidplayer-native-vmaf-job',version:1,client,plan:{id:plan.id,attemptId:done.plan.attemptId,digest:done.plan.resultDigest},model:'vmaf_v0_6_1',cadenceUs:frameRate?Math.round(frameRate.ticks/frameRate.timescale*1000000):250000,...(frameRate?{cadence:frameRate}:{}),metrics:{psnr:true,ssim:true},budget:{maxRawBytes:Math.max(8*1048576,sample.width*sample.height*3/2*(depth===8?1:2)*frames*2),maxElapsedMs:120000,nativeCpuSeconds:30,nativeMemoryBytes:512*1048576}};
  return {...fixture,bindings,input,planInput};
 }catch(e){await service?.close();await rm(directory,{recursive:true,force:true});throw e;}
}
export async function officialOracle(f,depth,model='vmaf_v0_6_1'){
 const {officialQualityCase}=await import('./official-quality-oracle.mjs');
 const hashes=['reference','distorted'].map(name=>sha(f.oracles[name]));
 const c=await officialQualityCase('vmaf',...hashes,model==='vmaf_v0_6_1'?'vmaf_v0.6.1':'vmaf_v0.6.1neg');
 return {hashes,result:{frames:c.frames.map((score,frameNum)=>({frameNum,metrics:{vmaf:score}})),pooled_metrics:{vmaf:c.pooled}}};
}
