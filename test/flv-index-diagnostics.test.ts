import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFlvIndex, extendFlvIndex, FlvReader, scanFlv, flvMediaTiming, flvIndexWarning } from '../src/flv-demux.ts';
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

test('duplicate PTS preserves packets and produces unique positive display intervals', () => {
  const source = packets(4); source[3].pts = source[1].pts;
  const index = buildFlvIndex('hevc', description, source);
  assert.equal(index.packets.length, 4);
  assert.deepEqual(index.displayOrder, [1, 2, 0]);
  assert.equal(flvMediaTiming(index).times.length, 3);
  assert.ok(flvMediaTiming(index).durations.every(d => d > 0));
  assert.match(flvIndexWarning(index)!, /1 个重复 PTS/);
  assert.equal(source[3].pts, source[1].pts);
  let prefix = buildFlvIndex('hevc', description, source.slice(0, 3));
  assert.deepEqual(extendFlvIndex(prefix, 'hevc', description, source), index);
});

test('duplicate tail and all-equal timestamps have a positive final interval', () => {
  for (const pts of [[0, 40000, 40000], [0, 0, 0]]) {
    const source = packets(3).map((p, i) => ({ ...p, pts: pts[i] }));
    const timing = flvMediaTiming(buildFlvIndex('vvc', description, source));
    assert.deepEqual(timing.times, [...new Set(pts)]);
    assert.ok(timing.durations.every(d => d === 40000));
    assert.equal(timing.durationUs, pts.at(-1)! + 40000);
  }
});

test('broken merge inputs are not mislabeled as duplicate source timestamps', () => {
  const source = packets(4);
  const previous = buildFlvIndex('h264', description, source.slice(0, 3));
  previous.order.reverse();
  assert.throws(() => extendFlvIndex(previous, 'h264', description, source), /显示索引顺序回退/);
  previous.order = [1, 1, 0];
  assert.throws(() => extendFlvIndex(previous, 'h264', description, source), /显示索引重复引用同一视频包/);
});

test('resumed scan accepts duplicate source PTS and cache roundtrip retains every packet', async () => {
  const { serializeFlvIndex, parseFlvIndex } = await import('../src/flv-index-cache.ts');
  const bytes = syntheticFlv();
  const clean = new FlvReader({ file: new Blob([bytes]) });
  const complete = await scanFlv(clean); clean.close();
  const offset = complete.index.packets[1].offset;
  bytes.fill(0, offset - 12, offset - 8);
  const reader = new FlvReader({ file: new Blob([bytes]) });
  try {
    const startup = await scanFlv(reader, undefined, undefined, true);
    const result = await scanFlv(reader, undefined, startup);
    assert.equal(result.index.packets.length, 4);
    assert.deepEqual(flvMediaTiming(result.index).times, [0, 80000, 120000]);
    assert.deepEqual(parseFlvIndex(serializeFlvIndex(result.index, bytes.length), bytes.length), result.index);
  } finally { reader.close(); }
});
