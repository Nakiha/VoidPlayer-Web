import test from 'node:test';
import assert from 'node:assert/strict';
import {chromaOffset,yuvReconstructedSample,type YuvLayout} from '../src/yuv-color.ts';
test('chroma reconstruction respects left/center siting and clamps to valid samples',()=>{
 const l:YuvLayout={bitDepth:8,bitShift:0,subsampleX:1,subsampleY:1,semiplanar:false,chromaLocation:1,planes:[{offset:0,stride:4,width:4,height:2},{offset:8,stride:2,width:2,height:1},{offset:10,stride:2,width:2,height:1}]};
 const data=new Uint8Array([100,100,100,100,100,100,100,100,64,192,128,128]);
 assert.equal(yuvReconstructedSample(data,l,1,1,0),128);
 assert.equal(yuvReconstructedSample(data,{...l,chromaLocation:2},1,1,0),96);
 assert.equal(yuvReconstructedSample(data,l,1,3,1),192);
 assert.equal(yuvReconstructedSample(data,{...l,chromaLocation:2},1,0,0),64);
 assert.deepEqual([1,2,3,4,5,6].map(n=>chromaOffset({...l,chromaLocation:n})),[[0,.5],[.5,.5],[0,0],[.5,0],[0,1],[.5,1]]);
});
