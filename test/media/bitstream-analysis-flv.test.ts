import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { openAnalysisInput } from '../../src/bitstream-analysis/input.ts';
import { analyzePicture, analyzeRange, analyzeStream } from '../../src/bitstream-analysis/runner.ts';
import { pictureId } from '../../src/bitstream-analysis/contract.ts';
import { FlvEngine } from '../../src/flv-engine.ts';
import { FLV_MEDIA_INDEX_IDENTITY } from '../../src/media-index-identity.ts';
import { validateStream } from '../../src/bitstream-analysis/contract.ts';
const signal = new AbortController().signal;
const answers = JSON.parse(await readFile('docs/fixtures/bitstream-analysis-answers.json', 'utf8'));
async function reader(file: string) {
  const data = await readFile(file);
  return { size: data.length, async read(offset: number, length: number) { return data.subarray(offset, offset + length); }, close() {} };
}
async function core() {
  return (await import(pathToFileURL(resolve('public/vendor/voidplayer-analysis/voidplayer-analysis.js')).href)).default();
}
const target = (p: any, version = 'flv-test') => ({ sourceVersion: version, sourcePtsUs: p.pts, normalizedMediaUs: p.pts - 2000000 });
for (const codec of ['h264', 'hevc', 'vvc']) for (const framing of ['legacy', 'enhanced']) {
  const name = `fixtures/flv-analysis/${framing}-${codec}`;
  test(`${framing} FLV ${codec}: independent answers, rear local/continuous, real playback key, sparse cache and cancellation`, async () => {
    const input = await openAnalysisInput(await reader(`${name}.flv`), signal);
    assert.equal(input.codec, codec); assert.equal(input.indexComplete, true); assert.equal(input.totalPackets, 600);
    const first = input.packets[0], rear = input.packets[200];
    assert.deepEqual(first.timing?.timebase, [1, 1000]);
    const result = await analyzePicture(await reader(`${name}.flv`), target(first), await core(), 'test', signal);
    assert.equal(result.confidence, 'exact');
    for (const b of answers.find((a: any) => a.codec === codec).firstBlocks)
      assert.deepEqual(result.blocks.find(x => x.x === b.x && x.y === b.y), b);
    const random = await analyzePicture(await reader(`${name}.flv`), target(rear), await core(), 'test', signal);
    const sequentialInput = await openAnalysisInput(await reader(`${name}.flv`), signal);
    const sequential = await analyzePicture(sequentialInput.reader, target(rear), await core(), 'test', signal, { input: sequentialInput, sequential: true });
    assert.deepEqual(random.blocks, sequential.blocks); assert.deepEqual(random.references, sequential.references);
    assert.ok(random.metrics!.startAu > 0, 'rear request uses verified closed source anchor');
    assert.ok(random.metrics!.packets < sequential.metrics!.packets);
    const playback = new FlvEngine({ file: new Blob([await readFile(`${name}.flv`)]) });
    try {
      await playback.open(pathToFileURL(resolve('public/vendor/voidplayer-core/voidplayer-core.js')).href, new Uint8Array(await readFile('public/vendor/voidplayer-core/voidplayer-core.wasm')), true);
      await playback.completeIndex();
      const frame = await playback.at(rear.pts);
      assert.deepEqual(frame.packetPicture, { au: rear.au, configuration: rear.configuration, stream: 'video' });
      frame.frame?.close();
      assert.equal(playback.index.packets[0].pts, 2000000, 'decode-order origin is stable');
    } finally { playback.close(); }
    const range = { sourceVersion: 'flv-test', firstPtsUs: first.pts, startUs: 0, endUs: 100000 };
    const cache = new Map<string, any>();
    await analyzeRange(await reader(`${name}.flv`), range, await core(), 'test', signal, async r => { cache.set(pictureId(r.picture), r); });
    await analyzeRange(await reader(`${name}.flv`), { ...range, endUs: 50000 }, () => assert.fail('cache hit does not open WASM'), 'test', signal,
      async r => { assert.equal(r, cache.get(pictureId(r.picture))); }, async p => cache.get(pictureId(p)) ?? null);
    const hole = [...cache.keys()][1], expected = cache.get(hole); cache.delete(hole);
    await analyzeRange(await reader(`${name}.flv`), range, await core(), 'test', signal,
      async r => { if (pictureId(r.picture) === hole) assert.deepEqual(r.blocks, expected.blocks); }, async p => cache.get(pictureId(p)) ?? null);
    const abort = new AbortController(), module = await core(); let consumed = 0, unknownCount = false;
    await assert.rejects(analyzeStream(await reader(`${name}.flv`), { mode: 'stream', sourceVersion: 'flv-test', firstPtsUs: first.pts, durationUs: 10000000 },
      module, 'test', abort.signal, async r => { assert.equal(r.confidence, 'exact'); if (++consumed === 30) abort.abort(); },
      async p => { unknownCount ||= p.totalPictures === null; }), { name: 'AbortError' });
    assert.equal(consumed, 30); assert.equal(module._vpa_record_bytes(), 0);
    input.close();
  });
}

test('FLV progressive index waits, emits sealed output before index EOF, resumes and cancels without draining', async () => {
  validateStream({ mode: 'stream', sourceVersion: 'flv', firstPtsUs: 2000000, durationUs: 10000000, indexIdentity: FLV_MEDIA_INDEX_IDENTITY });
  const file = 'fixtures/flv-analysis/legacy-h264.flv';
  let allowed = 62, complete = false, consumed = 0, waited!: () => void, released = false, unknown = false;
  const waiting = new Promise<void>(resolve => { waited = resolve; });
  const module = await core(), drain = module._vpa_drain; let drains = 0;
  module._vpa_drain = (...args: any[]) => { drains++; return drain(...args); };
  const run = analyzeStream(await reader(file), { mode: 'stream', sourceVersion: 'flv', firstPtsUs: 2000000, durationUs: 10000000 }, module, 'test', signal,
    async () => { consumed++; }, async p => { unknown ||= p.totalPictures === null; if (p.waitingForIndex && consumed) waited(); },
    async () => ({ packets: allowed, complete }));
  await Promise.race([waiting, new Promise((_, reject) => { const t = setTimeout(() => reject(Error('No pre-EOF output')), 20000); t.unref(); })]);
  assert.ok(consumed > 0 && consumed < 600); assert.equal(drains, 0); assert.equal(unknown, true);
  allowed = 600; complete = true; released = true; await run;
  assert.equal(consumed, 600); assert.equal(drains, 1); assert.equal(released, true);
  const controller = new AbortController(); let closed = false;
  const source = await reader(file); source.close = () => { closed = true; };
  await assert.rejects(analyzeStream(source, { mode: 'stream', sourceVersion: 'flv', firstPtsUs: 2000000, durationUs: 10000000 },
    () => assert.fail('no decoder while waiting'), 'test', controller.signal, async () => assert.fail('no output'),
    async p => { if (p.waitingForIndex) controller.abort(); }, async () => ({ packets: 0, complete: false })), { name: 'AbortError' });
  assert.equal(closed, true);
});

test('FLV tail and recovered gap preserve source identities and reset same-config references at a closed anchor', async () => {
  for (const suffix of ['tail', 'gap', 'sequence']) {
    const file = `fixtures/flv-analysis/legacy-h264-${suffix}.flv`;
    const input = await openAnalysisInput(await reader(file), signal);
    assert.equal(input.indexIntegrity, suffix === 'tail' ? 'prefix' : suffix === 'gap' ? 'recovered' : 'complete');
    assert.equal(input.indexTruncatedAt !== undefined, suffix === 'tail');
    const boundary = input.packets.find(p => p.discontinuity);
    if (suffix === 'gap') assert.ok(boundary);
    const targetPacket = boundary ?? input.packets[200];
    const result = await analyzePicture(await reader(file), target(targetPacket), await core(), 'test', signal);
    assert.equal(result.confidence, 'exact'); assert.equal(result.picture.au, targetPacket.au);
    const baseline = await analyzePicture(await reader('fixtures/flv-analysis/legacy-h264.flv'), target(targetPacket), await core(), 'test', signal);
    assert.deepEqual(result.blocks, baseline.blocks);
    input.close();
  }
});

for (const codec of ['h264', 'hevc']) test(`real FLV ${codec} configuration change: range, stream and seek identities`, async () => {
  const { resolutionFlv } = await import('../../scripts/flv-resolution-fixture.ts');
  const bytes = await resolutionFlv(codec, ['320x192', '640x384']);
  const source = () => ({ size: bytes.length, async read(o: number, n: number) { return bytes.subarray(o, o + n); }, close() {} });
  const input = await openAnalysisInput(source(), signal);
  assert.equal(input.configurations.length, 2);
  const results = new Map<number, any>();
  await analyzeRange(source(), { sourceVersion: 'config', firstPtsUs: input.packets[0].pts, startUs: 500000, endUs: 1500000 },
    await core(), 'test', signal, async r => { results.set(r.picture.au, r); });
  assert.equal(results.size, 10);
  await analyzeStream(source(), { mode: 'stream', sourceVersion: 'config', firstPtsUs: input.packets[0].pts, durationUs: 2000000 },
    await core(), 'test', signal, async r => {
      if (results.has(r.picture.au)) assert.deepEqual(r.blocks, results.get(r.picture.au).blocks);
      assert.equal(r.picture.configuration, r.picture.au < 10 ? 0 : 1);
      assert.equal(r.width, r.picture.au < 10 ? 320 : 640);
    }, async () => {});
  const engine = new FlvEngine({ file: new Blob([Uint8Array.from(bytes)]) });
  try {
    await engine.open(pathToFileURL(resolve('public/vendor/voidplayer-core/voidplayer-core.js')).href,
      new Uint8Array(await readFile('public/vendor/voidplayer-core/voidplayer-core.wasm')), true);
    await engine.completeIndex();
    for (const au of [14, 4, 19, 0]) {
      const frame = await engine.at(input.packets[au].pts);
      assert.deepEqual(frame.packetPicture, { au, configuration: au < 10 ? 0 : 1, stream: 'video' }); frame.frame?.close();
    }
  } finally { engine.close(); input.close(); }
});

test('duplicate FLV source timestamps reject analysis and actual playback omits precise picture identity', async () => {
  const bytes = await readFile('fixtures/flv-analysis/legacy-h264.flv');
  const source = () => ({ size: bytes.length, async read(o: number, n: number) { return bytes.subarray(o, o + n); }, close() {} });
  const original = await openAnalysisInput(source(), signal), a = original.packets[30], b = original.packets[31];
  bytes.writeUIntBE(((a.pts - b.dts) / 1000) & 0xffffff, b.offset - 3, 3); original.close();
  await assert.rejects(analyzePicture(source(), target(a), await core(), 'test', signal), (e: any) => e.code === 'ambiguous-picture-identity');
  const engine = new FlvEngine({ file: new Blob([Uint8Array.from(bytes)]) });
  try {
    await engine.open(pathToFileURL(resolve('public/vendor/voidplayer-core/voidplayer-core.js')).href,
      new Uint8Array(await readFile('public/vendor/voidplayer-core/voidplayer-core.wasm')), true);
    await engine.completeIndex();
    const frame = await engine.at(a.pts); assert.equal(frame.packetPicture, undefined); frame.frame?.close();
  } finally { engine.close(); }
});

for (const codec of ['h264', 'hevc', 'vvc']) test(`media library FLV ${codec}: independent stream index, cache restart and corrupt-hole repair`, async () => {
  const { MediaLibraryIndex } = await import('../../server/library.ts');
  const { AnalysisScheduler } = await import('../../server/analysis/scheduler.ts');
  const { mkdtemp, rm, mkdir, copyFile, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const temp = await mkdtemp(join(tmpdir(), 'vp-flv-analysis-'));
  const fullBytes = await readFile(`fixtures/flv-analysis/legacy-${codec}.flv`);
  const original = await openAnalysisInput(await reader(`fixtures/flv-analysis/legacy-${codec}.flv`), signal);
  const last = original.packets[119]; original.close();
  const media = join(temp, 'media'); await mkdir(media);
  await writeFile(join(media, `legacy-${codec}.flv`), fullBytes.subarray(0, last.offset + last.size + 4));
  const library = new MediaLibraryIndex([media], { database: join(temp, 'library.sqlite'), watch: false });
  const coreDir = resolve('public/vendor/voidplayer-analysis'), directory = join(temp, 'analysis');
  let scheduler = new AnalysisScheduler(library, coreDir, directory);
  await library.refresh();
  const entry = (await library.list()).entries.find(e => e.name === `legacy-${codec}.flv`)!;
  const version = `${entry.id}@${entry.version}`;
  const demand = { mode: 'stream' as const, sourceVersion: version, firstPtsUs: 2000000, durationUs: 10000000, indexIdentity: FLV_MEDIA_INDEX_IDENTITY };
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
    const local = await analyzePicture(await reader(`fixtures/flv-analysis/legacy-${codec}.flv`),
      { sourceVersion: version, sourcePtsUs: expected.get(60).result.sourcePtsUs, normalizedMediaUs: expected.get(60).result.sourcePtsUs - 2000000 }, await core(), 'test', signal);
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

test('FLV adapter preserves anomalous DTS and signed CTS instead of repairing the source clock', async () => {
  const bytes = await readFile('fixtures/flv-analysis/legacy-h264.flv');
  const source = () => ({ size: bytes.length, async read(o: number, n: number) { return bytes.subarray(o, o + n); }, close() {} });
  const before = await openAnalysisInput(source(), signal), p = before.packets[87]; before.close();
  // A legal 32-bit timestamp jump and negative composition offset. Keep the
  // actual source values; no nearest-PTS, monotonic timestamp repair or remux.
  const dts = 0xf0000000, cts = -100;
  bytes.writeUIntBE(dts & 0xffffff, p.offset - 12, 3); bytes[p.offset - 9] = dts >>> 24;
  bytes.writeUIntBE(cts & 0xffffff, p.offset - 3, 3);
  const input = await openAnalysisInput(source(), signal);
  const actual = input.packets[87];
  assert.equal(actual.dts, dts * 1000); assert.equal(actual.pts, (dts + cts) * 1000);
  assert.deepEqual(actual.timing, { pts: dts + cts, dts, timebase: [1, 1000] });
  assert.equal(input.packets[0].pts, 2000000, 'the first decode-order key remains media zero');
  const r = await analyzePicture(source(), target(actual), await core(), 'test', signal);
  assert.equal(r.sourcePtsUs, actual.pts); assert.equal(r.sourceDtsUs, actual.dts); assert.equal(r.picture.au, 87);
  input.close();
});

test('library FLV frontier uses validated scanner progress and a parsed final document, never FFmpeg binary records', async () => {
  const { libraryAnalysisIndex } = await import('../../server/analysis/index.ts');
  const { serializeFlvIndex } = await import('../../src/flv-index-cache.ts');
  const { demuxFlv } = await import('../../src/flv-demux.ts');
  const source = await reader('fixtures/flv-analysis/legacy-h264.flv');
  const index = await demuxFlv(source);
  let onProgress: any, done = false, unsubscribed = false;
  const library: any = { metadata: () => ({ version: 'v', size: source.size }), resolve: async () => 'file',
    indexJobs: { startBuild(_request: any, options: any) { onProgress = options.onProgress; return { promise: Promise.resolve(), unsubscribe() { unsubscribed = true; } }; },
      async call(op: string) {
        if (op === 'epoch') return 1;
        if (op === 'stream-manifest') return { epoch: 1, manifest: done ? { complete: true } : null };
        if (op === 'get') return Buffer.from(JSON.stringify({ epoch: 1, index: serializeFlvIndex(index, source.size) }));
        assert.fail(`unexpected binary index operation ${op}`);
      } } };
  const subscription = await libraryAnalysisIndex(library, 'id', 'v', 'file', FLV_MEDIA_INDEX_IDENTITY);
  onProgress({ packets: 61 }); assert.deepEqual(await subscription.read(), { packets: 61, complete: false });
  done = true; assert.deepEqual(await subscription.read(), { packets: 600, complete: true });
  subscription.close(); assert.equal(unsubscribed, true);
});

test('both FLV VVC framings retain the independent VTM I/B block and reference answers', async () => {
  const { createHash } = await import('node:crypto');
  const expected = JSON.parse(await readFile('docs/fixtures/bitstream-analysis-vtm.json', 'utf8'));
  for (const framing of ['legacy', 'enhanced']) {
    const file = `fixtures/flv-analysis/${framing}-vvc.flv`, input = await openAnalysisInput(await reader(file), signal);
    for (const answer of expected.pictures) {
      const r = await analyzePicture(await reader(file), target(input.packets[answer.au]), await core(), 'test', signal);
      const blocks = r.blocks.map(b => [b.x, b.y, b.width, b.height, b.qp, b.mode])
        .sort((a: any[], b: any[]) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3]);
      assert.equal(createHash('sha256').update(JSON.stringify(blocks)).digest('hex'), answer.blocksSha256);
      assert.deepEqual([...r.references!.edges].sort((a, b) => a.list - b.list || a.au - b.au), answer.references);
    }
    input.close();
  }
});

test('cancelled FLV adapter acquisition closes its independently owned reader exactly once', async () => {
  const input = await reader('fixtures/flv-analysis/legacy-h264.flv'), controller = new AbortController();
  let closes = 0; input.close = () => { closes++; };
  await assert.rejects(openAnalysisInput(input, controller.signal, true, {
    frontier: async () => ({ packets: 0, complete: false }), waiting: async () => controller.abort(),
  }), { name: 'AbortError' });
  assert.equal(closes, 1);
});
