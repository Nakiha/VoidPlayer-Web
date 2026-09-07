import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Input, BlobSource, ALL_FORMATS, EncodedPacketSink } from 'mediabunny';
import { RangeReader } from '../src/range-reader.ts';
import { readMp4Configurations } from '../src/mp4-config.ts';
import { HevcPictureOrder, hevcDisplayOrder, recoveredHevcTimes } from '../src/hevc-timeline.ts';
import { Mp4Engine } from '../src/mp4-engine.ts';
import { wasmFlvDecoder } from '../src/flv-decoder.ts';

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
test('HEVC recovery agrees with native FFmpeg picture order and preserves every frame through seeks', {timeout:120000}, async () => {
  const bytes = await readFile(new URL('../fixtures/video/h265_10s_1920x1080.mp4',import.meta.url));
  const oracle = JSON.parse(await readFile(new URL('./hevc-order-reference.json',import.meta.url),'utf8'));
  assert.equal(hash(bytes),oracle.sha256);
  const blob = new Blob([bytes]), reader = new RangeReader({file:blob});
  const input = new Input({source:new BlobSource(blob),formats:ALL_FORMATS});
  const track = (await input.getPrimaryVideoTrack())!;
  const configs = await readMp4Configurations(reader,track.id);
  assert.deepEqual(await hevcDisplayOrder(reader,configs),oracle.displayOrder);
  // Composition timestamps supplied by a valid muxer must bypass recovery.
  assert.equal(await hevcDisplayOrder(reader,{...configs,compositionOffsets:configs.compositionOffsets!.map((_,i)=>i?1:0)}),null);
  await assert.rejects(hevcDisplayOrder({read:async()=>{throw Error('network failure');}},configs),/network failure/);
  assert.equal(await hevcDisplayOrder(reader,{...configs,sampleSizes:[1,...configs.sampleSizes!.slice(1)]}),null);
  const core = new URL('../public/vendor/voidplayer-core/',import.meta.url);
  const glue = new URL('voidplayer-core.js',core).href, wasm = await readFile(new URL('voidplayer-core.wasm',core));
  const raw = await wasmFlvDecoder({codec:'hevc',description:configs.descriptions[0]},glue,wasm);
  const reference:string[]=[];
  const receive=()=>{for(;;){const f=raw.receive(Number.MIN_SAFE_INTEGER);if(!f)break;reference.push(hash(new Uint8Array(f.pixels!)));f.frame?.close();}};
  try {
    for await(const p of new EncodedPacketSink(track).packets()) {
      await raw.send(p.data,{pts:Math.round(p.timestamp*1e6),dts:Math.round(p.timestamp*1e6),key:p.type==='key',offset:0,size:p.byteLength});receive();
    }
    await raw.drain();receive();
  } finally {raw.close();input.dispose();reader.close();}
  assert.equal(reference.length,600);
  const engine=new Mp4Engine({file:blob});
  try {
    const init=await engine.open(glue,wasm);
    assert.equal(init.timelineSource,'hevc-poc');
    const first=await engine.at(init.firstPtsUs);
    assert.equal(hash(new Uint8Array(first.pixels!)),reference[0]);
    let previous=first.pts;
    for(let i=1;i<reference.length;i++) {
      const f=await engine.next(previous);assert.ok(f,`missing frame ${i}`);
      assert.equal(f.pts,init.firstPtsUs+init.times[i]);
      assert.equal(hash(new Uint8Array(f.pixels!)),reference[i],`picture ${i}`);previous=f.pts;
    }
    assert.equal(await engine.next(previous),null);
    for(const i of [0,1,63,64,65,255,256,257,599,0,300]) {
      const f=await engine.at(init.firstPtsUs+init.times[i]);
      assert.equal(hash(new Uint8Array(f.pixels!)),reference[i],`seek ${i}`);
      if(i<599){const next=await engine.next(f.pts);assert.equal(hash(new Uint8Array(next!.pixels!)),reference[i+1],`step after seek ${i}`);}
    }
  } finally {engine.close();}
});

test('timeline recovery rejects VFR, duplicate clocks and invalid permutations; keeps valid rounding',()=>{
  assert.deepEqual(recoveredHevcTimes([0,2,1],[100,16767,33433],[16667,16666,16667]),[100,33433,16767]);
  assert.equal(recoveredHevcTimes([0,2,1],[0,16667,50000],[16667,33333,16667]),null);
  assert.equal(recoveredHevcTimes([0,2,1],[0,0,16667],[16667,16667,16667]),null);
  assert.equal(recoveredHevcTimes([0,1,1],[0,16667,33333],[16667,16667,16667]),null);
});

// Synthetic headers exercise syntax and wrap boundaries independently of the
// reported fixture. Only the prefix consumed by this parser is constructed.
const fixed=(v:number,n:number)=>v.toString(2).padStart(n,'0');
const ue=(v:number)=>{const s=(v+1).toString(2);return '0'.repeat(s.length-1)+s;};
function nal(type:number,bits:string,tid=0) {
  const b=bits+'1'+'0'.repeat((7-bits.length%8)%8),out=[type*2,tid+1];
  for(let i=0;i<b.length;i+=8) {const v=parseInt(b.slice(i,i+8),2);if(out.length>=4&&out.at(-1)===0&&out.at(-2)===0&&v<=3)out.push(3);out.push(v);}
  return Uint8Array.from(out);
}
function description(reorder=3) {
  const sps=nal(33,'0000'+'000'+'1'+'00'+'0'+'00001'+'0'.repeat(32)+'10'+'0'.repeat(46+8)+ue(0)+ue(1)+ue(64)+ue(64)+'0'+ue(0)+ue(0)+ue(0)+'1'+ue(5)+ue(reorder)+ue(0));
  const pps=nal(34,ue(0)+ue(0)+'0'+'1'+'010');
  const d=new Uint8Array(23);d[0]=1;d[21]=3;d[22]=2;
  return Uint8Array.from([...d,...[sps,pps].flatMap(n=>[(n[0]>>1)&63,0,1,n.length>>8,n.length&255,...n])]);
}
const slice=(poc:number,type=1,tid=0,output=1,pps=0)=>nal(type,'1'+([19,20].includes(type)?'0':'')+ue(pps)+'00'+ue([19,20].includes(type)?2:0)+String(output)+([19,20].includes(type)?'':fixed(poc,4)),tid);
test('POC uses PPS flags, sublayer reference state, LSB wrap and IDR epochs',()=>{
  const p=new HevcPictureOrder(description());
  assert.deepEqual(p.picture(slice(0,19)),{poc:0,idr:true});
  assert.equal(p.picture(slice(7))!.poc,7);
  assert.equal(p.picture(slice(14))!.poc,14);
  assert.equal(p.picture(slice(1))!.poc,17);
  assert.equal(p.picture(slice(15,0,1))!.poc,15); // earlier non-reference B picture
  assert.equal(p.picture(slice(2))!.poc,18);
  assert.equal(p.picture(slice(0,20))!.poc,0);
  assert.equal(p.picture(slice(1))!.poc,1);
  assert.throws(()=>p.picture(slice(2,1,0,0)),/non-output/);
  assert.throws(()=>p.picture(slice(2,1,0,1,1)),/unknown PPS/);
  assert.throws(()=>p.picture(slice(2,21)),/open GOP/);
  assert.throws(()=>p.picture(new Uint8Array([2,1])),/truncated/);
});

test('structure-based detection leaves low-delay B pictures intact and handles repeated closed GOPs',async()=>{
  assert.equal(await hevcDisplayOrder({read:async()=>{throw Error('zero reorder bound must not read payload');}},
    {descriptions:[description(0)],sampleOffsets:[0],sampleSizes:[100],compositionOffsets:[0]}),null);
  async function detect(pictures:Uint8Array[]) {
    const packets=pictures.map(n=>Uint8Array.from([0,0,0,n.length,...n]));
    const sizes=packets.map(p=>p.length),offsets=sizes.map((_,i)=>sizes.slice(0,i).reduce((s,n)=>s+n,0));
    const data=Uint8Array.from(packets.flatMap(p=>[...p]));
    return hevcDisplayOrder({read:async(offset,size)=>data.slice(offset,offset+size)},
      {descriptions:[description()],sampleOffsets:offsets,sampleSizes:sizes,compositionOffsets:sizes.map(()=>0)});
  }
  // Both non-IDR pictures have slice_type B; B alone must not trigger repair.
  assert.equal(await detect([slice(0,19),slice(1),slice(2)]),null);
  assert.deepEqual(await detect([slice(0,19),slice(2),slice(1,0,1),slice(0,19),slice(2),slice(1,0,1)]),[0,2,1,3,5,4]);
  assert.equal(await detect([slice(0,19),slice(2)]),null); // missing display picture
  assert.equal(await detect([slice(0,19),slice(1),slice(1)]),null); // ambiguous POC
  assert.equal(await detect([slice(0,19),slice(2,21),slice(1)]),null); // open GOP not silently guessed
});
