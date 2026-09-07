import test from 'node:test';
import assert from 'node:assert/strict';
import { rgbaDescription, validateDescription } from '../src/frame-description.ts';
import { readWasmFrame } from '../src/wasm-frame.ts';
test('frame boundary rejects invalid allocation, stride and crop before presentation',()=>{
  const description=rgbaDescription(256,128);
  assert.doesNotThrow(()=>validateDescription(description,256*128*4));
  for(const d of [{...description,stride:128*4},{...description,byteLength:128*128*4},{...description,width:0},{...description,visibleRect:{x:1,y:0,width:256,height:128}}])assert.throws(()=>validateDescription(d,256*128*4));
});
test('WASM ABI validates version and signed size before allocating or reading pixels',()=>{
  const memory=new Uint8Array(1024);const view=new DataView(memory.buffer,8,72);
  const core={ccall(name:string){return name==='vp_frame_info'?8:name==='vp_pixels'?128:'yuv420p';}};
  assert.throws(()=>readWasmFrame(core,()=>memory,1),/版本/);
  view.setUint32(16,1,true);view.setUint32(20,72,true);
  for(const [offset,value] of [[24,2],[28,2],[32,8],[36,16],[60,1],[64,1],[68,1]])view.setInt32(offset,value,true);
  const frame=readWasmFrame(core,()=>memory,1);assert.equal(frame.pixels.byteLength,16);
  view.setInt32(36,-1,true);assert.throws(()=>readWasmFrame(core,()=>memory,1),/长度/);
  view.setInt32(36,16,true);view.setInt32(24,1000000,true);assert.throws(()=>readWasmFrame(core,()=>memory,1),/跨度/);
});
