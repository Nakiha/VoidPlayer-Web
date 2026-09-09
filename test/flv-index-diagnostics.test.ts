import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFlvIndex, extendFlvIndex, FlvReader, scanFlv } from '../src/flv-demux.ts';
import type { FlvPacket } from '../src/flv-demux.ts';
import { syntheticFlv } from './flv-fixture.ts';

const description = new Uint8Array([1]);
function packets(count: number): FlvPacket[] {
  return Array.from({ length: count }, (_, i) => ({
    // Four-picture reorder groups; raw DTS is increasing, raw PTS is not.
    offset: 1485 + i * 12235, size: 12200, dts: i * 40000,
    pts: (i - i % 4 + [3, 0, 2, 1][i % 4]) * 40000, key: i % 32 === 0,
  }));
}

test('44,404 reordered packets keep the same index across progressive boundaries and repeated publication', () => {
  const source = packets(44404), full = buildFlvIndex('vvc', description, source);
  for (const batch of [127, 1024, 21567]) {
    let previous = buildFlvIndex('vvc', description, source.slice(0, 1));
    for (let end = 1 + batch; end < source.length + batch; end += batch) {
      const prefix = source.slice(0, Math.min(end, source.length));
      const oldOrder = previous.order.slice(), oldCount = previous.packets.length;
      const next = extendFlvIndex(previous, 'vvc', description, prefix);
      assert.deepEqual(previous.order, oldOrder);
      assert.equal(previous.packets.length, oldCount);
      assert.equal(extendFlvIndex(next, 'vvc', description, prefix), next);
      previous = next;
    }
    assert.deepEqual(previous, full);
  }
});

test('duplicate PTS evidence identifies distinct packets without changing timestamps', () => {
  const source = packets(4); source[3].pts = source[1].pts;
  assert.throws(() => buildFlvIndex('hevc', description, source), error => {
    assert.match((error as Error).message, /视频包包含重复显示时间戳/);
    const detail = JSON.parse((error as Error).message.split('indexContext=')[1]);
    assert.equal(detail.deltaUs, 0);
    assert.deepEqual(detail.pair.map((p: number[]) => p[0]), [1, 3]);
    assert.equal(detail.pair[1][1], source[3].offset);
    return true;
  });
  assert.equal(source[3].pts, source[1].pts);
});

test('broken merge inputs are not mislabeled as duplicate source timestamps', () => {
  const source = packets(4);
  const previous = buildFlvIndex('h264', description, source.slice(0, 3));
  previous.order.reverse();
  assert.throws(() => extendFlvIndex(previous, 'h264', description, source), /显示索引顺序回退/);
  previous.order = [1, 1, 0];
  assert.throws(() => extendFlvIndex(previous, 'h264', description, source), /显示索引重复引用同一视频包/);
});

test('resumed scan includes publication context and both source packets within log limits', async () => {
  const bytes = syntheticFlv();
  const clean = new FlvReader({ file: new Blob([bytes]) });
  const complete = await scanFlv(clean); clean.close();
  // Legacy video payload starts 16 bytes after the tag. Set packet 1 DTS to 0
  // to match packet 0 without modifying tag sizes or any payload bytes.
  const offset = complete.index.packets[1].offset;
  bytes.fill(0, offset - 12, offset - 8);
  const reader = new FlvReader({ file: new Blob([bytes]) });
  try {
    const startup = await scanFlv(reader, undefined, undefined, true);
    await assert.rejects(scanFlv(reader, undefined, startup), error => {
      const message = (error as Error).message;
      assert.match(message, /重复显示时间戳/);
      assert.ok(message.length < 800);
      const [index, scan] = message.split('indexContext=')[1].split(' scan=');
      assert.equal(JSON.parse(index).pair[1][1], offset);
      assert.equal(JSON.parse(scan).previousPackets, 1);
      assert.equal(JSON.parse(scan).packets, 4);
      assert.equal(JSON.parse(scan).size, bytes.length);
      return true;
    });
  } finally { reader.close(); }
});
