import {PacketTimeline} from '../src/packet-timeline.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demuxFlv, scanFlv, FlvReader } from '../src/flv-demux.ts';
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

test('invalid stream IDs and broken interior tag links remain fatal, and a truncated first packet is not playable', async () => {
  const bytes = syntheticFlv();
  const invalid = trailingTag(); invalid[10] = 1;
  await assert.rejects(index(Buffer.concat([bytes, invalid])), /stream ID/);
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
