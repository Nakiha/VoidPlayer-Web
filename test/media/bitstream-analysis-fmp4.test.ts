import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { openAnalysisInput } from '../../src/bitstream-analysis/input.ts';
import { analyzePicture } from '../../src/bitstream-analysis/runner.ts';
import { Mp4Engine } from '../../src/mp4-engine.ts';
const signal = new AbortController().signal;
async function reader(file: string) { const data = await readFile(file); return { size: data.length, async read(o: number, n: number) { return data.subarray(o, o + n); }, close() {} }; }
async function core() { return (await import(pathToFileURL(resolve('public/vendor/voidplayer-analysis/voidplayer-analysis.js')).href)).default(); }
const target = (p: any) => ({ sourceVersion: 'fmp4-test', sourcePtsUs: p.pts, normalizedMediaUs: p.pts - 1600000 });
for (const codec of ['h264', 'hevc', 'vvc']) test(`finite fMP4 ${codec}: byte identity, independent current-frame answer and actual playback AU across nonkey fragments`, async () => {
  const file = `fixtures/fmp4-analysis/fragmented-${codec}.mp4`, sourceFile = { h264: 'h264_9s_1920x1080.mp4', hevc: 'h265_10s_1920x1080.mp4', vvc: 'h266_10s_1920x1080.mp4' }[codec]!;
  const input = await openAnalysisInput(await reader(file), signal), original = await openAnalysisInput(await reader(`fixtures/video/${sourceFile}`), signal);
  try {
    assert.equal(input.totalPackets, 600); assert.equal(input.indexIntegrity, 'complete'); assert.deepEqual(input.configurations, original.configurations);
    for (const p of input.packets) { assert.equal(p.au, input.packets.indexOf(p)); assert.deepEqual(await input.readUnit(p), await original.readUnit(original.packets[p.au])); assert.equal(p.timing!.dts, 96000 + p.au * 1000); }
    const answers = JSON.parse(await readFile('docs/fixtures/bitstream-analysis-answers.json', 'utf8'));
    const first = await analyzePicture(await reader(file), target(input.packets[0]), await core(), 'test', signal);
    for (const b of answers.find((a: any) => a.codec === codec).firstBlocks) assert.deepEqual(first.blocks.find(x => x.x === b.x && x.y === b.y), b);
    const rear = input.packets[200], r = await analyzePicture(await reader(file), target(rear), await core(), 'test', signal);
    const baseline = await analyzePicture(await reader(`fixtures/video/${sourceFile}`), { ...target(original.packets[200]), normalizedMediaUs: original.packets[200].pts - original.packets[0].pts }, await core(), 'test', signal);
    assert.deepEqual(r.blocks, baseline.blocks); assert.deepEqual(r.references, baseline.references); assert.ok(r.metrics!.startAu < 200, 'nonkey moof is not a random access point');
    const playback = new Mp4Engine({ file: new Blob([await readFile(file)]) });
    try { await playback.open(pathToFileURL(resolve('public/vendor/voidplayer-core/voidplayer-core.js')).href, new Uint8Array(await readFile('public/vendor/voidplayer-core/voidplayer-core.wasm')), true);
      for (const au of [0, 21, 200, 19, 599]) { const frame = await playback.at(input.packets[au].pts); assert.deepEqual(frame.packetPicture, { au, configuration: 0, stream: 'video' }); frame.frame?.close(); }
    } finally { playback.close(); }
  } finally { input.close(); original.close(); }
});

for (const codec of ['h264', 'hevc', 'vvc']) test(`fMP4 ${codec}: cross-fragment range, whole drain, cache holes, cancellation and actual rear Blob IO`, async () => {
  const { analyzeRange, analyzeStream } = await import('../../src/bitstream-analysis/runner.ts');
  const { pictureId } = await import('../../src/bitstream-analysis/contract.ts');
  const { RangeReader } = await import('../../src/range-reader.ts');
  const file = `fixtures/fmp4-analysis/fragmented-${codec}.mp4`, input = await openAnalysisInput(await reader(file), signal), cache = new Map<string, any>();
  const range = { sourceVersion: 'fmp4-test', firstPtsUs: input.packets[0].pts, startUs: 280000, endUs: 480000 };
  await analyzeRange(await reader(file), range, await core(), 'test', signal, async r => { cache.set(pictureId(r.picture), r); });
  assert.ok([...cache.values()].some(r => r.picture.au < 20) && [...cache.values()].some(r => r.picture.au >= 20), 'interval crosses a nonkey moof');
  await analyzeRange(await reader(file), range, () => assert.fail('cache hit opens no core'), 'test', signal, async r => { assert.equal(r, cache.get(pictureId(r.picture))); }, async p => cache.get(pictureId(p)) ?? null);
  const hole = [...cache.keys()][3], expected = cache.get(hole); cache.delete(hole); let repaired = false;
  await analyzeRange(await reader(file), range, await core(), 'test', signal, async r => { if (pictureId(r.picture) === hole) { assert.deepEqual(r.blocks, expected.blocks); repaired = true; } }, async p => cache.get(pictureId(p)) ?? null);
  assert.ok(repaired);
  const aus = new Set<number>(); let drains = 0; const module = await core(), drain = module._vpa_drain;
  module._vpa_drain = (...args: any[]) => { drains++; return drain(...args); };
  await analyzeStream(await reader(file), { mode: 'stream', sourceVersion: 'fmp4-test', firstPtsUs: input.packets[0].pts, durationUs: 10000000 }, module, 'test', signal, async r => {
    assert.equal(r.confidence, 'exact');
    assert.ok(!aus.has(r.picture.au), `duplicate whole-source AU ${r.picture.au}`); aus.add(r.picture.au);
    const e = cache.get(pictureId(r.picture)); if (e) assert.deepEqual(r.blocks, e.blocks);
  }, async () => {});
  assert.deepEqual([...aus].sort((a, b) => a - b), Array.from({ length: 600 }, (_, au) => au), 'whole source publishes every AU exactly once');
  assert.equal(drains, 1, 'only whole-source EOF drains, fragment boundaries never drain');
  const abort = new AbortController(), cancelledCore = await core(); let consumed = 0;
  await assert.rejects(analyzeStream(await reader(file), { mode: 'stream', sourceVersion: 'fmp4-test', firstPtsUs: input.packets[0].pts, durationUs: 10000000 }, cancelledCore, 'test', abort.signal,
    async () => { if (++consumed === 21) abort.abort(); }, async () => {}), { name: 'AbortError' });
  assert.equal(consumed, 21); assert.equal(cancelledCore._vpa_record_bytes(), 0);
  const bytes = await readFile(file);
  for (const au of [200, 400]) {
    let physical = 0; const blob = new Blob([bytes]), slice = blob.slice.bind(blob);
    blob.slice = (start = 0, end = blob.size, type) => { physical += end - start; return slice(start, end, type); };
    const r = await analyzePicture(new RangeReader({ file: blob }), target(input.packets[au]), await core(), 'test', signal);
    assert.equal(r.picture.au, au); assert.ok(r.metrics!.startAu > 0);
    assert.ok(physical < bytes.length / 2, `${codec} AU ${au}: actual Blob IO ${physical}/${bytes.length}`);
  }
  input.close();
});

test('fragmented VVC retains independent VTM I/B block hashes and reference answers', async () => {
  const { createHash } = await import('node:crypto');
  const expected = JSON.parse(await readFile('docs/fixtures/bitstream-analysis-vtm.json', 'utf8'));
  const file = 'fixtures/fmp4-analysis/fragmented-vvc.mp4', input = await openAnalysisInput(await reader(file), signal);
  try { for (const answer of expected.pictures) {
    const r = await analyzePicture(await reader(file), target(input.packets[answer.au]), await core(), 'test', signal);
    const blocks = r.blocks.map(b => [b.x, b.y, b.width, b.height, b.qp, b.mode]).sort((a: any[], b: any[]) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3]);
    assert.equal(createHash('sha256').update(JSON.stringify(blocks)).digest('hex'), answer.blocksSha256);
    assert.deepEqual([...r.references!.edges].sort((a, b) => a.list - b.list || a.au - b.au), answer.references);
  } } finally { input.close(); }
});

test('fMP4 raw decode ticks remain independent of edit-list-adjusted presentation microseconds', async () => {
  const bytes = await readFile('fixtures/fmp4-analysis/fragmented-h264.mp4');
  const box = (type: string, ...parts: Buffer[]) => { const payload = Buffer.concat(parts), h = Buffer.alloc(8); h.writeUInt32BE(payload.length + 8); h.write(type, 4); return Buffer.concat([h, payload]); };
  const elst = Buffer.alloc(20); elst.writeUInt32BE(1, 4); elst.writeUInt32BE(10000, 8); elst.writeInt32BE(96000, 12); elst.writeInt16BE(1, 16);
  const rewrite = (data: Buffer): Buffer => { const result = []; for (let at = 0; at < data.length;) { const size = data.readUInt32BE(at), type = data.toString('ascii', at + 4, at + 8), p = data.subarray(at + 8, at + size);
    result.push(['moov', 'trak'].includes(type) ? box(type, rewrite(p), ...(type === 'trak' ? [box('edts', box('elst', elst))] : [])) : data.subarray(at, at + size)); at += size; } return Buffer.concat(result); };
  const changed = rewrite(bytes), source = () => ({ size: changed.length, async read(o: number, n: number) { return changed.subarray(o, o + n); }, close() {} });
  const input = await openAnalysisInput(source(), signal);
  assert.equal(input.packets[0].pts, 0); assert.equal(input.packets[0].dts, 0); assert.equal(input.packets[0].timing!.dts, 96000); assert.equal(input.packets[0].timing!.pts, 96000);
  input.close();
});

test('real video-copy fMP4 with audio traf keeps video payload/config and playback/analysis identity', async () => {
  const file = 'fixtures/fmp4-analysis/fragmented-h264-audio.mp4', input = await openAnalysisInput(await reader(file), signal), source = await openAnalysisInput(await reader('fixtures/fmp4-analysis/fragmented-h264.mp4'), signal);
  try {
    assert.equal(input.totalPackets, source.totalPackets); assert.deepEqual(input.configurations, source.configurations);
    for (const p of input.packets) assert.deepEqual(await input.readUnit(p), await source.readUnit(source.packets[p.au]));
    const r = await analyzePicture(await reader(file), { ...target(input.packets[21]), normalizedMediaUs: input.packets[21].pts - input.packets[0].pts }, await core(), 'test', signal);
    const expected = await analyzePicture(await reader('fixtures/fmp4-analysis/fragmented-h264.mp4'), target(source.packets[21]), await core(), 'test', signal);
    assert.deepEqual(r.blocks, expected.blocks);
    const engine = new Mp4Engine({ file: new Blob([await readFile(file)]) });
    try { await engine.open(pathToFileURL(resolve('public/vendor/voidplayer-core/voidplayer-core.js')).href, new Uint8Array(await readFile('public/vendor/voidplayer-core/voidplayer-core.wasm')), true);
      const frame = await engine.at(input.packets[21].pts); assert.deepEqual(frame.packetPicture, { au: 21, configuration: 0, stream: 'video' }); frame.frame?.close();
    } finally { engine.close(); }
  } finally { input.close(); source.close(); }
});

for (const codec of ['h264', 'hevc', 'vvc']) test(`media library fMP4 ${codec}: independent stream index, cache restart and corrupt-hole repair`, async () => {
  const { MediaLibraryIndex } = await import('../../server/library.ts');
  const { AnalysisScheduler } = await import('../../server/analysis/scheduler.ts');
  const { mkdtemp, rm, mkdir, copyFile, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const temp = await mkdtemp(join(tmpdir(), 'vp-fmp4-analysis-'));
  const fullBytes = await readFile(`fixtures/fmp4-analysis/fragmented-${codec}.mp4`);
  const original = await openAnalysisInput(await reader(`fixtures/fmp4-analysis/fragmented-${codec}.mp4`), signal);
  const last = original.packets[119]; original.close();
  const media = join(temp, 'media'); await mkdir(media);
  await writeFile(join(media, `fragmented-${codec}.mp4`), fullBytes.subarray(0, last.offset + last.size));
  const library = new MediaLibraryIndex([media], { database: join(temp, 'library.sqlite'), watch: false });
  const coreDir = resolve('public/vendor/voidplayer-analysis'), directory = join(temp, 'analysis');
  let scheduler = new AnalysisScheduler(library, coreDir, directory);
  await library.refresh();
  const entry = (await library.list()).entries.find(e => e.name === `fragmented-${codec}.mp4`)!;
  const version = `${entry.id}@${entry.version}`;
  const demand = { mode: 'stream' as const, sourceVersion: version, firstPtsUs: 1600000, durationUs: 2000000 };
  const consume = async (requestId: string, expected?: Map<number, any>) => {
    const results = new Map<number, any>(); let cursor = 0;
    const until = performance.now() + 120000;
    for (;;) {
      assert.ok(performance.now() < until, 'bounded stream completion');
      const state = await scheduler.streamStatus(requestId, 'owner', cursor);
      assert.ok(state && ['queued', 'running', 'complete'].includes(state.state), JSON.stringify(state));
      for (const ref of state.chunks) {
        const r = await scheduler.store.get(ref.id);
        assert.equal(r?.confidence, 'exact'); assert.ok(!results.has(r!.picture.au));
        if (expected) assert.deepEqual(r!.blocks, expected.get(r!.picture.au).result.blocks);
        results.set(r!.picture.au, { id: ref.id, result: r }); cursor = ref.cursor;
      }
      if (state.state === 'complete' && cursor === state.published) { assert.equal(state.progress!.indexComplete, true); break; }
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(cursor, 120); return results;
  };
  try {
    const expected = await consume((await scheduler.submit(entry.id, entry.version!, demand, 'owner')).requestId);
    const local = await analyzePicture(await reader(`fixtures/fmp4-analysis/fragmented-${codec}.mp4`),
      { sourceVersion: version, sourcePtsUs: expected.get(60).result.sourcePtsUs, normalizedMediaUs: expected.get(60).result.sourcePtsUs - 1600000 }, await core(), 'test', signal);
    assert.deepEqual(local.blocks, expected.get(60).result.blocks); assert.deepEqual(local.references, expected.get(60).result.references);
    await scheduler.close();
    const manifestOnly = join(temp, 'manifest-only'); await mkdir(manifestOnly);
    await copyFile(join(coreDir, 'manifest.json'), join(manifestOnly, 'manifest.json'));
    scheduler = new AnalysisScheduler(library, manifestOnly, directory);
    const hits = await consume((await scheduler.submit(entry.id, entry.version!, demand, 'owner')).requestId, expected);
    assert.deepEqual(hits, expected, 'restart reuses every exact record without JS/WASM');
    await scheduler.close(); scheduler = new AnalysisScheduler(library, coreDir, directory);
    await writeFile(scheduler.store.chunkFile(expected.get(60).id), '{broken');
    await consume((await scheduler.submit(entry.id, entry.version!, demand, 'owner')).requestId, expected);
  } finally { await scheduler.close(); await library.close(); await rm(temp, { recursive: true, force: true }); }
});
