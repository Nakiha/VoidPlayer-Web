import {PacketTimeline} from '../src/packet-timeline.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demuxFlv, scanFlv, FlvReader, flvIndexWarning } from '../src/flv-demux.ts';
import { serializeFlvIndex, parseFlvIndex } from '../src/flv-index-cache.ts';
import { FlvEngine } from '../src/flv-engine.ts';
import { checkedHeap } from '../src/flv-decoder.ts';
import { syntheticFlv } from './flv-fixture.ts';

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

test('bounded gaps recover but unproven corruption and a truncated first packet remain failures', async () => {
  const bytes = syntheticFlv();
  const invalid = trailingTag(); invalid[10] = 1;
  const recovered=await index(Buffer.concat([bytes,invalid]));
  assert.equal(recovered.truncatedAt,bytes.length);
  assert.deepEqual(recovered.packets,(await index(bytes)).packets);
  const rejoined=await index(Buffer.concat([bytes,invalid,bytes.subarray(13)]));
  assert.deepEqual(rejoined.recoveredGaps,[{offset:bytes.length,size:invalid.length}]);
  assert.equal(rejoined.packets.length,recovered.packets.length*2);
  await assert.rejects(index(Buffer.concat([bytes,invalid,Buffer.alloc(64*1024)])), /stream ID/);
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
  await assert.rejects(index(Buffer.concat([original, control([0x17, 2, 0, 0, 0, 1])])), /结束标签/);
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
      assert.equal(full.complete,true);assert.equal(full.nextOffset,file.length);
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
test('149-byte gap after a legal five-byte terminator rejoins seven tags and persists its warning',async()=>{
 const bytes=syntheticFlv(),end=recoveryTag(9,[0x17,2,0,0,0]);
 const suffix=Buffer.concat(Array.from({length:7},(_,i)=>recoveryTag(9,[0x27,1,0,0,0,1],160+i*40)));
 const prefix=Buffer.concat([bytes,end]),gap=Buffer.alloc(149,0xa5),file=Buffer.concat([prefix,gap,suffix]);
 const clean=await index(Buffer.concat([prefix,suffix])),reader=new FlvReader({file:new Blob([file])});
 try{
  const startup=await scanFlv(reader,undefined,undefined,true),recovered=await scanFlv(reader,undefined,startup);
  assert.equal(recovered.complete,true);assert.equal(recovered.index.truncatedAt,undefined);
  assert.equal(recovered.index.packets.length,clean.packets.length);
  assert.deepEqual(recovered.index.packets.map(p=>[p.pts,p.dts,p.size]),clean.packets.map(p=>[p.pts,p.dts,p.size]));
  assert.deepEqual(recovered.index.recoveredGaps,[{offset:prefix.length,size:149}]);
  assert.equal(recovered.index.packets.at(-1)!.offset,clean.packets.at(-1)!.offset+149);
  assert.match(flvIndexWarning(recovered.index)!,/149.*重同步/);
  const cached=parseFlvIndex(serializeFlvIndex(recovered.index,file.length),file.length);
  assert.deepEqual(cached,recovered.index);assert.equal(flvIndexWarning(cached),flvIndexWarning(recovered.index));
  for(const gaps of [[{offset:prefix.length,size:4097}],[{offset:13,size:1}],[{offset:clean.packets[0].offset,size:1}],[{offset:prefix.length,size:149},{offset:prefix.length,size:1}]])
   assert.throws(()=>parseFlvIndex({...serializeFlvIndex(cached,file.length),recoveredGaps:gaps},file.length));
 }finally{reader.close();}
});
test('resync requires two linked tags and refuses out-of-window or over-budget candidates',async()=>{
 const bytes=syntheticFlv(),tag=recoveryTag(8,[1]),gap=Buffer.alloc(149,0xa5);
 const bad=Buffer.from(tag);bad.writeUInt32BE(99,bad.length-4);
 for(const suffix of [tag,Buffer.concat([tag,bad]),Buffer.concat([gap,tag]),Buffer.concat([Buffer.alloc(4097,0xa5),tag,tag])])
  await assert.rejects(index(Buffer.concat([bytes,gap,suffix])));
 // A sequence of plausible but invalid candidates exhausts bounded probing.
 const candidates=Buffer.alloc(65*16);for(let i=0;i<65;i++){candidates[i*16]=8;candidates[i*16+3]=1;}
 await assert.rejects(index(Buffer.concat([bytes,Buffer.from([0xa5]),candidates,tag,tag])));
 let file=Buffer.from(bytes);for(let i=0;i<17;i++)file=Buffer.concat([file,gap,tag,tag]);
 await assert.rejects(index(file));
 // A corrupt size alone must also allow recovery, rather than silently truncate.
 const large=Buffer.alloc(149,0xa5);large[0]=9;large.writeUIntBE(0xffffff,1,3);large.fill(0,8,11);
 const recovered=await index(Buffer.concat([bytes,large,tag,tag]));
 assert.deepEqual(recovered.recoveredGaps,[{offset:bytes.length,size:149}]);
 await assert.rejects(index(Buffer.concat([bytes,large,tag])),/无法安全重同步/);
 const long=Buffer.concat([large,Buffer.alloc(4097,0xa5)]);
 await assert.rejects(index(Buffer.concat([bytes,long,tag,tag])),/无法安全重同步/);
});
test('resync IO failures propagate and recovered checkpoint metadata is not mutated on resume',async()=>{
 const bytes=syntheticFlv(),gap=Buffer.alloc(149,0xa5),tag=recoveryTag(8,[1]);
 const file=Buffer.concat([bytes,gap,tag,tag]),reader=new FlvReader({file:new Blob([file])});
 const read=reader.read.bind(reader);reader.read=async(offset,length)=>{if(offset===bytes.length&&length>11)throw new Error('resync IO failure');return read(offset,length);};
 try{await assert.rejects(demuxFlv(reader),/resync IO failure/);}finally{reader.close();}
 const first=await index(file),metadata=structuredClone(first.recoveredGaps);
 const longer=Buffer.concat([file,gap,tag,tag]),resumedReader=new FlvReader({file:new Blob([longer])});
 try{
  const resumed=await scanFlv(resumedReader,undefined,{index:first,nextOffset:file.length,complete:false});
  assert.deepEqual(first.recoveredGaps,metadata);assert.equal(resumed.index.recoveredGaps!.length,2);
 }finally{resumedReader.close();}
});
