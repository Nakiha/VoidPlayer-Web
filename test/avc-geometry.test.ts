import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Input,BlobSource,ALL_FORMATS} from 'mediabunny';
import {avcGeometry,nativeAvcCompatible} from '../src/avc-geometry.ts';
for(const [file,interlaced,reorder,height] of [
  ['h264--h264_4bf_pyramid_nobsrestriction.mp4',false,null,240],
  ['h264--interlaced_crop.mp4',true,2,360],
] as const)test(`AVC native capability is based on actual SPS geometry/reorder: ${file}`,async()=>{
  const input=new Input({source:new BlobSource(new Blob([await readFile(new URL('../fixtures/fate/'+file,import.meta.url))])),formats:ALL_FORMATS});
  try{
    const description=(await(await input.getPrimaryVideoTrack())!.getDecoderConfig())!.description!;
    const bytes=ArrayBuffer.isView(description)?new Uint8Array(description.buffer,description.byteOffset,description.byteLength):new Uint8Array(description);
    const geometry=avcGeometry(bytes)!;assert.equal(geometry.interlaced,interlaced);assert.equal(geometry.maxReorderFrames,reorder);assert.equal(geometry.height,height);assert.equal(nativeAvcCompatible(geometry),false);
    for(let i=0;i<bytes.length-4;i++)assert.equal(avcGeometry(bytes.subarray(0,i)),null);
  }finally{input.dispose();}
});
