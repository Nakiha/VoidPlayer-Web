import { test } from 'node:test';
import assert from 'node:assert/strict';
import { containerFromHeader, probeContainer } from '../src/container-probe.ts';
import { openMediaPlan } from '../src/media-policy.ts';
import { MediaOpenError } from '../src/media-errors.ts';
import type { MediaOpenPlan } from '../src/media-policy.ts';
import type { MediaSource } from '../src/media.ts';

test('container routing is byte-based for local and remote inputs, including renamed TS/FLV', async () => {
  const cases: Array<[Uint8Array, string]> = [[new Uint8Array([70,76,86,1,1,0,0,0,9]),'flv'],
    [new Uint8Array([0,0,0,24,102,116,121,112]),'isobmff'], [new Uint8Array([1,2,3]),'other']];
  for (const [stride, start] of [[188,0],[192,4],[204,0]]) { const b=new Uint8Array(1024); for(let i=0;i<3;i++)b[start+stride*i]=0x47; cases.push([b,'mpegts']); }
  const saved=globalThis.fetch;
  try { for (const [bytes,kind] of cases) {
    assert.equal(containerFromHeader(bytes),kind);
    assert.equal(await probeContainer({file:new Blob([new Uint8Array(bytes)])}),kind);
    globalThis.fetch=async(_url,init)=>{assert.equal(new Headers(init?.headers).get('range'),`bytes=0-${bytes.length-1}`); return new Response(new Uint8Array(bytes),{status:206,headers:{'content-range':`bytes 0-${bytes.length-1}/${bytes.length}`}});};
    assert.equal(await probeContainer({url:'https://example.invalid/renamed.mp4',size:bytes.length}),kind);
  }} finally {globalThis.fetch=saved;}
});

function source(decoder='webcodecs') {
  let disposed=0;
  const value={info:{decoder},frameAt:async()=>{throw Error('unused');},framesAfter:async()=>[],async *framesFrom(){},dispose(){disposed++;}} as unknown as MediaSource;
  return {value,disposed:()=>disposed};
}
function plan(overrides:Partial<MediaOpenPlan>):MediaOpenPlan {
  return {meta:{name:'clip',size:1,lastModified:0},input:{file:new Blob(['x'])},reference:false,softwareOnly:false,depth:2,
    native:async()=>source().value,software:async()=>source('ffmpeg-wasm').value,...overrides};
}
test('all adapter plans share preference and stage-based fallback, without an input/resource retry',async()=>{
  for(const stage of ['input','resource','container','codec','decode'] as const){
    let software=0;const error=new MediaOpenError(stage,'probe failure');
    const opening=openMediaPlan(plan({native:async()=>{throw error;},software:async()=>{software++;return source('ffmpeg-wasm').value;}}));
    if(stage==='input'||stage==='resource'){await assert.rejects(opening,e=>e===error);assert.equal(software,0);}
    else{const s=await opening;assert.equal(s.info.decoder,'ffmpeg-wasm');assert.equal(software,1);s.dispose();}
  }
  let native=0,software=0;
  const s=await openMediaPlan(plan({reference:true,softwareOnly:true,native:async()=>{native++;throw Error('must skip');},software:async()=>{software++;return source('ffmpeg-wasm').value;}}));
  assert.equal(native,0);assert.equal(software,1);s.dispose();
});
test('a cancelled open releases a late source exactly once and never selects another decoder',async()=>{
  const controller=new AbortController(),s=source();let resolve!:(s:MediaSource)=>void,software=0;
  const pending=openMediaPlan(plan({signal:controller.signal,native:()=>new Promise(r=>resolve=r),software:async()=>{software++;throw Error('unused');}}));
  controller.abort(new DOMException('cancelled','AbortError'));await assert.rejects(pending,/cancelled/);
  resolve(s.value);await new Promise(r=>setTimeout(r,0));assert.equal(s.disposed(),1);assert.equal(software,0);
});
