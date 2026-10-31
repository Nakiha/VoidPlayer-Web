import {test} from 'node:test';
import assert from 'node:assert/strict';
import {NativePictureInputs,nativeConfigurationHex} from '../../shared/media/codecs/native-picture-identity.ts';
import {rgbaDescription} from '../../shared/media/frame-description.ts';
import {ReviewSession} from '../../src/session.ts';
import type {MediaSource,DecodedFrame} from '../../src/media/contract.ts';
const packet=(au=0)=>({au,configuration:0,pts:2000000+au*40000,dts:2000000+au*40000,offset:100+au*100,size:32,configurationHex:'1'.repeat(16)});
test('native accepted input membership is single use, epoch separated, bounded and fail closed',()=>{
 const q=new NativePictureInputs(2);q.reset();q.accepted(0,packet());const first=q.output(0)!;assert.equal(first.au,0);assert.equal(first.epoch,1);
 assert.equal(q.output(0),undefined);q.accepted(40000,packet(1));assert.equal(q.output(40000),undefined);
 q.reset();q.accepted(0,packet());q.accepted(0,packet(1));assert.equal(q.output(0),undefined);
 q.reset();q.accepted(0,packet());q.accepted(40000,packet(1));q.accepted(80000,packet(2));assert.equal(q.output(0),undefined);
 q.reset();q.accepted(0,packet());assert.equal(q.output(40000),undefined);assert.equal(q.output(0),undefined);
 q.reset();q.accepted(0,undefined);q.accepted(40000,packet(1));assert.equal(q.output(40000),undefined);
 q.reset();q.accepted(0,packet());const next=q.output(0)!;assert.ok(next.epoch>first.epoch);assert.equal(next.pts,first.pts);
 q.reset();q.accepted(0,packet());q.accepted(40000,{...packet(1),configurationHex:'22'});assert.equal(q.output(0),undefined);
 assert.notEqual(nativeConfigurationHex(Uint8Array.of(1,2)),nativeConfigurationHex(Uint8Array.of(1,3)));
});
function source(instance:string,options:{native?:boolean;wrongClock?:boolean}={}) {
 const id='a'.repeat(24),version='b'.repeat(24);let reads=0;const frames:DecodedFrame[]=[];
 const frame=(pts:number):DecodedFrame=>{const au=Math.floor(pts/40000),p=packet(au);if(options.wrongClock)p.pts++;
  const result:DecodedFrame={ptsUs:au*40000,sourcePtsUs:2000000+au*40000,durationUs:40000,description:rgbaDescription(32,32),kind:'video-sample',width:32,height:32,byteSize:4096,
   sourcePicture:{sourceVersion:`${id}@${version}`,stream:'video',configuration:0,au,picture:0,layer:0,field:'frame'},
   ...(options.native!==false?{nativePresentedInput:{instance,sourceVersion:`${id}@${version}`,input:{protocol:'webcodecs-associated-chunk-v1' as const,epoch:1,...p}}}:{}),close(){}};
  frames.push(result);return result;
 };
 const value:MediaSource={nativePresentedInstance:instance,nativePresentedTransport:{source:{kind:'library',id,url:`http://localhost/api/media/${id}?v=${version}`},sourceVersion:`${id}@${version}`},info:{id,name:'native.flv',size:1000,lastModified:0,codec:'h264',decoder:'webcodecs',width:32,height:32,firstPtsUs:2000000,durationUs:120000,source:{kind:'library',id,url:`http://localhost/api/media/${id}?v=${version}`}},
  async frameAt(t){return frame(t);},async framesAfter(t,n){return [40000,80000].filter(x=>x>t).slice(0,n).map(frame);},async *framesFrom(t){for(const p of [0,40000,80000].filter(x=>x>=t))yield frame(p);},
  async getBitstreamFlvIndex(){reads++;throw Error('Implicit full index is forbidden');},dispose(){}};
 return {value,frames,get reads(){return reads;}};
}
test('paused capture follows successful paint, never prefetch, legacy tags, PTS retagging or another instance',async()=>{
 let commit=0;const session=new ReviewSession((_slot,frame)=>{frame.presentedCommit=++commit;});const a=source('first');
 try{await session.load('A',async()=>a.value);const first=session.captureNativePresented('A');assert.equal(first.binding,'unbound');assert.equal(first.input.au,0);
  const prefetched=await a.value.frameAt(80000);prefetched.close();assert.deepEqual(session.captureNativePresented('A'),first);assert.equal(a.reads,0);
  a.value.info.decoder='ffmpeg-wasm';assert.throws(()=>session.captureNativePresented('A'),/identity/);a.value.info.decoder='webcodecs';
  const forged=structuredClone(first);forged.input.au=1;assert.equal(session.isNativePresentedCurrent(forged),false);
  await session.seek(40000);assert.equal(session.isNativePresentedCurrent(first),false);assert.equal(session.captureNativePresented('A').input.au,1);
  const b=source('replacement');await session.load('A',async()=>b.value);const second=session.captureNativePresented('A');assert.equal(second.sourceVersion,first.sourceVersion);assert.notEqual(second.instance,first.instance);assert.ok(second.sourceGeneration>first.sourceGeneration);assert.equal(session.isNativePresentedCurrent(first),false);
  b.value.info.source!.url=b.value.info.source!.url.replace('b'.repeat(24),'c'.repeat(24));assert.throws(()=>session.captureNativePresented('A'),/identity/);
 }finally{await session.dispose();}assert.throws(()=>session.captureNativePresented('A'));
 for(const options of [{native:false},{wrongClock:true}]){const s=new ReviewSession((_slot,f)=>{f.presentedCommit=1;});try{await s.load('A',async()=>source('invalid',options).value);assert.throws(()=>s.captureNativePresented('A'),/identity/);}finally{await s.dispose();}}
});
test('a failed/no-op draw cannot create a new presented native identity',async()=>{
 let mode:'paint'|'fail'|'noop'='paint';const session=new ReviewSession((_slot,f)=>{if(mode==='fail')throw Error('paint failed');if(mode==='paint')f.presentedCommit=(f.presentedCommit??0)+1;});
 try{await session.load('A',async()=>source('draw').value);assert.equal(session.captureNativePresented('A').input.au,0);
  mode='fail';await assert.rejects(session.seek(40000),/paint failed/);assert.throws(()=>session.captureNativePresented('A'));
  mode='noop';await session.seek(80000);assert.throws(()=>session.captureNativePresented('A'));
 }finally{await session.dispose();}
});

test('native library transport rejects lineage, foreign origins and ambiguous URL/version labels',async()=>{
 const {nativeLibraryTransport}=await import('../../shared/review/native-presented-frame.ts');
 const id='a'.repeat(24),version='b'.repeat(24),origin='http://localhost',ref={origin,id,version},url=`/api/media/${id}?v=${version}`;
 assert.equal(nativeLibraryTransport(url,ref,origin)?.sourceVersion,`${id}@${version}`);
 for(const bad of [`https://foreign.test${url}`,url.replace(id,'c'.repeat(24)),url+'&v='+version,url+'&build=1',url+'#frame',url.replace(version,'c'.repeat(24))])assert.equal(nativeLibraryTransport(bad,ref,origin),undefined,bad);
 assert.equal(nativeLibraryTransport(url,{...ref,origin:'https://foreign.test'},origin),undefined);
 const local=source('lineage');delete (local.value as {nativePresentedTransport?:unknown}).nativePresentedTransport;
 const session=new ReviewSession((_slot,f)=>{f.presentedCommit=1;});try{await session.load('A',async()=>local.value);assert.throws(()=>session.captureNativePresented('A'),/identity/);}finally{await session.dispose();}
});
