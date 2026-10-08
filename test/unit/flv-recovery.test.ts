import {PacketTimeline} from '../../src/packet-timeline.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demuxFlv, scanFlv, FlvReader, flvIndexWarning, flvIndexIntegrity, FLV_RESYNC_BYTES } from '../../src/flv-demux.ts';
import { serializeFlvIndex, parseFlvIndex } from '../../src/flv-index-cache.ts';
import { FlvEngine } from '../../src/flv-engine.ts';
import { checkedHeap } from '../../src/flv-decoder.ts';
import { syntheticFlv } from '.././flv-fixture.ts';

async function index(bytes: Uint8Array) {
  const reader = new FlvReader({ file: new Blob([bytes as Uint8Array<ArrayBuffer>]) });
  try { return await demuxFlv(reader); } finally { reader.close(); }
}
const trailingTag = () => { const b = Buffer.alloc(22); b[0] = 9; b.writeUIntBE(5639, 1, 3); return b; };

test('incomplete final header, payload or footer retains the validated prefix and its warning in shared caches', async () => {
  const bytes = syntheticFlv(), complete = await index(bytes);
  for (const tail of [Buffer.from([9]), Buffer.alloc(10), trailingTag()]) {
    const file = Buffer.concat([bytes, tail]);
    const reader = new FlvReader({ file: new Blob([file]) });
    try {
      const start = await scanFlv(reader, undefined, undefined, true);
      const recovered = await scanFlv(reader, undefined, start);
      assert.equal(recovered.complete, true); assert.equal(recovered.index.truncatedAt, bytes.length);
      assert.deepEqual(recovered.index.packets, complete.packets);
      assert.deepEqual(parseFlvIndex(serializeFlvIndex(recovered.index, file.length), file.length), recovered.index);
    } finally { reader.close(); }
  }
  for (let missing = 1; missing <= 12; missing++) {
    const partial = await index(bytes.subarray(0, bytes.length - missing));
    assert.equal(partial.packets.length, complete.packets.length - 1);
    assert.ok(partial.truncatedAt! < bytes.length - missing);
  }
});

test('unproven corruption retains the prefix but a truncated first packet remains fatal', async () => {
  const bytes = syntheticFlv();
  const invalid = trailingTag(); invalid[10] = 1;
  const recovered=await index(Buffer.concat([bytes,invalid]));
  assert.equal(recovered.truncatedAt,bytes.length);
  assert.deepEqual(recovered.packets,(await index(bytes)).packets);
  const rejoined=await index(Buffer.concat([bytes,invalid,bytes.subarray(13)]));
  assert.equal(rejoined.truncatedAt,bytes.length);
  assert.equal(rejoined.truncationReason,'recovery-budget');
  assert.deepEqual(rejoined.packets,recovered.packets);
  const long=await index(Buffer.concat([bytes,invalid,Buffer.alloc(190*1024)]));
  assert.equal(long.truncatedAt,bytes.length);assert.deepEqual(long.packets,recovered.packets);
  const corrupt = Buffer.from(bytes); corrupt.writeUInt32BE(999, 36);
  await assert.rejects(index(corrupt), /PreviousTagSize/);
  const full = await index(bytes), first = full.packets[0];
  await assert.rejects(index(bytes.subarray(0, first.offset + 1)), /有效视频/);
  const doc = serializeFlvIndex(full, bytes.length);
  assert.throws(() => parseFlvIndex({ ...doc, truncatedAt: 13 }, bytes.length));
});

test('core pointer checks reject clipped/overflowing ranges before copying', () => {
  const heap = new Uint8Array(100);
  assert.equal(checkedHeap(heap, 10, 90, 'test'), heap);
  for (const [ptr, size] of [[90, 11], [-1, 1], [NaN, 1], [1, -1]]) assert.throws(() => checkedHeap(heap, ptr, size, 'test'), /内存范围无效/);
});

test('a decoder exception reports the actual fed packet and stops further calls', async () => {
  const idx=await index(syntheticFlv());let receives=0,sent=false;
  const timeline=new PacketTimeline(idx,{kind:'ffmpeg-wasm',reset(){},send:async()=>{sent=true;},receive(){if(sent){receives++;throw new RangeError('offset is out of bounds');}return null;},drain:async()=>{},close(){}},async()=>new Uint8Array(1));
  try{
    await assert.rejects(timeline.at(idx.packets[1].pts),e=>{assert.match(String(e),/offset is out of bounds/);assert.ok(String(e).includes(`offset=${idx.packets[0].offset}`));assert.ok(String(e).includes(`目标 PTS=${idx.packets[1].pts}`));return true;});
    await assert.rejects(timeline.at(0),/offset is out of bounds/);assert.equal(receives,1);
  }finally{timeline.close();}
});

test('foreign codec sequence-end markers do not change codec or duration; coded switches remain errors', async () => {
  const original = syntheticFlv();
  // The same control-message rule applies in either direction and at any time.
  const control = (payload: number[]) => {
    const tag = Buffer.alloc(15 + payload.length); tag[0] = 9; tag.writeUIntBE(payload.length, 1, 3);
    tag.writeUIntBE(28364800 & 0xffffff, 4, 3); tag[7] = 28364800 >>> 24;
    tag.set(payload, 11); tag.writeUInt32BE(payload.length + 11, 11 + payload.length); return tag;
  };
  const expected = await index(original);
  for (const payload of [[0x1c, 2, 0, 0, 0], [0x92, 104, 118, 99, 49]]) {
    const recovered = await index(Buffer.concat([original, control(payload)]));
    assert.deepEqual(recovered, expected);
  }
  for (const payload of [[0x1c, 0, 0, 0, 0, 1], [0x1c, 1, 0, 0, 0, 1]])
    await assert.rejects(index(Buffer.concat([original, control(payload)])), /切换视频编码/);
  assert.equal((await index(Buffer.concat([original, control([0x17, 2, 0, 0, 0, 1])]))).truncatedAt,original.length);
});

test('corrupt short EOF suffixes recover after startup, preserve cache warnings and reject an empty prefix', async () => {
  const bytes=syntheticFlv(),expected=await index(bytes);
  const invalidStream=Buffer.alloc(18);invalidStream[0]=9;invalidStream[10]=1;invalidStream.writeUIntBE(3,1,3);invalidStream.writeUInt32BE(14,14);
  const badFooter=Buffer.from(invalidStream);badFooter[10]=0;badFooter.writeUInt32BE(99,14);
  for(const tail of [Buffer.alloc(37,0xa5),invalidStream,badFooter]){
    const file=Buffer.concat([bytes,tail]),reader=new FlvReader({file:new Blob([file])});
    try{
      const start=await scanFlv(reader,undefined,undefined,true);
      const full=await scanFlv(reader,undefined,start);
      assert.equal(full.complete,true);assert.equal(full.nextOffset,bytes.length);
      assert.equal(full.index.truncatedAt,bytes.length);assert.deepEqual(full.index.packets,expected.packets);
      assert.deepEqual(parseFlvIndex(serializeFlvIndex(full.index,file.length),file.length),full.index);
    }finally{reader.close();}
    await assert.rejects(index(Buffer.concat([bytes.subarray(0,13),tail])));
  }
});

function recoveryTag(type:number,payload:number[],time=0){
 const tag=Buffer.alloc(15+payload.length);tag[0]=type;tag.writeUIntBE(payload.length,1,3);tag.writeUIntBE(time,4,3);
 tag.set(payload,11);tag.writeUInt32BE(payload.length+11,11+payload.length);return tag;
}
const picture=(time:number,key=false)=>recoveryTag(9,[key?0x17:0x27,1,0,0,0,0,0,0,1,key?0x65:0x41],time);
test('5828-byte garbage with 190 KiB remaining rejoins at an IDR and persists recovery provenance',async()=>{
 const bytes=syntheticFlv(),end=recoveryTag(9,[0x17,2,0,0,0]);
 const suffix=Buffer.concat(Array.from({length:35},(_,i)=>picture(160+i*40,i===0)));
 const prefix=Buffer.concat([bytes,end]),gap=Buffer.alloc(5828,0xa5);
 const audio=recoveryTag(8,Array(190*1024-gap.length-suffix.length-15).fill(0));
 const file=Buffer.concat([prefix,gap,suffix,audio]);
 const clean=await index(Buffer.concat([prefix,suffix,audio])),reader=new FlvReader({file:new Blob([file])});
 try{
  const startup=await scanFlv(reader,undefined,undefined,true),recovered=await scanFlv(reader,undefined,startup);
  assert.equal(recovered.complete,true);assert.equal(recovered.index.truncatedAt,undefined);
  assert.equal(flvIndexIntegrity(recovered.index),'recovered');
  assert.equal(recovered.index.packets.length,clean.packets.length);
  assert.deepEqual(recovered.index.packets.map(p=>[p.pts,p.dts,p.size]),clean.packets.map(p=>[p.pts,p.dts,p.size]));
  assert.deepEqual(recovered.index.recoveredGaps,[{offset:prefix.length,size:5828,resumeAt:prefix.length+5828}]);
  assert.equal(recovered.index.packets[4].discontinuity,true);
  assert.match(flvIndexWarning(recovered.index)!,/5828.*重同步/);
  const cached=parseFlvIndex(serializeFlvIndex(recovered.index,file.length),file.length);
  assert.deepEqual(cached,recovered.index);assert.equal(flvIndexWarning(cached),flvIndexWarning(recovered.index));
  const doc=serializeFlvIndex(cached,file.length);
  for(const patch of [{size:FLV_RESYNC_BYTES+1},{offset:13},{resumeAt:prefix.length},{resumeAt:file.length}])
   assert.throws(()=>parseFlvIndex({...doc,recoveredGaps:[{...doc.recoveredGaps![0],...patch}]},file.length));
  assert.throws(()=>parseFlvIndex({...doc,packets:doc.packets.map(p=>p.length===7?p.slice(0,5):p)},file.length));
  assert.throws(()=>parseFlvIndex({...doc,schema:2},file.length));
 }finally{reader.close();}
});
test('unlinked tags and exhausted byte, candidate or gap budgets preserve playable packets',async()=>{
 const bytes=syntheticFlv(),tag=recoveryTag(8,[1]),gap=Buffer.alloc(149,0xa5),expected=await index(bytes);
 const bad=Buffer.from(tag);bad.writeUInt32BE(99,bad.length-4);
 for(const suffix of [tag,Buffer.concat([tag,bad]),Buffer.concat([gap,tag]),Buffer.concat([Buffer.alloc(FLV_RESYNC_BYTES+1,0xa5),picture(160,true),picture(200)])]){
  const recovered=await index(Buffer.concat([bytes,gap,suffix]));
  assert.equal(recovered.truncatedAt,bytes.length);assert.deepEqual(recovered.packets,expected.packets);
  assert.equal(flvIndexIntegrity(recovered),'prefix');
 }
 const candidates=Buffer.alloc(257*16);for(let i=0;i<257;i++){candidates[i*16]=8;candidates[i*16+3]=1;}
 const exhausted=await index(Buffer.concat([bytes,Buffer.from([0xa5]),candidates,picture(160,true),picture(200)]));
 assert.equal(exhausted.truncationReason,'recovery-budget');assert.equal(exhausted.truncatedAt,bytes.length);
 let file=Buffer.from(bytes),stop=0;
 for(let i=0;i<17;i++){if(i===16)stop=file.length;file=Buffer.concat([file,gap,picture(160+i*80,true),picture(200+i*80)]);}
 const limited=await index(file);assert.equal(limited.recoveredGaps!.length,16);assert.equal(limited.truncatedAt,stop);
 assert.equal(limited.truncationReason,'recovery-budget');assert.equal(limited.packets.length,4+16*2);
 assert.deepEqual(parseFlvIndex(serializeFlvIndex(limited,file.length),file.length),limited);
 // Corrupt sizes follow the same recovery/degradation path as invalid headers.
 const large=Buffer.alloc(149,0xa5);large[0]=9;large.writeUIntBE(0xffffff,1,3);large.fill(0,8,11);
 const recovered=await index(Buffer.concat([bytes,large,picture(160,true),picture(200)]));
 assert.equal(recovered.recoveredGaps![0].size,149);
 const clipped=await index(Buffer.concat([bytes,large,picture(160,true)]));
 assert.equal(clipped.truncatedAt,bytes.length);assert.deepEqual(clipped.packets,expected.packets);
});
test('resync drops dependent pictures and false container keys until a closed NAL anchor',async()=>{
 const bytes=syntheticFlv(),gap=Buffer.alloc(149,0xa5);
 const fakeKey=recoveryTag(9,[0x17,1,0,0,0,0,0,0,1,0x41],200);
 const dropped=Buffer.concat([picture(160),fakeKey]);
 const file=Buffer.concat([bytes,gap,dropped,picture(240,true),picture(280)]),recovered=await index(file);
 assert.deepEqual(recovered.packets.map(p=>p.pts),[0,40000,80000,120000,240000,280000]);
 assert.equal(recovered.recoveredGaps![0].resumeAt,bytes.length+gap.length+dropped.length);
 assert.equal(recovered.packets[4].discontinuity,true);
 assert.deepEqual(parseFlvIndex(serializeFlvIndex(recovered,file.length),file.length),recovered);
 const onlyDependent=await index(Buffer.concat([bytes,gap,dropped]));
 assert.equal(onlyDependent.truncationReason,'no-random-access');assert.equal(onlyDependent.truncatedAt,bytes.length);
 assert.equal(onlyDependent.recoveredGaps,undefined);
});
test('recovery reads bounded blocks, propagates IO/cancellation, and keeps checkpoints immutable',async()=>{
 const bytes=syntheticFlv(),gap=Buffer.alloc(149,0xa5);
 const file=Buffer.concat([bytes,gap,picture(160,true),picture(200)]),reader=new FlvReader({file:new Blob([file])});
 const read=reader.read.bind(reader);reader.read=async(offset,length)=>{if(offset===bytes.length+1&&length>11)throw new Error('resync IO failure');return read(offset,length);};
 try{await assert.rejects(demuxFlv(reader),/resync IO failure/);}finally{reader.close();}
 const first=await index(file),snapshot=structuredClone(first);
 const longer=Buffer.concat([file,gap,picture(240,true),picture(280)]),resumedReader=new FlvReader({file:new Blob([longer])});
 try{
  const resumed=await scanFlv(resumedReader,undefined,{index:first,nextOffset:file.length,complete:false});
  assert.deepEqual(first,snapshot);assert.equal(resumed.index.recoveredGaps!.length,2);
 }finally{resumedReader.close();}
 const long=Buffer.concat([bytes,Buffer.alloc(FLV_RESYNC_BYTES+500,0xa5)]);
 const bounded=new FlvReader({file:new Blob([long])}),normal=bounded.read.bind(bounded);let largest=0;
 bounded.read=async(at,length)=>{if(at>=bytes.length)largest=Math.max(largest,length);return normal(at,length);};
 try{assert.equal((await demuxFlv(bounded)).truncatedAt,bytes.length);assert.ok(largest<=64*1024+10);}finally{bounded.close();}
 const cancelled=new FlvReader({file:new Blob([long])}),before=cancelled.read.bind(cancelled);
 cancelled.read=async(at,length)=>{if(at===bytes.length+1)cancelled.close();return before(at,length);};
 await assert.rejects(demuxFlv(cancelled),/取消/);
});

test('malformed video payloads use prefix recovery while unsupported codecs/configurations stay fatal',async()=>{
 const bytes=syntheticFlv();
 for(const tail of [recoveryTag(9,[]),recoveryTag(9,[0x07,1,0,0,0,1]),recoveryTag(9,[0x17,7,0,0,0,1])]){
  const degraded=await index(Buffer.concat([bytes,tail]));assert.equal(degraded.truncatedAt,bytes.length);
  const restored=await index(Buffer.concat([bytes,tail,picture(160,true),picture(200)]));assert.equal(restored.packets.length,6);
 }
 await assert.rejects(index(Buffer.concat([bytes,recoveryTag(9,[0x16,1,0,0,0,1])])),/编码暂不支持/);
 await assert.rejects(index(Buffer.concat([bytes,recoveryTag(9,[0x17,0,0,0,0])])),/配置头/);
});
test('HEVC/VVC closed NAL anchors recover; CRA and AV1 key flags conservatively retain the prefix',async()=>{
 const header=syntheticFlv().subarray(0,13),gap=Buffer.alloc(5828,0xa5);
 for(const [codec,id,config,closed,cra] of [
  ['hevc',12,Array.from({length:23},(_,i)=>i===0?1:i===21?3:0),[38,1],[42,1]],
  ['vvc',14,[0xfe,0],[0,57],[0,73]],
 ] as const){
  const tag=(time:number,nal:readonly number[])=>recoveryTag(9,[0x10|id,1,0,0,0,0,0,0,2,...nal],time);
  const prefix=Buffer.concat([header,recoveryTag(9,[0x10|id,0,0,0,0,...config]),tag(0,closed)]);
  const file=Buffer.concat([prefix,gap,tag(40,closed),tag(80,closed)]),recovered=await index(file);
  assert.equal(recovered.codec,codec);assert.equal(recovered.packets.length,3);assert.equal(recovered.packets[1].discontinuity,true);
  assert.deepEqual(parseFlvIndex(serializeFlvIndex(recovered,file.length),file.length),recovered);
  const dependent=await index(Buffer.concat([prefix,gap,tag(40,cra),tag(80,cra)]));
  assert.equal(dependent.truncationReason,'no-random-access');assert.equal(dependent.packets.length,1);
 }
 const config=recoveryTag(9,[0x1d,0,0,0,0,0x81,0,0,0]),packet=recoveryTag(9,[0x1d,1,0,0,0,1]);
 const prefix=Buffer.concat([header,config,packet]);
 const av1=await index(Buffer.concat([prefix,gap,packet,packet]));assert.equal(av1.truncatedAt,prefix.length);assert.equal(av1.packets.length,1);
});

test('aggregate probe budget stops recovery without invalidating earlier recovered segments',async()=>{
 let file=Buffer.from(syntheticFlv());
 for(let i=0;i<6;i++)file=Buffer.concat([file,Buffer.alloc(900*1024,0xa5),picture(160+i*80,true),picture(200+i*80)]);
 const result=await index(file);assert.equal(result.truncationReason,'recovery-budget');
 assert.ok(result.recoveredGaps!.length>=1&&result.recoveredGaps!.length<6);
 assert.equal(result.packets.length,4+result.recoveredGaps!.length*2);
 assert.deepEqual(parseFlvIndex(serializeFlvIndex(result,file.length),file.length),result);
});
test('uncommitted configuration changes are rolled back when no safe recovery picture exists',async()=>{
 const bytes=syntheticFlv(),config=recoveryTag(9,[0x17,0,0,0,0,1,100,0,40,0xff,0xe0,0]);
 const file=Buffer.concat([bytes,Buffer.alloc(149,0xa5),config,picture(160),picture(200)]);
 const result=await index(file);assert.equal(result.truncationReason,'no-random-access');
 assert.equal(result.configurations,undefined);assert.deepEqual(result.packets,(await index(bytes)).packets);
 assert.deepEqual(parseFlvIndex(serializeFlvIndex(result,file.length),file.length),result);
});
