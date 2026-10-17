import type { PacketDecodeIndex } from '../../shared/media/indexing/packet-decode-index.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {PacketTimeline} from '../../src/packet-timeline.ts';
import type {PacketDecoder,FlvFrame} from '../../src/flv-decoder.ts';
import type {FlvIndex} from '../../shared/media/containers/flv-demux.ts';
import {rgbaDescription} from '../../shared/media/frame-description.ts';
import { buildFlvIndex } from '../../shared/media/containers/flv-demux.ts';

test('equal-PTS outputs are released; seek across a duplicate key packet matches continuous playback', async () => {
  const packets = [0, 40, 40, 80].map((pts, offset) => ({ pts, dts: offset * 20, offset, size: 1, key: offset === 0 || offset === 2 }));
  const index = buildFlvIndex('hevc', new Uint8Array([0]), packets);
  const ready: FlvFrame[] = [], sent: number[] = [], closed: number[] = [];
  const decoder: PacketDecoder = { kind: 'webcodecs', reset() { ready.splice(0).forEach(f => f.frame!.close()); }, close() { this.reset(); },
    async drain() {}, receive() { return ready.shift() ?? null; },
    async send(_bytes, p) { sent.push(p.offset); ready.push({ pts: p.pts, width: 2, height: 2, pixels: new Uint8Array([p.offset]).buffer,
      description: rgbaDescription(2, 2), frame: { close() { closed.push(p.offset); } } as VideoFrame }); } };
  const timeline = new PacketTimeline(index, decoder, async () => new Uint8Array(1));
  try {
    (await timeline.at(0)).frame!.close();
    const first = (await timeline.next(0))!;
    assert.equal(new Uint8Array(first.pixels!)[0], 1); first.frame!.close();
    const next = (await timeline.next(40))!; assert.equal(next.pts, 80); next.frame!.close();
    assert.ok(closed.includes(2)); assert.deepEqual(sent, [0, 1, 2, 3]);
    assert.equal(await timeline.next(80), null);
    for (const target of [40, 60, 40]) {
      const frame = await timeline.at(target);
      assert.equal(new Uint8Array(frame.pixels!)[0], 1); frame.frame!.close();
    }
  } finally { timeline.close(); }
});
function fixture(){
  const closed:number[]=[],configurations:number[]=[];
  const f=(pts:number):FlvFrame=>({pts,width:4,height:4,description:rgbaDescription(4,4),frame:{close(){closed.push(pts);}} as VideoFrame});
  const index:FlvIndex={codec:'h264',description:new Uint8Array([0]),configurations:[new Uint8Array([0]),new Uint8Array([1])],packets:[
    {pts:0,dts:0,key:true,offset:100,size:1,configuration:0},
    {pts:40000,dts:40000,key:true,offset:200,size:1,configuration:1},
  ],order:[0,1],firstPts:0,duration:80000,durations:[40000,40000]};
  let pending:FlvFrame[]=[],ready:FlvFrame[]=[];
  const decoder:PacketDecoder={kind:'webcodecs',async reconfigure(c){configurations.push(c.description[0]);},reset(){pending.splice(0).forEach(f=>f.frame!.close());ready.splice(0).forEach(f=>f.frame!.close());},
    async send(_bytes,p){pending.push(...(p.pts===0?[f(0),f(20000)]:[f(40000)]));},receive(){return ready.shift()??null;},async drain(){ready.push(...pending.splice(0));},close(){this.reset();}};
  return {timeline:new PacketTimeline(index,decoder,async()=>new Uint8Array(1)),closed,configurations};
}
test('display timeline preserves multi-image packet outputs, drains configuration boundaries, and seeks by actual output PTS',async()=>{
  const {timeline,configurations}=fixture();
  try{
    const first=await timeline.at(0);assert.equal(first.pts,0);first.frame!.close();
    const extra=await timeline.next(0);assert.equal(extra?.pts,20000);extra!.frame!.close();
    const next=await timeline.next(20000);assert.equal(next?.pts,40000);next!.frame!.close();
    assert.equal(await timeline.next(40000),null);
    const floor=await timeline.at(30000);assert.equal(floor.pts,20000);floor.frame!.close();
    const following=await timeline.next(20000);assert.equal(following?.pts,40000);following!.frame!.close();
    const back=await timeline.at(0);assert.equal(back.pts,0);back.frame!.close();
    assert.ok(configurations.includes(1));assert.ok(configurations.includes(0));
  }finally{timeline.close();}
});
test('seek releases skipped and exact-hit predecessors and close releases lookahead',async()=>{
  const {timeline,closed}=fixture();
  const exact=await timeline.at(20000);assert.ok(closed.includes(0));exact.frame!.close();
  const floor=await timeline.at(30000);floor.frame!.close();timeline.close();assert.ok(closed.includes(40000));
});
test('next after an unrelated seek discards lookahead from the old display position',async()=>{
  const {timeline}=fixture();
  try{
    const floor=await timeline.at(30000);floor.frame!.close();
    const earlier=await timeline.next(0);assert.equal(earlier?.pts,20000);earlier!.frame!.close();
    const last=await timeline.at(40000);last.frame!.close();
    const beforeStart=await timeline.next(-1);assert.equal(beforeStart?.pts,0);beforeStart!.frame!.close();
    const later=await timeline.next(20000);assert.equal(later?.pts,40000);later!.frame!.close();
  }finally{timeline.close();}
});

test('output arriving during packet IO defers submission without advancing the packet cursor', async () => {
  const ready: FlvFrame[] = [], accepted: number[] = [];
  const frame = (pts: number): FlvFrame => ({ pts, width: 4, height: 4, description: rgbaDescription(4, 4), pixels: new ArrayBuffer(64) });
  const index: FlvIndex = { codec: 'h264', description: new Uint8Array(), packets: [
    { pts: 0, dts: 0, key: true, offset: 0, size: 1 }, { pts: 40000, dts: 40000, key: false, offset: 1, size: 1 },
  ], order: [0, 1], firstPts: 0, duration: 80000, durations: [40000, 40000] };
  let delivered = false;
  const decoder: PacketDecoder = { kind: 'webcodecs', reset() {}, close() {}, async drain() {}, receive() { return ready.shift() ?? null; },
    async send(_bytes, packet) { if (ready.length) return false; accepted.push(packet.pts); if (packet.pts) ready.push(frame(packet.pts)); } };
  const timeline = new PacketTimeline(index, decoder, async packet => {
    if (packet.offset === 1 && !delivered) { delivered = true; ready.push(frame(0)); }
    return new Uint8Array(1);
  });
  try {
    assert.equal((await timeline.at(0)).pts, 0);
    assert.equal((await timeline.next(0))?.pts, 40000);
    assert.equal(await timeline.next(40000), null);
    assert.deepEqual(accepted, [0, 40000]);
  } finally { timeline.close(); }
});


test('a growing decode frontier waits without drain/reset and resumes at the same packet cursor', async () => {
  const ready: FlvFrame[] = []; let resets = 0, drains = 0;
  const packets = [0, 40000, 80000].map((pts, offset) => ({ pts, dts: pts, key: offset === 0, offset, size: 1 }));
  const index: FlvIndex = { codec: 'h264', description: new Uint8Array(), packets: packets.slice(0, 1), order: [0], firstPts: 0, duration: 40000, durations: [40000] };
  const sent: number[] = [];
  const decoder: PacketDecoder = { kind: 'webcodecs', reset() { resets++; }, close() {}, async drain() { drains++; }, receive() { return ready.shift() ?? null; },
    async send(_bytes, p) { sent.push(p.pts); ready.push({ pts: p.pts, width: 2, height: 2, description: rgbaDescription(2, 2), pixels: new ArrayBuffer(16) }); } };
  const timeline = new PacketTimeline(index, decoder, async () => new Uint8Array(1));
  let release!: () => void;
  timeline.setGrowth(() => new Promise<void>(resolve => { release = resolve; }));
  try {
    assert.equal((await timeline.at(0)).pts, 0);
    const pending = timeline.next(0); let settled = false; void pending.then(() => { settled = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false); assert.equal(drains, 0);
    timeline.appendIndex({ ...index, packets, order: [0, 1, 2], duration: 120000, durations: [40000, 40000, 40000] });
    timeline.setGrowth(); release();
    assert.equal((await pending)?.pts, 40000);
    assert.equal((await timeline.next(40000))?.pts, 80000);
    assert.equal(await timeline.next(80000), null);
    assert.equal(resets, 1); assert.equal(drains, 1);
    assert.deepEqual(sent, [0, 40000, 80000]);
  } finally { timeline.close(); }
});

test('a recovery boundary drains the prefix, resets even without a config change, and isolates seeks',async()=>{
 const {timeline,closed}=fixture();
 const index:PacketDecodeIndex={...timeline.index,configurations:undefined,packets:timeline.index.packets.map((p,i)=>({...p,configuration:undefined,...(i?{discontinuity:true}:{})}))};
 timeline.replaceIndex(index);let resets=0;
 const reset=timeline.decoder.reset.bind(timeline.decoder);timeline.decoder.reset=()=>{resets++;reset();};
 try{
  (await timeline.at(0)).frame!.close();assert.equal(resets,1);
  const delayed=await timeline.next(0);assert.equal(delayed?.pts,20000);delayed!.frame!.close();
  assert.equal(resets,1,'delayed prefix output is consumed before reset');
  const resumed=await timeline.next(20000);assert.equal(resumed?.pts,40000);resumed!.frame!.close();assert.equal(resets,2);
  assert.equal(await timeline.next(40000),null);
  (await timeline.at(40000)).frame!.close();assert.equal(resets,3);
  assert.equal(await timeline.next(40000),null);
  (await timeline.at(0)).frame!.close();assert.equal(resets,4);
  assert.ok(closed.includes(20000));
 }finally{timeline.close();}
});

test('index growth during awaited send invalidates a duplicate PTS pending identity', async () => {
  const p = { pts: 100, dts: 0, key: true, offset: 13, size: 3 };
  const prefix = buildFlvIndex('h264', new Uint8Array(5), [p]);
  const ready: FlvFrame[] = []; let sending!: () => void, release!: () => void;
  const sent = new Promise<void>(resolve => { sending = resolve; });
  const decoder: PacketDecoder = { kind: 'webcodecs', reset() {}, close() {}, async drain() {}, receive() { return ready.shift() ?? null; },
    async send(_bytes, packet) { sending(); await new Promise<void>(resolve => { release = resolve; });
      ready.push({ pts: packet.pts, width: 2, height: 2, description: rgbaDescription(2, 2), pixels: new ArrayBuffer(16) }); } };
  const timeline = new PacketTimeline(prefix, decoder, async () => new Uint8Array([2, 0x65, 0x80]), true);
  const result = timeline.at(100); await sent;
  timeline.appendIndex(buildFlvIndex('h264', prefix.description, [p, { ...p, offset: 32, dts: 10 }])); release();
  assert.equal((await result).packetPicture, undefined);
  timeline.close();
});

test('uncompleted FLV identity cannot escape as an already presented exact token', async () => {
  const p = { pts: 100, dts: 0, key: true, offset: 13, size: 3 };
  const ready: FlvFrame[] = []; let complete = false;
  const decoder: PacketDecoder = { kind: 'webcodecs', reset() {}, close() {}, async drain() {}, receive() { return ready.shift() ?? null; },
    async send(_bytes, packet) { ready.push({ pts: packet.pts, width: 2, height: 2, description: rgbaDescription(2, 2), pixels: new ArrayBuffer(16) }); } };
  const timeline = new PacketTimeline(buildFlvIndex('h264', new Uint8Array(5), [p]), decoder, async () => new Uint8Array([2, 0x65, 0x80]), true, () => complete);
  assert.equal((await timeline.at(100)).packetPicture, undefined);
  complete = true;
  assert.deepEqual((await timeline.at(100)).packetPicture, { au: 0, configuration: 0, stream: 'video' });
  timeline.close();
});

test('MPEG-2 preroll discard keeps actual floor/EOF when an indexed picture produces no output',async()=>{
 for(const omitted of [undefined,80,120]){
  const packets=[0,40,80,120].map((pts,offset)=>({pts,dts:pts,offset,size:1,key:offset===0,identityKnown:true}));
  const index:PacketDecodeIndex={...buildFlvIndex('h264',new Uint8Array([0]),packets),codec:'mpeg2video',packets};
  let ready:number[]=[],resets=0;const minimums:number[]=[],copied:number[]=[];
  const decoder:PacketDecoder={kind:'ffmpeg-wasm',reset(){ready=[];resets++;},close(){ready=[];},async drain(){},async send(_bytes,p){if(p.pts!==omitted)ready.push(p.pts);},receive(minimum){minimums.push(minimum);while(ready.length&&ready[0]<minimum)ready.shift();const pts=ready.shift();if(pts===undefined)return null;copied.push(pts);return{pts,width:2,height:2,description:rgbaDescription(2,2),pixels:new ArrayBuffer(16)};}};
  const timeline=new PacketTimeline(index,decoder,async()=>new Uint8Array(1));
  try{
   const frame=await timeline.at(90);assert.equal(frame.pts,omitted===80?40:80);
   assert.equal((await timeline.at(999)).pts,omitted===120?80:120,'missing final indexed frame cannot erase the actual EOF floor');
   if(omitted===undefined){assert.ok(minimums.includes(80));assert.equal(copied.includes(0),false,'preroll pixels stay inside the decoder');}
   else assert.ok(resets>=3,'a missing indexed floor performs a complete output-led retry');
  }finally{timeline.close();}
 }
});
