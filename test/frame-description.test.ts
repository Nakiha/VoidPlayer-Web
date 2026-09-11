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
  const memory=new Uint8Array(1024);const view=new DataView(memory.buffer,8,160);
  const core={ccall(name:string){return name==='vp_frame_info'?8:name==='vp_pixels'?256:'yuv420p';}};
  assert.throws(()=>readWasmFrame(core,()=>memory,1),/版本/);
  view.setUint32(16,2,true);view.setUint32(20,160,true);
  for(const [offset,value] of [[24,2],[28,2],[32,8],[36,16],[60,1],[64,1],[68,1]])view.setInt32(offset,value,true);
  const frame=readWasmFrame(core,()=>memory,1);assert.equal(frame.pixels.byteLength,16);
  view.setInt32(36,-1,true);assert.throws(()=>readWasmFrame(core,()=>memory,1),/长度/);
  view.setInt32(36,16,true);view.setInt32(24,1000000,true);assert.throws(()=>readWasmFrame(core,()=>memory,1),/跨度/);
});

test('resource accounting preserves copy sizes and only tolerates unsupported pixel access', async () => {
  const { videoFrameDescription } = await import('../src/frame-description.ts');
  const frame = { codedWidth: 32, codedHeight: 16, displayWidth: 32, displayHeight: 16, visibleRect: null,
    format: 'NV12', colorSpace: {}, allocationSize: () => 768 } as unknown as VideoFrame;
  assert.equal(videoFrameDescription(frame).byteLength, 768);
  assert.equal(videoFrameDescription(frame).byteLengthEstimated, false);
  frame.allocationSize = () => { throw new DOMException('unsupported', 'NotSupportedError'); };
  assert.equal(videoFrameDescription(frame).byteLength, 32 * 16 * 8);
  frame.allocationSize = () => { throw new DOMException('closed', 'InvalidStateError'); };
  assert.throws(() => videoFrameDescription(frame), /closed/);
});

test('presentation uses delivered color, distinguishes unsupported software HDR, and resets on SDR', async () => {
  const { presentationColor } = await import('../src/presentation-color.ts');
  const hdr = { primaries: 'bt2020', transfer: 'pq', matrix: 'bt2020-ncl', fullRange: false };
  const sdr = { primaries: 'bt709', transfer: 'bt709', matrix: 'rgb', fullRange: true };
  for (const transfer of ['pq', 'hlg']) {
    const description = rgbaDescription(2, 2, { format: null, color: { ...hdr, transfer } });
    assert.equal(presentationColor('video-sample', description).conversion, 'canvas2d-srgb');
    assert.equal(presentationColor('video-sample', description).opaque, true);
    assert.equal(presentationColor('rgba8', { ...description, format: 'RGBA' }).unsupportedHdr, true);
  }
  const converted = rgbaDescription(2, 2, { color: sdr, sourceColor: hdr });
  assert.equal(presentationColor('video-sample', converted).canvasConversion, false, 'source HDR must not relabel converted resources');
  assert.equal(presentationColor('rgba8', converted).conversion, 'rgba8-hdr-unmanaged');
  assert.equal(presentationColor('video-sample', rgbaDescription(2, 2, { color: sdr })).conversion, 'browser-default');
});

test('ABI v2 reads plane layout before string ccall grows the WASM heap',()=>{
  let memory=new Uint8Array(512);const view=new DataView(memory.buffer,8,160);
  view.setUint32(16,2,true);view.setUint32(20,160,true);
  for(const [offset,value]of [[24,2],[28,2],[36,6],[60,1],[64,1],[68,1],[72,1],[76,8],[84,1],[88,1],[96,0],[100,2],[104,2],[108,2],[112,4],[116,1],[120,1],[124,1],[128,5],[132,1],[136,1],[140,1]])view.setInt32(offset,value,true);
  memory.set([16,235,16,235,128,128],256);
  const core={ccall(name:string){
    if(name==='vp_frame_info')return 8;if(name==='vp_pixels')return 256;
    const old=memory;memory=new Uint8Array(1024);memory.set(old);structuredClone(old.buffer,{transfer:[old.buffer]});return 'yuv420p';
  }};
  const frame=readWasmFrame(core,()=>memory,1);
  assert.equal(frame.description.yuv!.planes.length,3);assert.deepEqual([...new Uint8Array(frame.pixels)],[16,235,16,235,128,128]);
});
