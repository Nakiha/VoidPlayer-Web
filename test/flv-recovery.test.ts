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

test('a decoder exception retains packet context and blocks further calls into the failed decoder', async () => {
  const engine = new FlvEngine({ file: new Blob([syntheticFlv()]) });
  try {
    await engine.prepare(); let receives = 0;
    engine.decoder = { kind: 'ffmpeg-wasm', reset() {}, send: async () => {}, receive() { receives++; throw new RangeError('offset is out of bounds'); }, drain: async () => {}, close() {} };
    await assert.rejects(engine.extract(0), /第 1 帧（包位置 \d+）.*offset is out of bounds/);
    await assert.rejects(engine.extract(0), /offset is out of bounds/);
    assert.equal(receives, 1);
  } finally { engine.close(); }
});
