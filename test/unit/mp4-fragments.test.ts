import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readMp4Configurations } from '../../shared/media/containers/mp4-config.ts';
const u32 = (...values: number[]) => { const b = Buffer.alloc(values.length * 4); values.forEach((n, i) => b.writeUInt32BE(n >>> 0, i * 4)); return b; };
const u64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(n); return b; };
const box = (type: string, ...parts: Uint8Array[]) => { const b = Buffer.concat(parts); return Buffer.concat([u32(b.length + 8), Buffer.from(type), b]); };
function init(extraSamples = 0, descriptions = 1, terminator: Uint8Array = new Uint8Array(0)) {
  const visual=Buffer.alloc(78);visual.writeUInt16BE(16,24);visual.writeUInt16BE(16,26);
  const sample = box('hvc1', visual, box('hvcC', Buffer.from([1])), terminator);
  const track = box('trak', box('tkhd', u32(0, 0, 0, 1)), box('mdia', box('hdlr', u32(0, 0), Buffer.from('vide')),
    box('minf', box('stbl', box('stsd', u32(0, descriptions), ...Array(descriptions).fill(sample)), box('stsz', u32(0, 0, extraSamples))))));
  return box('moov', track, box('mvex', box('trex', u32(0, 1, 1, 10, 3, 0x10000))));
}
const read = (bytes: Uint8Array, limit = 20) => readMp4Configurations({ size: bytes.length, async read(o: number, n: number) { return bytes.subarray(o, o + n); } } as any, 1, limit, true);
function fixture(options: { base?: bigint; implicit?: boolean; before?: boolean; missingTfdt?: boolean; version?: number; ticks?: bigint; nextTicks?: bigint; description?: number; duration?: number; count?: number; ctoVersion?: number; cto?: number; overlap?: boolean; mixed?: boolean; configs?: number; audio?: boolean; trexOnly?: boolean; terminator?: Uint8Array } = {}) {
  const initial = init(options.mixed ? 1 : 0, options.configs ?? 1, options.terminator), media = box('mdat', Buffer.alloc(6));
  const make = (first: boolean) => {
    const tfhd = box('tfhd', u32((options.implicit ? 0 : options.base !== undefined ? 1 : 0x20000) | (options.trexOnly ? 0 : 2 | 8 | 16 | 32), 1),
      ...(options.base === undefined ? [] : [u64(options.base)]), ...(options.trexOnly ? [] : [u32(options.description ?? 1, options.duration ?? 11, 3, 0)]));
    const tfdt = box('tfdt', u32((options.version ?? 1) << 24), (options.version ?? 1) === 0 ? u32(Number(options.ticks ?? 100n)) : u64(first ? options.ticks ?? 100n : options.nextTicks ?? 124n));
    const offset = options.before ? -media.length + 8 : 0;
    const run1 = (offset: number) => box('trun', u32(0x1000000 | 1 | 4 | 0x100 | 0x800, options.count ?? 1, offset, 0x10000, 13, options.cto ?? -2));
    const run2 = (offset: number) => box('trun', u32(((options.ctoVersion ?? 1) << 24) | 0x800 | (options.overlap ? 1 : 0), 1), ...(options.overlap ? [u32(offset)] : []), u32(options.cto ?? 0));
    const makeMoof = (offset: number) => box('moof', box('mfhd', u32(0, 1)), ...(options.audio ? [box('traf', box('tfhd', u32(0x20000, 2)))] : []),
      box('traf', tfhd, ...(options.missingTfdt ? [] : [tfdt]), run1(offset), run2(offset)));
    const temp = makeMoof(0);
    const moof = makeMoof(options.before ? offset : temp.length + 8);
    return options.before ? Buffer.concat([media, moof]) : Buffer.concat([moof, media]);
  };
  return Buffer.concat([initial, make(true), ...(options.nextTicks === undefined ? [] : [make(false)])]);
}
test('fragment mapping: trex < tfhd < trun, first flags, signed CTO, multi-run continuation and audio traf', async () => {
  const c = await read(fixture({ audio: true }));
  assert.deepEqual(c.sampleSizes, [3, 3]); assert.deepEqual(c.sampleDurations, [13, 11]); assert.deepEqual(c.sampleKeys, [false, true]);
  assert.deepEqual(c.decodeTimes, [100, 113]); assert.deepEqual(c.compositionOffsets, [-2, 0]); assert.deepEqual(c.sampleConfigurations, [0, 0]);
  const defaults = await read(fixture({ trexOnly: true }));
  assert.deepEqual(defaults.sampleDurations, [13, 10]); assert.deepEqual(defaults.sampleKeys, [false, false]);
  assert.equal(c.fragmentSequenceNumbers![1], c.fragmentSequenceNumbers![0] + 1);
});
test('tfdt v0/v1 preserve nonzero and 64-bit raw ticks; trun v0 CTO remains unsigned', async () => {
  assert.deepEqual((await read(fixture({ version: 0 }))).decodeTimes, [100, 113]);
  assert.deepEqual((await read(fixture({ ticks: 0x100000001n }))).decodeTimes, [4294967297, 4294967310]);
  assert.equal((await read(fixture({ ctoVersion: 0, cto: -2 }))).compositionOffsets![1], 4294967294);
  assert.equal((await read(fixture({ nextTicks: 124n }))).sampleSizes!.length, 4);
});
test('explicit base_data_offset and negative signed data_offset address preceding mdat', async () => {
  const first = init(), base = BigInt(first.length + 14);
  // A preceding mdat and explicit base use a negative run offset.
  const bytes = fixture({ before: true, base });
  assert.deepEqual((await read(bytes)).sampleOffsets, [first.length + 8, first.length + 11]);
});
for (const [name, options, pattern] of [
  ['missing tfdt', { missingTfdt: true }, /tfdt/], ['implicit base', { implicit: true }, /基址/],
  ['illegal description', { description: 2 }, /description/], ['multiple descriptions', { configs: 2 }, /description/],
  ['mixed progressive', { mixed: true }, /普通 samples/], ['zero duration', { duration: 0 }, /duration/],
  ['time rollback', { nextTicks: 99n }, /时间/], ['time gap', { nextTicks: 125n }, /时间/],
  ['unsafe tfdt', { ticks: 9007199254740992n }, /安全整数/], ['unsafe base', { base: 9007199254740992n }, /安全整数/],
  ['count overflow', { count: 100 }, /上限/], ['trun count truncated', { count: 2 }, /长度/],
] as const) test(`reject fragment ${name}`, async () => { await assert.rejects(read(fixture(options)), pattern); });
test('reject truncated mdat/moof and out-of-mdat offsets', async () => {
  const bytes = fixture(); await assert.rejects(read(bytes.subarray(0, bytes.length - 1)), /完整/);
  const offset = bytes.indexOf(Buffer.from('trun')) + 12;
  const broken = Buffer.from(bytes); broken.writeInt32BE(0, offset); await assert.rejects(read(broken), /mdat/);
  await assert.rejects(read(bytes.subarray(0, bytes.indexOf(Buffer.from('mdat')) - 3)), /box|截断/);
  await assert.rejects(read(fixture({ overlap: true })), /重叠/);
});
test('fragment metadata/sample budgets are enforced before allocating sample arrays', async () => {
  await assert.rejects(read(fixture(), 1), (e: any) => e.stage === 'resource');
  const payload = Buffer.alloc(24 * 1024 * 1024), bytes = Buffer.concat([init(), box('moof', payload)]);
  await assert.rejects(read(bytes), (e: any) => e.stage === 'resource');
});

test('sparse metadata reads use exact physical ranges, preserve ordinary cache and stop after close', async () => {
  const { RangeReader } = await import('../../shared/media/io/range-reader.ts');
  const data = new Uint8Array(1024 * 1024), blob = new Blob([data]), slice = blob.slice.bind(blob), ranges: [number, number][] = [];
  blob.slice = (a = 0, b = blob.size, type) => { ranges.push([a, b]); return slice(a, b, type); };
  const source = new RangeReader({ file: blob });
  await source.readMetadata(700000, 16); assert.deepEqual(ranges, [[700000, 700016]]); assert.deepEqual(source.cachedWindows(), []);
  await source.read(0, 16); const windows = source.cachedWindows(), reads = ranges.length;
  await source.readMetadata(4, 8); assert.equal(ranges.length, reads); assert.deepEqual(source.cachedWindows(), windows);
  await assert.rejects(source.readMetadata(blob.size - 1, 8), /越界/);
  source.close(); await assert.rejects(source.readMetadata(0, 8), /取消/);
});

test('fragment packet locators validate moof offsets but never assign discontinuous AU identities', async () => {
  const { validateFragmentPacket } = await import('../../shared/media/containers/mp4-config.ts'), config = await read(fixture());
  const packet = { sequenceNumber: config.fragmentSequenceNumbers![0], byteLength: 3, type: 'delta', timestamp: 1 };
  validateFragmentPacket(config, 0, packet, 1000);
  assert.throws(() => validateFragmentPacket(config, 0, { ...packet, sequenceNumber: 0 }, 1000), /mapping/);
  assert.throws(() => validateFragmentPacket(config, 0, { ...packet, timestamp: Number.MAX_SAFE_INTEGER }, 1), /mapping/);
});

test('QuickTime video extensions accept only the exact four-byte zero terminator', async () => {
  const clean = await read(fixture());
  const terminated = await read(fixture({ terminator: Buffer.alloc(4) }));
  assert.deepEqual(terminated.descriptions, clean.descriptions);
  assert.deepEqual(terminated.sampleSizes, clean.sampleSizes);
  for (const tail of [Buffer.alloc(3), Buffer.alloc(5), Buffer.from([0, 0, 0, 1])])
    await assert.rejects(read(fixture({ terminator: tail })), /box.*截断/);
  // A short child outside a video description is still corruption.
  const bad = Buffer.concat([init(), Buffer.alloc(4)]);
  await assert.rejects(read(bad), /box.*截断/);
});
