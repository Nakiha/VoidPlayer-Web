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
