import { test } from "node:test";
import assert from "node:assert/strict";
import { open, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { analyzePicture } from "../../src/bitstream-analysis/runner.ts";
import { openAnalysisInput } from "../../src/bitstream-analysis/input.ts";
const fixtures = JSON.parse(
  await readFile(
    new URL(
      "../../docs/fixtures/bitstream-analysis-answers.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
async function reader(name: string) {
  const file = await open(resolve("fixtures/video", name));
  const { size } = await file.stat();
  return {
    size,
    async read(offset: number, length: number) {
      const bytes = new Uint8Array(length);
      const result = await file.read(bytes, 0, length, offset);
      assert.equal(result.bytesRead, length);
      return bytes;
    },
    close() {
      void file.close();
    },
  };
}
async function core() {
  const module = await import(
    pathToFileURL(
      resolve("public/vendor/voidplayer-analysis/voidplayer-analysis.js"),
    ).href
  );
  return module.default();
}
for (const fixture of fixtures)
  test(`real ${fixture.codec} output matches independently frozen native records`, async () => {
    assert.equal(
      createHash("sha256")
        .update(await readFile(resolve("fixtures/video", fixture.file)))
        .digest("hex"),
      fixture.sha256,
      "fixture identity",
    );
    const input = await openAnalysisInput(
      await reader(fixture.file),
      new AbortController().signal,
    );
    const first = input.packets.reduce(
      (min, p) => Math.min(min, p.pts),
      Infinity,
    );
    input.close();
    const module = await core(),
      result = await analyzePicture(
        await reader(fixture.file),
        {
          sourceVersion: fixture.sha256,
          sourcePtsUs: first,
          normalizedMediaUs: 0,
        },
        module,
        "test",
        new AbortController().signal,
      );
    assert.equal(result.confidence, "exact");
    assert.equal(result.picture.au, fixture.pictureAu);
    assert.ok(result.blocks.length > 0);
    for (const block of fixture.firstBlocks)
      assert.deepEqual(
        result.blocks.find((b) => b.x === block.x && b.y === block.y),
        block,
      );
    assert.equal(
      module._vpa_record_bytes(),
      0,
      "close releases analysis records",
    );
  });
test("random rear H264 target uses a closed IDR and agrees with sequential analysis", async () => {
  const name = fixtures[0].file,
    input = await openAnalysisInput(
      await reader(name),
      new AbortController().signal,
    );
  const packet = input.packets[200],
    target = {
      sourceVersion: "session-file",
      sourcePtsUs: packet.pts,
      normalizedMediaUs: packet.pts,
    };
  input.close();
  const a = await analyzePicture(
      await reader(name),
      target,
      await core(),
      "test",
      new AbortController().signal,
    ),
    b = await analyzePicture(
      await reader(name),
      target,
      await core(),
      "test",
      new AbortController().signal,
      { sequential: true },
    );
  assert.equal(a.confidence, "exact");
  assert.ok(a.metrics.startAu > 0);
  assert.ok(a.metrics.packets < b.metrics.packets);
  assert.deepEqual(a.blocks, b.blocks);
  assert.deepEqual(a.picture, b.picture);
});
test("bounded range uses one decoder and drains each picture before accepting more input", async () => {
  const { analyzeRange } = await import(
    "../../src/bitstream-analysis/runner.ts"
  );
  const results = [] as any[],
    module = await core();
  await analyzeRange(
    await reader(fixtures[0].file),
    { sourceVersion: "range-file", firstPtsUs: 0, startUs: 0, endUs: 100000 },
    module,
    "test",
    new AbortController().signal,
    async (result) => {
      results.push(result);
      assert.ok(module._vpa_record_bytes() < 32 * 1024 * 1024);
      await new Promise((r) => setTimeout(r, 10));
    },
  );
  assert.ok(results.length >= 5);
  assert.equal(new Set(results.map((r) => r.picture.au)).size, results.length);
  assert.ok(results.every((r) => r.confidence === "exact"));
  assert.equal(module._vpa_record_bytes(), 0);
  const index = await openAnalysisInput(
      await reader(fixtures[0].file),
      new AbortController().signal,
    ),
    p = index.packets[560];
  index.close();
  const rear = await analyzePicture(
    await reader(fixtures[0].file),
    {
      sourceVersion: "rear-file",
      sourcePtsUs: p.pts,
      normalizedMediaUs: p.pts,
    },
    await core(),
    "test",
    new AbortController().signal,
  );
  assert.equal(rear.confidence, "exact");
  assert.ok(rear.metrics.startAu >= 540);
  assert.ok(rear.metrics.packets < 64);
});

for (const fixture of fixtures)
  test(`600-picture ${fixture.codec} drain, B-frame identity, rear GOP agreement and bounded records`, async () => {
    const input = await openAnalysisInput(
        await reader(fixture.file),
        new AbortController().signal,
      ),
      module = await core(),
      description = input.configurations[0];
    const pointer = module._malloc(description.length);
    module.HEAPU8.set(description, pointer);
    assert.equal(
      module._vpa_open(
        ({ h264: 1, hevc: 2, vvc: 3 } as Record<string, number>)[fixture.codec],
        pointer,
        description.length,
      ),
      0,
    );
    module._free(pointer);
    let cursor = 0,
      outputs = 0,
      peak = 0,
      earlyPeak = 0,
      paused = false,
      draining = false;
    const order: number[] = [],
      snapshots = new Map<number, any[]>();
    const selected = new Set([104, 232, 584]);
    let lastPts = -Infinity,
      earlyHeap = 0,
      peakHeap = 0;
    try {
      for (let iterations = 0; iterations < 5000; iterations++) {
        peak = Math.max(peak, module._vpa_record_bytes());
        peakHeap = Math.max(peakHeap, module.HEAPU8.length);
        if (cursor < 100) earlyHeap = Math.max(earlyHeap, module.HEAPU8.length);
        if (cursor < 100)
          earlyPeak = Math.max(earlyPeak, module._vpa_record_bytes());
        const state = module._vpa_step();
        if (state === 1) {
          const au = module._vpa_ordinal(),
            pts = module._vpa_pts();
          assert.equal(module._vpa_reference_abi(), 1);
          assert.equal(module._vpa_refs_invalid(), 0, `reference IDs ${fixture.codec} AU ${au}`);
          const refCount = module._vpa_ref_count(), refView = new DataView(module.HEAPU8.buffer, module._vpa_refs(), refCount * 8);
          for (let i = 0; i < refCount; i++) {
            assert.ok(refView.getUint32(i * 8, true) < au, 'references use earlier source decode ordinals');
            assert.ok(refView.getUint32(i * 8 + 4, true) <= 1);
          }
          if (module._vpa_picture_type() === 2) assert.equal(refCount, 0, 'I pictures have no active reference lists');

          assert.equal(
            module._vpa_invalid(),
            0,
            `valid ${fixture.codec} AU ${au}`,
          );
          assert.equal(
            pts,
            input.packets[au].pts,
            "COPY_OPAQUE keeps source AU and exact PTS through reorder",
          );
          assert.ok(
            pts > lastPts,
            "display PTS is strictly ordered, never guessed",
          );
          lastPts = pts;
          order.push(au);
          if (selected.has(au)) {
            const blocks = [],
              view = new DataView(
                module.HEAPU8.buffer,
                module._vpa_blocks(),
                module._vpa_count() * 12,
              );
            for (let n = 0; n < module._vpa_count(); n++) {
              const at = n * 12;
              blocks.push({
                x: view.getUint16(at, true),
                y: view.getUint16(at + 2, true),
                width: view.getUint16(at + 4, true),
                height: view.getUint16(at + 6, true),
                qp: view.getInt16(at + 8, true),
                mode: ({ 1: "intra", 2: "inter", 3: "skip" } as any)[
                  view.getUint8(at + 10)
                ],
              });
            }
            snapshots.set(au, blocks);
          }
          if (!paused) {
            const before = module._vpa_record_bytes(),
              count = module._vpa_count();
            assert.ok(count > 0);
            assert.ok(
              module._vpa_take(1) < 0,
              "oversized picture is explicitly rejected",
            );
            for (let i = 0; i < 100; i++) assert.equal(module._vpa_step(), 1);
            assert.equal(
              module._vpa_record_bytes(),
              before,
              "paused take does not produce another picture",
            );
            assert.equal(module._vpa_count(), count);
            paused = true;
          }
          assert.ok(module._vpa_take(8 * 1024 * 1024) > 0);
          outputs++;
          continue;
        }
        if (state === 2) break;
        assert.equal(state, 0);
        const packet = input.packets[cursor];
        if (!packet) {
          assert.equal(draining, false);
          assert.equal(module._vpa_drain(), 0);
          draining = true;
          continue;
        }
        const bytes = await input.read(packet.offset, packet.size),
          ptr = module._malloc(bytes.length);
        module.HEAPU8.set(bytes, ptr);
        const sent = module._vpa_feed(
          ptr,
          bytes.length,
          packet.pts,
          packet.dts,
          packet.au,
        );
        module._free(ptr);
        assert.ok(sent === 0 || sent === 2);
        if (sent === 0) cursor++;
      }
      assert.equal(outputs, input.packets.length);
      assert.ok(outputs >= 600);
      assert.equal(new Set(order).size, outputs, "each source AU seals once");
      assert.ok(
        order.some((au, n) => n > 0 && au < order[n - 1]),
        "fixture exercises B-frame reorder",
      );
      assert.ok(
        peakHeap <= 512 * 1024 * 1024 && peakHeap <= earlyHeap * 2,
        "heap reaches a bounded steady state",
      );
      assert.ok(
        peak <= earlyPeak * 2,
        "record storage reaches a steady bound instead of growing with total pictures",
      );
    } finally {
      module._vpa_close();
      input.close();
    }
    assert.equal(module._vpa_record_bytes(), 0);
    const starts = [];
    for (const au of selected) {
      const packet = input.packets[au];
      const random = await analyzePicture(
        await reader(fixture.file),
        {
          sourceVersion: "lifecycle-" + fixture.codec,
          sourcePtsUs: packet.pts,
          normalizedMediaUs: packet.pts - input.packets[0].pts,
        },
        await core(),
        "test",
        new AbortController().signal,
      );
      assert.equal(random.confidence, "exact");
      assert.equal(random.picture.au, au);
      assert.deepEqual(
        random.blocks,
        snapshots.get(au),
        "rear random analysis agrees with the continuous sequential decoder",
      );
      assert.ok(random.metrics.startAu > 0 && random.metrics.packets < 100);
      starts.push(random.metrics.startAu);
    }
    assert.equal(
      new Set(starts).size,
      3,
      "random targets span multiple closed GOPs",
    );
    const { mkdir, writeFile } = await import("node:fs/promises");
    const folder =
      process.env.VOIDPLAYER_TEST_ARTIFACTS ?? ".run/analysis-lifecycle";
    await mkdir(folder, { recursive: true });
    await writeFile(
      resolve(folder, fixture.codec + "-lifecycle.json"),
      JSON.stringify(
        {
          codec: fixture.codec,
          outputs,
          peakRecordBytes: peak,
          earlyRecordBytes: earlyPeak,
          peakHeapBytes: peakHeap,
          earlyHeapBytes: earlyHeap,
          targets: [...selected],
          anchors: starts,
          reordered: true,
        },
        null,
        2,
      ),
    );
  });

test("encoder-controlled flat H264 has a manually checkable macroblock grid, luma QP and intra mode", async () => {
  const { execFileSync } = await import("node:child_process");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const folder = await mkdtemp(join(tmpdir(), "vp-known-grid-")),
    file = join(folder, "flat.mp4");
  try {
    execFileSync("ffmpeg", [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=black:size=32x32:rate=1:duration=1",
      "-an",
      "-c:v",
      "libx264",
      "-qp",
      "17",
      "-x264-params",
      "ipratio=1:pbratio=1:aq-mode=0:mbtree=0:scenecut=0",
      "-pix_fmt",
      "yuv420p",
      file,
    ]);
    const source = await open(file),
      { size } = await source.stat();
    const input = {
      size,
      async read(offset: number, length: number) {
        const bytes = new Uint8Array(length);
        await source.read(bytes, 0, length, offset);
        return bytes;
      },
      close() {
        void source.close();
      },
    };
    const result = await analyzePicture(
      input,
      {
        sourceVersion: "manual-32x32-qp17",
        sourcePtsUs: 0,
        normalizedMediaUs: 0,
      },
      await core(),
      "test",
      new AbortController().signal,
    );
    assert.equal(result.confidence, "exact");
    assert.deepEqual(result.blocks, [
      { x: 0, y: 0, width: 16, height: 16, qp: 17, mode: "intra" },
      { x: 16, y: 0, width: 16, height: 16, qp: 17, mode: "intra" },
      { x: 0, y: 16, width: 16, height: 16, qp: 17, mode: "intra" },
      { x: 16, y: 16, width: 16, height: 16, qp: 17, mode: "intra" },
    ]);
    assert.equal(result.qp.mean, 17);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("fixed-size HEVC CUs and fixed luma QP have an encoder-controlled independent answer", async () => {
  const { execFileSync } = await import("node:child_process");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const folder = await mkdtemp(join(tmpdir(), "vp-known-hevc-")),
    file = join(folder, "flat.mp4");
  try {
    execFileSync("ffmpeg", [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=black:size=64x64:rate=1:duration=1",
      "-an",
      "-c:v",
      "libx265",
      "-x265-params",
      "pools=1:frame-threads=1:log-level=error:qp=17:ipratio=1:aq-mode=0:cutree=0:ctu=32:min-cu-size=32",
      "-pix_fmt",
      "yuv420p",
      file,
    ]);
    const source = await open(file),
      { size } = await source.stat();
    const input = {
      size,
      async read(offset: number, length: number) {
        const bytes = new Uint8Array(length);
        await source.read(bytes, 0, length, offset);
        return bytes;
      },
      close() {
        void source.close();
      },
    };
    const result = await analyzePicture(
      input,
      {
        sourceVersion: "manual-hevc-64x64-qp17",
        sourcePtsUs: 0,
        normalizedMediaUs: 0,
      },
      await core(),
      "test",
      new AbortController().signal,
    );
    assert.equal(result.confidence, "exact");
    assert.deepEqual(result.blocks, [
      { x: 0, y: 0, width: 32, height: 32, qp: 17, mode: "intra" },
      { x: 32, y: 0, width: 32, height: 32, qp: 17, mode: "intra" },
      { x: 0, y: 32, width: 32, height: 32, qp: 17, mode: "intra" },
      { x: 32, y: 32, width: 32, height: 32, qp: 17, mode: "intra" },
    ]);
    assert.equal(result.qp.mean, 17);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("corrupted AU is never marked exact and closes its isolated core", async () => {
  const source = await reader(fixtures[0].file),
    index = await openAnalysisInput(
      { ...source, close() {} },
      new AbortController().signal,
    ),
    packet = index.packets[0];
  index.close();
  const module = await core();
  await assert.rejects(
    analyzePicture(
      {
        size: source.size,
        async read(offset: number, length: number) {
          const bytes = await source.read(offset, length);
          if (offset === packet.offset && length === packet.size) bytes.fill(0);
          return bytes;
        },
        close() {
          source.close();
        },
      },
      {
        sourceVersion: "corrupt",
        sourcePtsUs: packet.pts,
        normalizedMediaUs: 0,
      },
      module,
      "test",
      new AbortController().signal,
    ),
    /random access|picture layout/,
  );
  assert.equal(module._vpa_record_bytes(), 0);
});

for (const fixture of fixtures) test(`whole ${fixture.codec} stream keeps one decoder across GOP/chunks and drains every AU`, async () => {
  const { analyzeStream } = await import('../../src/bitstream-analysis/runner.ts');
  const module = await core(), originalOpen = module._vpa_open, originalFeed = module._vpa_feed;
  let opens = 0, feeds = 0, pictures = 0;
  module._vpa_open = (...args: any[]) => { opens++; return originalOpen(...args); };
  module._vpa_feed = (...args: any[]) => { feeds++; return originalFeed(...args); };
  const aus = new Set<number>(), groups = new Set<number>(), progress: any[] = [];
  await analyzeStream(await reader(fixture.file), { mode: 'stream', sourceVersion: fixture.sha256,
    firstPtsUs: 0, durationUs: 10000000 }, module, 'test', new AbortController().signal,
    async result => {
      assert.equal(result.confidence, 'exact'); assert.ok(result.gop);
      assert.ok(result.nalus?.length); assert.equal(result.references?.state, 'ready');
      assert.ok(result.references!.edges.every(e => e.au < result.picture.au));
      assert.ok(result.picture.au >= result.gop.startAu && result.picture.au < result.gop.endAu);
      assert.equal(aus.has(result.picture.au), false); aus.add(result.picture.au); groups.add(result.gop.startAu);
      pictures++;
      if (result.picture.au === fixture.pictureAu)
        for (const block of fixture.firstBlocks) assert.deepEqual(result.blocks.find(b => b.x === block.x && b.y === block.y), block);
      if (pictures === 40) {
        const before = feeds;
        await new Promise(resolve => setTimeout(resolve, 30));
        assert.equal(feeds, before, 'consumer pause stops feeding the same decoder');
      }
    }, async value => { progress.push(value); });
  assert.equal(opens, 1, 'no reopen at GOP or chunk boundary');
  assert.equal(pictures, feeds); assert.ok(pictures >= 600 && groups.size > 1);
  assert.equal(progress.at(-1).pictures, pictures); assert.equal(progress.at(-1).checkedUs, 10000000);
  assert.equal(module._vpa_record_bytes(), 0);
});

test('cancelling a continuous stream preserves completed pictures and closes its reader/core', async () => {
  const { analyzeStream } = await import('../../src/bitstream-analysis/runner.ts');
  const controller = new AbortController(), module = await core(), input = await reader(fixtures[0].file);
  const close = input.close; let closed = 0, pictures = 0;
  input.close = () => { closed++; close(); };
  await assert.rejects(analyzeStream(input, { mode: 'stream', sourceVersion: 'cancel-file', firstPtsUs: 0, durationUs: 10000000 },
    module, 'test', controller.signal, async result => {
      assert.equal(result.confidence, 'exact'); pictures++;
      if (pictures === 40) controller.abort();
    }, async () => {}), { name: 'AbortError' });
  assert.equal(pictures, 40); assert.equal(closed, 1); assert.equal(module._vpa_record_bytes(), 0);
});

test('continuous execution reopens only on a verified configuration boundary and retains stable AU identity', async () => {
  const { inspectPacketPicture } = await import('../../src/packet-picture.ts');
  const { groupAnalysisGops } = await import('../../src/bitstream-analysis/stream.ts');
  const signal = new AbortController().signal;
  const input = await openAnalysisInput(await reader(fixtures[0].file), signal, true);
  const groups = groupAnalysisGops(input.packets);
  const boundary = groups[1].startAu, end = groups[2].startAu;
  const packet = input.packets[boundary];
  assert.equal(inspectPacketPicture(input.codec, input.configurations[0], await input.read(packet.offset, packet.size)).closedRandomAccess, true);
  input.packets.splice(end); input.totalPackets = end;
  input.configurations[1] = input.configurations[0];
  for (const p of input.packets) if (p.au >= boundary) p.configuration = 1;
  const module = await core(), original = module._vpa_open;
  let opens = 0; module._vpa_open = (...args: any[]) => { opens++; return original(...args); };
  const results = new Set<number>();
  await analyzePicture(input.reader, { sourceVersion: 'configuration-fixture', sourcePtsUs: input.packets[0].pts, normalizedMediaUs: 0 },
    module, 'test', signal, { input, sequential: true,
      stream: { mode: 'stream', sourceVersion: 'configuration-fixture', firstPtsUs: 0, durationUs: 3000000 },
      onResult: async result => {
        assert.equal(result.confidence, 'exact'); assert.ok(result.gop);
      assert.ok(result.nalus?.length); assert.equal(result.references?.state, 'ready');
      assert.ok(result.references!.edges.every(e => e.au < result.picture.au));
        assert.equal(result.picture.configuration, result.picture.au >= boundary ? 1 : 0); results.add(result.picture.au);
      } });
  assert.equal(opens, 2); assert.equal(results.size, end); assert.equal(module._vpa_record_bytes(), 0);
});

for (const fixture of fixtures) test(`incremental ${fixture.codec} index emits results before EOF and resumes the same decoder`, async () => {
  const { analyzeStream } = await import('../../src/bitstream-analysis/runner.ts');
  const { groupAnalysisGops } = await import('../../src/bitstream-analysis/stream.ts');
  const plan = await openAnalysisInput(await reader(fixture.file), new AbortController().signal, true);
  const groups = groupAnalysisGops(plan.packets), total = plan.packets.length;
  const boundary = groups[1].startAu;
  const expected = plan.packets.map(p => p.pts); plan.close();
  let allowed = boundary + 1, complete = false, pictures = 0, opens = 0, drains = 0;
  let waited!: () => void;
  const waiting = new Promise<void>(resolve => { waited = resolve; });
  const module = await core(), open = module._vpa_open, drain = module._vpa_drain;
  module._vpa_open = (...args: any[]) => { opens++; return open(...args); };
  module._vpa_drain = (...args: any[]) => { drains++; return drain(...args); };
  const run = analyzeStream(await reader(fixture.file), { mode: 'stream', sourceVersion: fixture.sha256,
    firstPtsUs: 0, durationUs: 10000000 }, module, 'test', new AbortController().signal,
    async result => {
      assert.equal(result.sourcePtsUs, expected[result.picture.au]);
      assert.equal(result.confidence, 'exact'); pictures++;
      if (!complete) assert.equal(result.gop!.endAu, boundary, 'only sealed first GOP is published');
    }, async progress => { if (progress.waitingForIndex && pictures) waited(); },
    async () => ({ packets: allowed, complete }));
  await Promise.race([waiting, new Promise((_, reject) => { const t = setTimeout(() => reject(Error('No output before index EOF')), 15000); t.unref(); })]);
  assert.ok(pictures > 0 && pictures < total); assert.equal(opens, 1); assert.equal(drains, 0, 'catching index never drains the decoder');
  const before = pictures; await new Promise(resolve => setTimeout(resolve, 40)); assert.equal(pictures, before);
  allowed = total; complete = true;
  await run;
  assert.equal(pictures, total); assert.equal(opens, 1); assert.equal(drains, 1);
});

test('cancellation while waiting for the first index GOP closes the reader without opening a decoder', async () => {
  const { analyzeStream } = await import('../../src/bitstream-analysis/runner.ts');
  const module = await core(), controller = new AbortController(), input = await reader(fixtures[0].file);
  let closed = 0, opens = 0;
  const close = input.close, open = module._vpa_open;
  input.close = () => { closed++; close(); };
  module._vpa_open = (...args: any[]) => { opens++; return open(...args); };
  await assert.rejects(analyzeStream(input, { mode: 'stream', sourceVersion: 'waiting-source', firstPtsUs: 0, durationUs: 10000000 },
    module, 'test', controller.signal, async () => { assert.fail('unindexed packet must not be checked'); },
    async progress => { if (progress.waitingForIndex) controller.abort(); }, async () => ({ packets: 0, complete: false })), { name: 'AbortError' });
  assert.equal(closed, 1); assert.equal(opens, 0);
});

test('native metadata adapter drives the analysis frontier without waiting for its full enumeration', async () => {
  const { Input, BlobSource, MP4 } = await import('mediabunny');
  const { NativeAnalysisAdapter } = await import('../../src/analysis/native-adapter.ts');
  const { analyzeStream } = await import('../../src/bitstream-analysis/runner.ts');
  const input = new Input({ source: new BlobSource(new Blob([await readFile(resolve('fixtures/video', fixtures[0].file))])), formats: [MP4] });
  const track = (await input.getPrimaryVideoTrack())!;
  const adapter = new NativeAnalysisAdapter(track, 'native-stream', 0, 10000000);
  let release!: () => void, stored = 0, batches = 0, pictures = 0, continued = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  // Hold the metadata store ACK after its first bounded batch. The adapter must
  // expose only committed records and continue its own indexing after release.
  (adapter as any).client.call = async (type: string, { records }: { records: Float64Array }) => {
    assert.equal(type, 'append'); if (++batches === 2) await gate;
    stored += records.length / 3; return stored;
  };
  try {
    await analyzeStream(await reader(fixtures[0].file), { mode: 'stream', sourceVersion: 'native-stream', firstPtsUs: 0, durationUs: 10000000 },
      await core(), 'test', new AbortController().signal, async () => { pictures++; }, async progress => {
        if (progress.waitingForIndex && pictures && !continued) {
          assert.deepEqual(await adapter.bitstreamFrontier(), { packets: 128, complete: false });
          assert.ok(pictures < 128); continued = true; release();
        }
      }, () => adapter.bitstreamFrontier());
    assert.equal(continued, true); assert.equal(pictures, stored); assert.ok(pictures >= 600);
    assert.equal((await adapter.bitstreamFrontier()).complete, true);
  } finally { release(); adapter.close(); input.dispose(); }
});

for (const fixture of fixtures) test(`sparse ${fixture.codec} ranges reuse exact pictures and decode only missing output`, async () => {
  const { analyzeRange } = await import('../../src/bitstream-analysis/runner.ts');
  const { pictureId } = await import('../../src/bitstream-analysis/contract.ts');
  const signal = new AbortController().signal;
  const index = await openAnalysisInput(await reader(fixture.file), signal);
  const firstPtsUs = Math.min(...index.packets.map(p => p.pts));
  index.close();
  const target = { sourceVersion: fixture.sha256, firstPtsUs, startUs: 0, endUs: 100000 };
  const expected = new Map<string, any>();
  await analyzeRange(await reader(fixture.file), target, await core(), 'test', signal,
    async result => { expected.set(pictureId(result.picture), result); });
  assert.ok(expected.size >= 2);
  const cached = new Map(expected);
  const middle = [...expected.values()][Math.floor(expected.size / 2)];
  cached.delete(pictureId(middle.picture));
  const seen = new Set<string>();
  const module = await core();
  let factoryCalls = 0;
  await analyzeRange(await reader(fixture.file), target, async () => { factoryCalls++; return module; }, 'test', signal,
    async result => {
      const id = pictureId(result.picture);
      assert.ok(!seen.has(id), 'no duplicate cached/decoded publication'); seen.add(id);
      assert.deepEqual(result.blocks, expected.get(id).blocks);
      assert.deepEqual(result.capabilities, expected.get(id).capabilities);
      if (cached.has(id)) assert.equal(result, cached.get(id), 'publish the existing result');
      else assert.notEqual(result, middle, 'missing picture is decoded again');
    }, async key => cached.get(pictureId(key)) ?? null);
  assert.equal(factoryCalls, 1);
  assert.equal(seen.size, expected.size);
  assert.equal(module._vpa_record_bytes(), 0);
  seen.clear();
  await analyzeRange(await reader(fixture.file), { ...target, endUs: 50000 },
    () => { throw new Error('A fully cached subrange must not allocate WASM'); }, 'test', signal,
    async result => { seen.add(pictureId(result.picture)); }, async key => expected.get(pictureId(key)) ?? null);
  assert.equal(seen.size, [...expected.values()].filter(r => r.sourcePtsUs < firstPtsUs + 50000).length);
});

test('sparse range rejects obsolete, partial, wrong-picture and incomplete-capability cache entries', async () => {
  const { analyzeRange } = await import('../../src/bitstream-analysis/runner.ts');
  const signal = new AbortController().signal;
  const target = { sourceVersion: 'cache-validation', firstPtsUs: 0, startUs: 0, endUs: 10000 };
  let expected: any;
  await analyzeRange(await reader(fixtures[0].file), target, await core(), 'test', signal, async r => { expected = r; });
  for (const patch of [
    { buildId: 'old-build' }, { recipe: 'old-recipe' }, { analyzerVersion: 'old-version' },
    { picture: { ...expected.picture, sourceVersion: 'different-file' } },
    { sourcePtsUs: expected.sourcePtsUs + 1 }, { confidence: 'partial' },
    { capabilities: { ...expected.capabilities, blocks: 'unsupported' } },
    { blocks: null },
  ]) {
    let opened = false;
    await analyzeRange(await reader(fixtures[0].file), target,
      async () => { opened = true; return core(); }, 'test', signal,
      async result => { assert.deepEqual(result.blocks, expected.blocks); }, async () => ({ ...expected, ...patch }));
    assert.equal(opened, true, JSON.stringify(patch));
  }
  const controller = new AbortController();
  await assert.rejects(analyzeRange(await reader(fixtures[0].file), target,
    () => { throw new Error('must not allocate after cancellation'); }, 'test', controller.signal,
    async () => { throw new Error('must not publish after cancellation'); }, async () => {
      controller.abort(); return expected;
    }), { name: 'AbortError' });
});

test('VVC geometry, QP, intra/inter/skip and L0/L1 agree with independent VTM block statistics', async () => {
  const expected = JSON.parse(await readFile(new URL('../../docs/fixtures/bitstream-analysis-vtm.json', import.meta.url), 'utf8'));
  assert.equal(createHash('sha256').update(await readFile(resolve('fixtures/video', expected.file))).digest('hex'), expected.sha256);
  const signal = new AbortController().signal;
  const input = await openAnalysisInput(await reader(expected.file), signal);
  const packets = input.packets;
  const firstPtsUs = Math.min(...packets.map(p => p.pts));
  input.close();
  for (const answer of expected.pictures) {
    const packet = packets[answer.au];
    const result = await analyzePicture(await reader(expected.file), {
      sourceVersion: expected.sha256, sourcePtsUs: packet.pts, normalizedMediaUs: packet.pts - firstPtsUs,
    }, await core(), 'test', signal);
    assert.equal(result.confidence, 'exact');
    assert.equal(result.picture.au, answer.au);
    assert.equal(result.width, answer.width); assert.equal(result.height, answer.height);
    assert.equal(result.blocks.length, answer.blockCount);
    const blocks = result.blocks.map(b => [b.x, b.y, b.width, b.height, b.qp, b.mode] as const)
      .sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3]);
    assert.equal(createHash('sha256').update(JSON.stringify(blocks)).digest('hex'), answer.blocksSha256, `all CUs for POC ${answer.poc}`);
    for (const selected of answer.selected) assert.ok(blocks.some(b => JSON.stringify(b) === JSON.stringify(selected)), 'concrete independent CU record');
    assert.deepEqual({ ...result.references, edges: [...result.references!.edges].sort((a, b) => a.list - b.list || a.au - b.au) },
      { kind: 'active-lists', state: 'ready', poc: answer.poc, frameType: answer.frameType, edges: answer.references });
  }
});

for(const fixture of fixtures)test(`whole ${fixture.codec} cache resumes holes with bounded reference preroll and no duplicate pictures`,async()=>{
  const {groupAnalysisGops}=await import('../../src/bitstream-analysis/stream.ts');
  const {gzipSync,gunzipSync}=await import('node:zlib');
  const signal=new AbortController().signal;
  const makeInput=async()=>{
    const input=await openAnalysisInput(await reader(fixture.file),signal,true);
    const groups=groupAnalysisGops(input.packets);
    input.packets.splice(groups[2].endAu);input.totalPackets=input.packets.length;
    Object.defineProperty(input,'sealedEnd',{get:()=>input.packets.length});
    return input;
  };
  const cache=new Map<number,Buffer>(),hashes=new Map<number,string>();
  const hash=(value:any)=>createHash('sha256').update(JSON.stringify([value.picture,value.sourcePtsUs,value.blocks,value.references,value.nalus])).digest('hex');
  const run=async(module:any,cached:any,consume:(r:any)=>Promise<void>)=>{
    const input=await makeInput();
    return analyzePicture(input.reader,{sourceVersion:fixture.sha256,sourcePtsUs:input.packets[0].pts,normalizedMediaUs:0},
      module,'test',signal,{input,sequential:true,stream:{mode:'stream',sourceVersion:fixture.sha256,firstPtsUs:0,durationUs:10000000},cached,onResult:consume});
  };
  await run(await core(),undefined,async result=>{
    hashes.set(result.picture.au,hash(result));cache.set(result.picture.au,gzipSync(JSON.stringify(result)));
  });
  const get=(au:number)=>JSON.parse(gunzipSync(cache.get(au)!).toString());
  let seen=new Set<number>();
  await run(()=>assert.fail('complete cached stream must not allocate WASM'),async(p:any)=>get(p.au),async result=>{
    assert.ok(!seen.has(result.picture.au));seen.add(result.picture.au);assert.equal(hash(result),hashes.get(result.picture.au));
  });
  assert.equal(seen.size,cache.size);
  const cancelledInput=await makeInput(),controller=new AbortController();
  let closed=false,published=0;
  const close=cancelledInput.close.bind(cancelledInput);
  cancelledInput.close=()=>{closed=true;close();};
  await assert.rejects(analyzePicture(cancelledInput.reader,
    {sourceVersion:fixture.sha256,sourcePtsUs:cancelledInput.packets[0].pts,normalizedMediaUs:0},
    ()=>assert.fail('cancelled cached stream must not allocate WASM'),'test',controller.signal,
    {input:cancelledInput,sequential:true,stream:{mode:'stream',sourceVersion:fixture.sha256,firstPtsUs:0,durationUs:10000000},
      cached:async p=>get(p.au),onResult:async()=>{if(++published===3)controller.abort();}}),{name:'AbortError'});
  assert.equal(published,3);assert.equal(closed,true,'cached cancellation releases the reader');
  const input=await makeInput(),groups=groupAnalysisGops(input.packets);input.close();
  const hole=groups[1].startAu+3,module=await core(),originalFeed=module._vpa_feed;
  const fed:number[]=[];
  module._vpa_feed=(...args:any[])=>{fed.push(args[4]);return originalFeed(...args);};
  seen=new Set();
  await run(module,async(p:any)=>p.au===hole?null:get(p.au),async result=>{
    assert.ok(!seen.has(result.picture.au));seen.add(result.picture.au);assert.equal(hash(result),hashes.get(result.picture.au));
    const before=fed.length;await new Promise(resolve=>setTimeout(resolve,1));assert.equal(fed.length,before,'cache and decode both honor consumer backpressure');
    if(result.picture.au!==hole)assert.deepEqual(result.metrics,get(result.picture.au).metrics,'cached records are reused');
  });
  assert.equal(seen.size,cache.size);assert.ok(fed.includes(hole));
  if(get(groups[1].startAu).gop.anchor==='closed')assert.ok(fed.every(au=>au>=groups[1].startAu),'closed cached prefix is never decoded');
  else assert.ok(fed.some(au=>au<groups[1].startAu),'dependent hole retains reference preroll');
  assert.equal(module._vpa_record_bytes(),0);
});
