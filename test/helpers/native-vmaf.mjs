import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,readFile,writeFile,copyFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';import path from 'node:path';import {createHash,randomUUID} from 'node:crypto';import {execFileSync} from 'node:child_process';
import {loadConfig} from '../../server/config.ts';import {startService} from '../../server/runtime.ts';
import {waitForAnnotationMedia} from '../../scripts/testing/agent-annotations-ready.mjs';
export const sha=b=>createHash('sha256').update(b).digest('hex');
export const until=async(read,predicate,label='Native VMAF did not finish')=>{for(let n=0;n<1200;n++){const r=await read();if(predicate(r))return r;await new Promise(r=>setTimeout(r,10));}assert.fail(label);};
export async function nativeComponent(){const directory=path.resolve(process.env.VOIDPLAYER_VMAF_COMPONENT??'.run/components/vmaf');return {directory,manifestSha256:sha(await readFile(path.join(directory,'manifest.json')))};}
export async function nativeFixture({depth=8,distorted=false,staticDir='public',start=startService,component=true,frames=8,tagged=true}={}){
 const directory=await mkdtemp(path.join(tmpdir(),'vp-native-vmaf-')),media=path.join(directory,'media');await mkdir(media);let service;
 try{
  for(const name of ['reference','distorted']){
   const ten=depth===10;const params=`open-gop=0:scenecut=0${tagged?':colorprim=bt709:transfer=bt709:colormatrix=bt709:chromaloc=0':''}${ten?':pools=1:frame-threads=1:log-level=error':''}`;
   execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i',`testsrc2=size=128x96:rate=4:duration=${frames/4}`,'-an','-vf',`setsar=1${distorted&&name==='distorted'?',eq=contrast=0.8:brightness=0.04':''}`,'-c:v',ten?'libx265':'libx264','-threads','1','-g','4','-bf','2','-sc_threshold','0',ten?'-x265-params':'-x264-params',params,'-pix_fmt',ten?'yuv420p10le':'yuv420p',...(tagged?['-color_primaries','bt709','-color_trc','bt709','-colorspace','bt709','-color_range','tv','-chroma_sample_location','left']:[]),'-f','flv',path.join(media,name+'.flv')]);
  }
  const config=await loadConfig([],'production',directory,{staticDir:path.resolve(staticDir),dataDir:path.join(directory,'data'),allowEmptyRoots:true});Object.assign(config,{logsDir:null,mediaRoots:[media],indexWatch:false,port:0,...(component?{nativeVmaf:await nativeComponent()}: {})});
  service=await start(config,false);await service.library?.refresh();const base=`http://127.0.0.1:${service.server.address().port}`,actor='guest-'+randomUUID(),cookie='voidplayer-user='+actor,headers={cookie,origin:base,'content-type':'application/json','x-voidplayer-action':'quality-job','x-voidplayer-actor':actor};
  let entries;if(service.library)entries=await waitForAnnotationMedia(service.library,['reference.flv','distorted.flv']);else entries=await until(async()=>{const list=(await fetch(base+'/api/library').then(r=>r.json())).entries;return ['reference.flv','distorted.flv'].map(name=>list.find(e=>e.name===name));},e=>e.every(v=>v?.state==='ready'),'Compiled library not ready');
  const request=async(url,body,key='vmaf-test',extra={})=>fetch(base+url,{method:body===undefined?'GET':'POST',headers:{...headers,'idempotency-key':key,...extra},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const json=async(url,body,key,extra)=>{const r=await request(url,body,key,extra);assert.ok(r.ok,`${r.status}: ${await r.clone().text()}`);return r.json();};
  const bindings=[];
  for(const e of entries){const r=await json(`/api/media/${e.id}/psnr-index`,{version:e.version},e.id,{'x-voidplayer-action':'quality-source-build'});bindings.push(r.binding);}
  const client={id:'native-vmaf-test',kind:'agent'},relation=(await json('/api/quality/reference-relations',{schema:'voidplayer-quality-reference-relation',version:1,client,reference:{mediaId:entries[0].id,mediaVersion:entries[0].version,stream:'video',configuration:0},distorted:{mediaId:entries[1].id,mediaVersion:entries[1].version,stream:'video',configuration:0},declaration:'Explicit test relation; not a content certificate',clock:{mode:'piecewise-exact-source-pts-offset',segments:[{id:'same',referenceStartUs:0,referenceEndUs:10000000,offsetUs:0}]}},'relation')).relation;
  const planInput={schema:'voidplayer-quality-correspondence-plan',version:1,client,relation:{id:relation.id,revision:1},referenceBuildId:bindings[0].indexBuildId,distortedBuildId:bindings[1].indexBuildId,interval:{startAu:0,endAu:frames-1},sampling:{mode:'all'},recipe:{roi:{x:0,y:0,width:128,height:96},budget:{maxReadBytes:1048576,maxInputBytes:1048576}},budget:{maxReadBytes:32*1048576,maxInputBytes:32*1048576,maxPackets:4096,maxOutputFrames:4096,maxElapsedMs:120000},planningBudget:{maxIndexBytes:1048576,maxIndexPackets:4096,maxElapsedMs:30000}};
  const plan=(await json('/api/quality/correspondence-plans',planInput,'plan')).plan,done=await until(()=>json('/api/quality/correspondence-plans/'+plan.id),r=>!['queued','running'].includes(r.plan.state),'C plan');assert.equal(done.plan.state,'completed',JSON.stringify(done));
  const input={schema:'voidplayer-native-vmaf-job',version:1,client,plan:{id:plan.id,attemptId:done.plan.attemptId,digest:done.plan.resultDigest},model:'vmaf_v0_6_1',cadenceUs:250000,metrics:{psnr:true,ssim:true},budget:{maxRawBytes:8*1048576,maxElapsedMs:120000,nativeCpuSeconds:30,nativeMemoryBytes:512*1048576}};
  return {directory,media,config,service,entries,bindings,base,actor,cookie,headers,input,planInput,request,json,wait:id=>until(()=>json('/api/quality/vmaf/jobs/'+id),j=>!['queued','preparing','running','cancelling'].includes(j.state)),async stop(){const prior=service;service=undefined;await prior?.close();},async close(){await service?.close();await rm(directory,{recursive:true,force:true});}};
 }catch(e){await service?.close();await rm(directory,{recursive:true,force:true});throw e;}
}
export async function officialOracle(f,depth,model='vmaf_v0_6_1'){
 const {directory}=await nativeComponent(),out=path.join(f.directory,'official');await mkdir(out,{recursive:true});
 const hashes=[];for(const name of ['reference','distorted']){const raw=path.join(out,name+'.yuv');execFileSync('ffmpeg',['-v','error','-i',path.join(f.media,name+'.flv'),'-map','0:v:0','-f','rawvideo','-pix_fmt',depth===8?'yuv420p':'yuv420p10le',raw]);hashes.push(sha(await readFile(raw)));}
 await copyFile(path.join(directory,model==='vmaf_v0_6_1'?'vmaf_v0.6.1.json':'vmaf_v0.6.1neg.json'),path.join(out,'model.json'));
 execFileSync(path.join(directory,'vmaf'),['--reference','reference.yuv','--distorted','distorted.yuv','--width','128','--height','96','--pixel_format','420','--bitdepth',String(depth),'--model','path=model.json:name=vmaf','--threads','1','--cpumask','0','--json','--output','result.json','--quiet'],{cwd:out});return {hashes,result:JSON.parse(await readFile(path.join(out,'result.json'),'utf8'))};
}
