import test from 'node:test';
import assert from 'node:assert/strict';
import {PacketTimeline} from '../src/packet-timeline.ts';
import type {PacketDecoder,FlvFrame} from '../src/flv-decoder.ts';
import type {FlvIndex} from '../src/flv-demux.ts';
import {rgbaDescription} from '../src/frame-description.ts';
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
