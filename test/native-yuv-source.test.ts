import {test} from 'node:test';
import assert from 'node:assert/strict';
import {nativeYuvSource,verifyNativeWitness} from '../src/native-yuv-source.ts';
import {rgbaDescription} from '../src/frame-description.ts';
import type {DecodedFrame,MediaSource} from '../src/media.ts';

const color={matrix:'bt709',primaries:'bt709',transfer:'bt709',fullRange:false};
function raw(semiplanar=false):DecodedFrame{
 const pixels=new Uint8ClampedArray([10,20,30,40,100,120]);
 return {ptsUs:0,sourcePtsUs:0,durationUs:1,width:2,height:2,byteSize:6,kind:'yuv',pixels,close(){},description:rgbaDescription(2,2,{format:semiplanar?'NV12':'YUV',byteLength:6,color,yuv:{bitDepth:8,bitShift:0,subsampleX:1,subsampleY:1,semiplanar,chromaLocation:1,planes:semiplanar?[{offset:0,stride:2,width:2,height:2},{offset:4,stride:2,width:1,height:1}]:[{offset:0,stride:2,width:2,height:2},{offset:4,stride:1,width:1,height:1},{offset:5,stride:1,width:1,height:1}]}})};
}
function geometryFrame(codedWidth:number,codedHeight:number,visibleWidth:number,visibleHeight:number):DecodedFrame{
 const chromaWidth=Math.ceil(codedWidth/2),chromaHeight=Math.ceil(codedHeight/2),lumaBytes=codedWidth*codedHeight,chromaBytes=chromaWidth*chromaHeight;
 const pixels=new Uint8ClampedArray(lumaBytes+chromaBytes*2);
 const description=rgbaDescription(visibleWidth,visibleHeight,{codedWidth,codedHeight,visibleRect:{x:0,y:0,width:visibleWidth,height:visibleHeight},
  stride:null,format:'YUV',byteLength:pixels.byteLength,color,yuv:{bitDepth:8,bitShift:0,subsampleX:1,subsampleY:1,semiplanar:false,chromaLocation:1,
   planes:[{offset:0,stride:codedWidth,width:codedWidth,height:codedHeight},
    {offset:lumaBytes,stride:chromaWidth,width:chromaWidth,height:chromaHeight},
    {offset:lumaBytes+chromaBytes,stride:chromaWidth,width:chromaWidth,height:chromaHeight}]}});
 return {ptsUs:0,sourcePtsUs:0,durationUs:1,width:visibleWidth,height:visibleHeight,byteSize:pixels.byteLength,kind:'yuv',pixels,description,close(){}};
}
test('native witness compares every YUV component independent of packing, and rejects content or color differences',()=>{
 const a=raw(true),b=raw();verifyNativeWitness(a,b);
 a.pixels![5]++;assert.throws(()=>verifyNativeWitness(a,b),/核对/);a.pixels![5]--;
 a.description.color={...color,fullRange:true};assert.throws(()=>verifyNativeWitness(a,b),/核对/);
});
test('native witness accepts coded padding when the visible rectangle and visible planes match',()=>{
 const native=geometryFrame(544,960,540,960),reference=geometryFrame(540,960,540,960);
 const nativeY=native.description.yuv!.planes[0],nativeU=native.description.yuv!.planes[1],nativeV=native.description.yuv!.planes[2];
 for(let row=0;row<960;row++)for(let col=540;col<544;col++)native.pixels![nativeY.offset+row*nativeY.stride+col]=99;
 for(let row=0;row<480;row++)for(let col=270;col<272;col++){
  native.pixels![nativeU.offset+row*nativeU.stride+col]=77;
  native.pixels![nativeV.offset+row*nativeV.stride+col]=88;
 }
 verifyNativeWitness(native,reference);
 native.pixels![nativeY.offset+959*nativeY.stride+539]++;
 assert.throws(()=>verifyNativeWitness(native,reference),/可见样本不一致/);
});
test('native pipeline preserves order under out-of-order copies and drains cancellation',async()=>{
 const original=globalThis.Worker;let active=0,peak=0,terminated=0,closed=0;
 class FakeWorker{
  onmessage?: (e:{data:unknown})=>void;onerror?:()=>void;timer?:ReturnType<typeof setTimeout>;
  postMessage({frame}:{frame:{pts:number;close():void}}){active++;peak=Math.max(peak,active);this.timer=setTimeout(()=>{active--;frame.close();this.onmessage?.({data:{buffer:new ArrayBuffer(6),layout:[{offset:0,stride:2},{offset:4,stride:2}]}});},frame.pts%2?1:10);}
  terminate(){terminated++;clearTimeout(this.timer);}
 }
 globalThis.Worker=FakeWorker as unknown as typeof Worker;
 function frame(pts:number):DecodedFrame{return {...raw(true),ptsUs:pts,sourcePtsUs:pts,kind:'video-sample',sample:{rotation:0,toVideoFrame:()=>({pts,close(){}})} as unknown as DecodedFrame['sample'],close(){closed++;}};}
 const capability={hasSize:true,hasDts:true};
 const source={info:{},getAnalysisCapability(){assert.equal(this,source);return capability;},frameAt:async(pts:number)=>frame(pts),async *framesFrom(){for(let i=0;i<9;i++)yield frame(i);},dispose(){}} as unknown as MediaSource;
 const wrapped=nativeYuvSource(source,2,1);
 try{
  assert.equal(wrapped.getAnalysisCapability?.(),capability,'readback wrapper retains packet analysis and its receiver');
  const pts=[];for await(const f of wrapped.framesFrom(0)){pts.push(f.ptsUs);assert.equal(f.description.yuv?.chromaLocation,1);f.close();}
  assert.deepEqual(pts,[0,1,2,3,4,5,6,7,8]);assert.equal(peak,2);
  const iterator=wrapped.framesFrom(0);const first=await iterator.next();first.value!.close();await iterator.return(undefined);assert.equal(active,0);
  const pending=wrapped.frameAt(0);wrapped.dispose();await assert.rejects(pending,/释放/);assert.equal(terminated,2);assert.ok(closed>=12);
 }finally{wrapped.dispose();globalThis.Worker=original;}
});
