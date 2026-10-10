import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createMediaServer } from "../../server/app.ts";
import { MediaLibraryIndex } from "../../server/library.ts";
import { AnalysisScheduler } from "../../server/analysis/scheduler.ts";
async function fixture(
  root = resolve("fixtures/video"),
  name = "h264_9s_1920x1080.mp4",
) {
  const folder = await mkdtemp(join(tmpdir(), "vp-deep-server-")),
    library = new MediaLibraryIndex([root], {
      database: join(folder, "library.sqlite"),
      settleMs: 0,
      watch: false,
    });
  await library.refresh();
  const entry = (await library.list()).entries.find((e) => e.name === name)!;
  return {
    folder,
    library,
    entry,
    async close() {
      await library.close();
      await rm(folder, { recursive: true, force: true });
    },
  };
}
const coreDir = resolve("public/vendor/voidplayer-analysis");
const target = (entry: any) => ({
  sourceVersion: `${entry.id}@${entry.version}`,
  sourcePtsUs: 0,
  normalizedMediaUs: 0,
  picture: {
    sourceVersion: `${entry.id}@${entry.version}`,
    stream: "video",
    configuration: 0,
    au: 0,
    picture: 0 as const,
    layer: 0 as const,
    field: "frame" as const,
  },
});
async function wait(scheduler: AnalysisScheduler, id: string, owner: string) {
  for (let i = 0; i < 200; i++) {
    const s = scheduler.status(id, owner)!;
    if (
      s &&
      ["complete", "error", "unsupported", "limited", "cancelled"].includes(
        s.state,
      )
    )
      return s;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("Analysis did not complete");
}
test("two consumers share real work; cancelling one retains the other; restart hits atomic cache", async () => {
  const f = await fixture();
  let scheduler = new AnalysisScheduler(
    f.library,
    coreDir,
    join(f.folder, "analysis"),
  );
  try {
    const [a, b] = await Promise.all([
      scheduler.submit(f.entry.id, f.entry.version!, target(f.entry), "one"),
      scheduler.submit(f.entry.id, f.entry.version!, target(f.entry), "two"),
    ]);
    assert.notEqual(a.requestId, b.requestId);
    assert.equal(scheduler.status(a.requestId, "two"), null);
    scheduler.release(a.requestId, "one");
    const state = await wait(scheduler, b.requestId, "two");
    assert.equal(state.state, "complete", state.error ?? "");
    const chunk = new URL(state.resultUrl!, "http://localhost").pathname
      .split("/")
      .at(-1)!;
    const result = await scheduler.store.get(chunk);
    assert.equal(result?.confidence, "exact");
    assert.equal(result?.blocks.length, 8160);
    await scheduler.close();
    scheduler = new AnalysisScheduler(
      f.library,
      coreDir,
      join(f.folder, "analysis"),
    );
    const c = await scheduler.submit(
      f.entry.id,
      f.entry.version!,
      target(f.entry),
      "two",
    );
    assert.equal(c.cacheHit, true);
    assert.equal(c.state, "complete");
  } finally {
    await scheduler.close();
    await f.close();
  }
});
test("expired consumers reclaim shared work without a DELETE and bounded ranges persist progressively", async () => {
  const f = await fixture();
  let now = 1000;
  const scheduler = new AnalysisScheduler(
    f.library,
    coreDir,
    join(f.folder, "analysis"),
    () => now,
    100,
  );
  try {
    const a = await scheduler.submit(
      f.entry.id,
      f.entry.version!,
      target(f.entry),
      "owner",
    );
    now += 101;
    scheduler.expire();
    assert.equal(scheduler.status(a.requestId, "owner"), null);
    const range = {
      sourceVersion: `${f.entry.id}@${f.entry.version}`,
      firstPtsUs: 0,
      startUs: 0,
      endUs: 100000,
    };
    const r = await scheduler.submit(
        f.entry.id,
        f.entry.version!,
        range,
        "owner",
      ),
      state = await wait(scheduler, r.requestId, "owner");
    assert.equal(state.state, "complete", state.error ?? "");
    assert.ok(state.chunks.length >= 5);
    const hit = await scheduler.submit(
      f.entry.id,
      f.entry.version!,
      range,
      "owner",
    );
    assert.equal(hit.cacheHit, true);
  } finally {
    await scheduler.close();
    await f.close();
  }
});
test("HTTP writes require same origin and version; server failures never download client media", async () => {
  const f = await fixture(),
    server = createMediaServer({
      roots: [],
      library: f.library,
      staticDir: resolve("dist"),
      onLog() {},
    });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`,
    url = `${base}/api/media/${f.entry.id}/bitstream-analysis/requests?v=${f.entry.version}`;
  try {
    const body = JSON.stringify({
      version: f.entry.version,
      target: target(f.entry),
    });
    assert.equal(
      (
        await fetch(url, {
          method: "POST",
          headers: {
            origin: "http://other.invalid",
            "content-type": "application/json",
            "x-voidplayer-action": "bitstream-analysis",
          },
          body,
        })
      ).status,
      403,
    );
    const response = await fetch(url, {
      method: "POST",
      headers: {
        origin: base,
        "content-type": "application/json",
        "x-voidplayer-action": "bitstream-analysis",
      },
      body,
    });
    assert.equal(response.status, 202);
    const request = await response.json();
    for (let i = 0; i < 100; i++) {
      const state = await (
        await fetch(
          `${base}/api/bitstream-analysis/requests/${request.requestId}`,
        )
      ).json();
      if (state.state === "complete") {
        assert.equal(
          (await (await fetch(base + state.resultUrl)).json()).confidence,
          "exact",
        );
        return;
      }
      assert.notEqual(state.state, "error", state.error);
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.fail("HTTP analysis did not finish");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await f.close();
  }
});

test("result transport reservations are bounded and shutdown refuses queued demand", async () => {
  const f = await fixture(),
    scheduler = new AnalysisScheduler(
      f.library,
      coreDir,
      join(f.folder, "analysis"),
    );
  try {
    const a = scheduler.reserveResultRead()!,
      b = scheduler.reserveResultRead()!;
    assert.equal(scheduler.reserveResultRead(), null);
    a();
    a();
    const c = scheduler.reserveResultRead();
    assert.ok(c);
    b();
    c();
    await scheduler.close();
    await assert.rejects(
      scheduler.submit(f.entry.id, f.entry.version!, target(f.entry), "owner"),
      /queue full|closed/,
    );
  } finally {
    await scheduler.close();
    await f.close();
  }
});

test("legal interlaced and high-depth inputs report the same capability reasons locally and remotely", async () => {
  const { execFileSync } = await import("node:child_process");
  const { open } = await import("node:fs/promises");
  const { pathToFileURL } = await import("node:url");
  const { analyzePicture } = await import(
    "../../src/bitstream-analysis/runner.ts"
  );
  const media = await mkdtemp(join(tmpdir(), "vp-analysis-limit-input-"));
  try {
    for (const depth of [8, 10]) {
      const name = `depth-${depth}.mp4`,
        path = join(media, name);
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
        ...(depth === 8
          ? [
              "-c:v",
              "libx264",
              "-flags",
              "+ilme+ildct",
              "-x264-params",
              "tff=1:bframes=0",
            ]
          : [
              "-c:v",
              "libx265",
              "-x265-params",
              "pools=1:frame-threads=1:log-level=error:bframes=0",
            ]),
        "-pix_fmt",
        depth === 8 ? "yuv420p" : "yuv420p10le",
        path,
      ]);
      const f = await fixture(media, name),
        scheduler = new AnalysisScheduler(
          f.library,
          coreDir,
          join(f.folder, "analysis"),
        );
      try {
        const source = await open(path),
          { size } = await source.stat();
        const module = await (
          await import(
            pathToFileURL(join(coreDir, "voidplayer-analysis.js")).href
          )
        ).default();
        const local = await analyzePicture(
          {
            size,
            async read(offset: number, length: number) {
              const bytes = new Uint8Array(length);
              const r = await source.read(bytes, 0, length, offset);
              assert.equal(r.bytesRead, length);
              return bytes;
            },
            close() {
              void source.close();
            },
          },
          target(f.entry),
          module,
          "test",
          new AbortController().signal,
        );
        assert.equal(module._vpa_record_bytes(), 0);
        const req = await scheduler.submit(
            f.entry.id,
            f.entry.version!,
            target(f.entry),
            "owner",
          ),
          state = await wait(scheduler, req.requestId, "owner");
        if (depth === 8) {
          assert.equal(local.confidence, "partial");
          assert.equal(state.state, "unsupported", JSON.stringify(state));
          assert.equal(state.reason?.kind, "unsupported");
          assert.deepEqual(state.result?.reasonCodes, local.reasonCodes);
          assert.equal(state.result?.blocks.length, 0);
          assert.equal(state.chunks.length, 0);
          assert.equal(
            state.resultUrl,
            undefined,
            "unsupported summaries have no exact chunk URL",
          );
          scheduler.release(req.requestId, "owner");
          const again = await scheduler.submit(
            f.entry.id,
            f.entry.version!,
            target(f.entry),
            "owner",
          );
          assert.equal(
            again.cacheHit,
            false,
            "unsupported is never committed as exact coverage",
          );
          assert.equal(
            (await wait(scheduler, again.requestId, "owner")).state,
            "unsupported",
          );
        } else {
          assert.equal(local.confidence, "exact");
          assert.equal(state.state, "complete", JSON.stringify(state));
          const id = new URL(state.resultUrl!, "http://localhost").pathname
            .split("/")
            .at(-1)!;
          const remote = await scheduler.store.get(id);
          for (const r of [local, remote!]) {
            assert.deepEqual(r.reasonCodes, ["unsupported-qp-depth"]);
            assert.equal(r.qp.bitDepth, 10);
            assert.equal(r.qp.mean, null);
            assert.equal(r.capabilities.qp, "unsupported");
            assert.ok(
              r.blocks.length > 0 && r.blocks.every((b) => b.qp === null),
            );
            assert.equal(r.capabilities.blocks, "ready");
            assert.equal(r.capabilities.modes, "ready");
          }
          assert.deepEqual(remote!.blocks, local.blocks);
        }
      } finally {
        await scheduler.close();
        await f.close();
      }
    }
  } finally {
    await rm(media, { recursive: true, force: true });
  }
});
