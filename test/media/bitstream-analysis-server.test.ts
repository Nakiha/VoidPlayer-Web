import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, symlink, access, copyFile, open } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createMediaServer } from "../../server/app.ts";
import { MediaLibraryIndex } from "../../server/library.ts";
import { AnalysisScheduler } from "../../server/analysis/bitstream/scheduler.ts";
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
      // This backend fixture uses the downloaded public core. It does not
      // serve a built frontend or require dist to exist.
      onLog() {},
    });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`,
    url = `${base}/api/media/${f.entry.id}/bitstream-analysis/requests?v=${f.entry.version}`;
  try {
    const body = JSON.stringify({
      version: f.entry.version!,
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
    assert.equal(response.status, 202, await response.clone().text());
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

test("backend HTTP analysis works from public with no dist directory", async () => {
  const folder = await mkdtemp(join(tmpdir(), "vp-http-without-dist-"));
  try {
    for (const name of ["public", "fixtures"]) {
      await symlink(resolve(name), join(folder, name), process.platform === "win32" ? "junction" : "dir");
    }
    await assert.rejects(access(join(folder, "dist")), { code: "ENOENT" });
    try {
      const result = await promisify(execFile)(process.execPath, [
        "--experimental-strip-types", "--test", "--test-reporter=tap",
        "--test-name-pattern=^HTTP writes require same origin and version",
        fileURLToPath(import.meta.url),
      ], {
        cwd: folder,
        env: { ...process.env, VOIDPLAYER_ANALYSIS_CORE_DIR: "", NODE_TEST_CONTEXT: undefined },
        timeout: 60000,
        maxBuffer: 1024 * 1024,
      });
      assert.match(result.stdout, /^ok \d+ - HTTP writes require same origin and version/m);
      assert.match(result.stdout, /^# pass 1$/m, "the isolated process must actually execute the HTTP assertion");
    } catch (error: any) {
      assert.fail(`Backend-only HTTP regression failed: ${error.stdout ?? ""}\n${error.stderr ?? error.message}`);
    }
    await assert.rejects(access(join(folder, "dist")), { code: "ENOENT" });
  } finally {
    await rm(folder, { recursive: true, force: true });
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
    const cancelledReader = new AbortController();
    const rejected = assert.rejects(scheduler.waitForResultRead(cancelledReader.signal), /disconnected/);
    cancelledReader.abort(new Error('disconnected')); await rejected;
    const abort = new AbortController();
    const waiting = scheduler.waitForResultRead(abort.signal);
    let admitted = false; void waiting.then(() => { admitted = true; });
    await new Promise(r => setTimeout(r, 10)); assert.equal(admitted, false);
    a();
    a();
    const c = await waiting;
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
    "../../shared/analysis/bitstream/runner.ts"
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
          assert.equal((state.result && "blocks" in state.result ? state.result.blocks.length : 0), 0);
          const productRequest=await scheduler.submit(f.entry.id,f.entry.version!,{...target(f.entry),product:'blocks'},'owner');
          const productState=JSON.parse(JSON.stringify(await wait(scheduler,productRequest.requestId,'owner')));
          assert.equal(productState.result.product,'blocks');assert.equal(productState.result.validatedBlockCount,0);assert.equal(productState.result.payload,null);assert.equal(productState.result.emptyPayload,true);scheduler.release(productRequest.requestId,'owner');
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

test('server viewport requests keep different windows separate and publish only their intersecting GOP', async () => {
  const { execFileSync } = await import('node:child_process');
  const media = await mkdtemp(join(tmpdir(), 'vp-viewport-stream-')), name = 'viewport.mp4';
  execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
    'testsrc2=size=128x64:rate=30:duration=4', '-an', '-c:v', 'libx264', '-g', '30', '-bf', '2',
    '-x264-params', 'scenecut=0:open-gop=0', join(media, name)]);
  const f = await fixture(media, name), scheduler = new AnalysisScheduler(f.library, coreDir, join(f.folder, 'analysis'));
  const target = { mode: 'stream' as const, sourceVersion: `${f.entry.id}@${f.entry.version}`, firstPtsUs: 0, durationUs: 4000000 };
  try {
    const requests = await Promise.all([100000, 2100000].map(startUs => scheduler.submit(f.entry.id, f.entry.version!,
      { ...target, window: { startUs, endUs: startUs + 100000, axis: 'pts' } }, String(startUs))));
    for (let i = 0; i < requests.length; i++) {
      const owner = String(i ? 2100000 : 100000), aus = new Set<number>();
      let cursor = 0;
      for (let n = 0; ; n++) {
        assert.ok(n < 500, 'viewport request completes');
        const state = await scheduler.streamStatus(requests[i].requestId, owner, cursor);
        assert.ok(state && ['running', 'queued', 'complete'].includes(state.state), JSON.stringify(state));
        for (const ref of state.chunks) {
          const result = await scheduler.store.get(ref.id);
          assert.ok(result && result.gop);
          aus.add(result.picture.au); cursor = ref.cursor;
          assert.equal(result.gop.startAu, i ? 60 : 0);
        }
        if (state.state === 'complete' && cursor === state.published) {
          assert.equal(state.progress!.totalPictures, 30); break;
        }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.deepEqual([...aus].sort((a, b) => a - b), Array.from({ length: 30 }, (_, n) => n + (i ? 60 : 0)));
      scheduler.release(requests[i].requestId, owner);
    }
  } finally { await scheduler.close(); await f.close(); await rm(media, { recursive: true, force: true }); }
});

test('continuous server stream pages GOP chunks, backpressures each consumer and keeps committed cache on cancellation', async () => {
  const { execFileSync } = await import('node:child_process');
  const media = await mkdtemp(join(tmpdir(), 'vp-gop-stream-'));
  const name = 'stream.mp4';
  execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
    'testsrc2=size=128x64:rate=30:duration=4', '-an', '-c:v', 'libx264', '-g', '30', '-bf', '2',
    '-x264-params', 'scenecut=0:open-gop=0', join(media, name)]);
  const f = await fixture(media, name), scheduler = new AnalysisScheduler(f.library, coreDir, join(f.folder, 'analysis'));
  const streamTarget = { mode: 'stream' as const, sourceVersion: `${f.entry.id}@${f.entry.version}`, firstPtsUs: 0, durationUs: 4000000 };
  try {
    const a = await scheduler.submit(f.entry.id, f.entry.version!, streamTarget, 'one');
    const b = await scheduler.submit(f.entry.id, f.entry.version!, streamTarget, 'two');
    for (let n = 0; scheduler.status(a.requestId, 'one')!.published !== 32; n++) {
      assert.ok(n < 500, 'stream reaches bounded pending window');
      await new Promise(r => setTimeout(r, 10));
    }
    const first = await scheduler.streamStatus(a.requestId, 'one', 0);
    assert.equal(first!.chunks.length, 32);
    const firstId = first!.chunks[0].id;
    assert.ok((await scheduler.store.get(firstId))?.gop);
    await assert.rejects(scheduler.streamStatus(a.requestId, 'one', 33), /acknowledgement/);
    await scheduler.streamStatus(a.requestId, 'one', 32);
    await new Promise(r => setTimeout(r, 60));
    assert.equal(scheduler.status(b.requestId, 'two')!.published, 32, 'slow second consumer prevents unbounded production');
    scheduler.release(a.requestId, 'one');
    const aus = new Set<number>(), groups = new Set<number>();
    let cursor = 0;
    for (let n = 0; ; n++) {
      assert.ok(n < 1000);
      const state = await scheduler.streamStatus(b.requestId, 'two', cursor);
      assert.ok(state); assert.ok(state.chunks.length <= 32);
      for (const ref of state.chunks) {
        assert.equal(ref.cursor, cursor + 1);
        const result = await scheduler.store.get(ref.id);
        assert.ok(result && result.gop); assert.equal(result.confidence, 'exact');
        assert.equal(aus.has(result.picture.au), false); aus.add(result.picture.au); groups.add(result.gop.startAu);
        cursor = ref.cursor;
      }
      if (state.state === 'complete' && cursor === state.published) break;
      assert.ok(['running', 'queued', 'complete'].includes(state.state), JSON.stringify(state));
      await new Promise(r => setTimeout(r, 10));
    }
    assert.equal(aus.size, 120); assert.equal(groups.size, 4);
    scheduler.release(b.requestId, 'two');
    const hit = await scheduler.submit(f.entry.id, f.entry.version!, target(f.entry), 'hit');
    assert.equal(hit.cacheHit, true, 'stream chunks reuse the same picture cache identity');
    scheduler.release(hit.requestId, 'hit');
    const cancelled = await scheduler.submit(f.entry.id, f.entry.version!, streamTarget, 'cancel');
    for (let n = 0; scheduler.status(cancelled.requestId, 'cancel')!.published !== 32; n++) {
      assert.ok(n < 500); await new Promise(r => setTimeout(r, 10));
    }
    const partial = await scheduler.streamStatus(cancelled.requestId, 'cancel', 0);
    scheduler.release(cancelled.requestId, 'cancel');
    assert.ok(await scheduler.store.get(partial!.chunks[0].id), 'cancel retains committed picture');
  } finally { await scheduler.close(); await f.close(); await rm(media, { recursive: true, force: true }); }
});

test('shared library index discovers GOPs before all batches arrive; cancel detaches only the analysis subscriber', async () => {
  const { execFileSync } = await import('node:child_process');
  const media = await mkdtemp(join(tmpdir(), 'vp-incremental-analysis-')), name = 'incremental.flv';
  execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
    'testsrc2=size=128x64:rate=30:duration=10', '-an', '-c:v', 'libx264', '-g', '30', '-bf', '0',
    '-x264-params', 'scenecut=0:open-gop=0', join(media, name)]);
  const f = await fixture(media, name), scheduler = new AnalysisScheduler(f.library, coreDir, join(f.folder, 'analysis'));
  const {FLV_MEDIA_INDEX_IDENTITY:identity}=await import('../../shared/media/indexing/media-index-identity.ts');
  const streamTarget = { mode: 'stream' as const, sourceVersion: `${f.entry.id}@${f.entry.version}`, firstPtsUs: 0, durationUs: 10000000, indexIdentity: identity };
  const call = f.library.indexJobs.call.bind(f.library.indexJobs),startBuild=f.library.indexJobs.startBuild.bind(f.library.indexJobs);
  let release = false;
  f.library.indexJobs.startBuild=(request,options={})=>{const handle=startBuild(request,{...options,onProgress(progress){options.onProgress?.({...progress,packets:release?progress.packets:Math.min(progress.packets,128)});}});void handle.promise.then(()=>{if(!release)options.onProgress?.({phase:'scan',packets:128,scannedBytes:f.entry.size,totalBytes:f.entry.size});});return handle;};
  f.library.indexJobs.call=async(op,...args)=>{
    const result=await call(op,...args);
    if(op==='stream-manifest'&&!release&&result&&typeof result==='object'&&'manifest' in result&&result.manifest&&typeof result.manifest==='object')return {...result,manifest:{...result.manifest,complete:false}};
    return result;
  };
  try {
    const request = await scheduler.submit(f.entry.id, f.entry.version!, streamTarget, 'owner');
    let cursor = 0, sawWaiting = false;
    for (let n = 0; ; n++) {
      assert.ok(n < 1500, 'first indexed GOP produces before EOF');
      const state = await scheduler.streamStatus(request.requestId, 'owner', cursor);
      assert.ok(state && ['queued', 'running'].includes(state.state), JSON.stringify(state));
      for (const ref of state.chunks) {
        assert.equal(ref.cursor, cursor + 1); cursor = ref.cursor;
        const result = await scheduler.store.get(ref.id); assert.ok(result?.gop && result.picture.au < 128);
      }
      if (state.progress?.waitingForIndex && cursor > 0) { sawWaiting = true; assert.equal(state.progress.indexComplete, false); break; }
      await new Promise(r => setTimeout(r, 10));
    }
    assert.equal(sawWaiting, true); assert.ok(cursor > 0 && cursor < 300);
    release = true;
    for (let n = 0; ; n++) {
      assert.ok(n < 1500);
      const state = await scheduler.streamStatus(request.requestId, 'owner', cursor);
      assert.ok(state && ['queued', 'running', 'complete'].includes(state.state), JSON.stringify(state));
      cursor += state.chunks.length;
      if (state.state === 'complete' && cursor === state.published) { assert.equal(state.progress?.indexComplete, true); break; }
      await new Promise(r => setTimeout(r, 10));
    }
    assert.equal(cursor, 300); scheduler.release(request.requestId, 'owner');
    const manifest = await call('stream-manifest', { id: f.entry.id, version: f.entry.version!, identity });
    assert.ok(manifest.manifest);
    assert.equal(manifest.manifest.complete, true, 'shared index survives analysis release');
    release = false;
    const cancelled = await scheduler.submit(f.entry.id, f.entry.version!, streamTarget, 'cancel');
    for (let n = 0; ; n++) {
      assert.ok(n < 1500);
      const state = await scheduler.streamStatus(cancelled.requestId, 'cancel', 0);
      assert.ok(state && ['queued', 'running'].includes(state.state), JSON.stringify(state));
      if (state.chunks.length) { scheduler.release(cancelled.requestId, 'cancel'); break; }
      await new Promise(r => setTimeout(r, 10));
    }
    const afterCancel = await call('stream-manifest', { id: f.entry.id, version: f.entry.version!, identity });
    assert.ok(afterCancel.manifest);
    assert.equal(afterCancel.manifest.complete, true);
  } finally { await scheduler.close(); await f.close(); await rm(media, { recursive: true, force: true }); }
});

test('server bounds six multi-user demands, prioritizes queued pictures and reclaims cancelled work', async () => {
  const { execFileSync } = await import('node:child_process');
  const { copyFile } = await import('node:fs/promises');
  const media = await mkdtemp(join(tmpdir(), 'vp-six-streams-'));
  execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
    'testsrc2=size=64x32:rate=30:duration=2', '-an', '-c:v', 'libx264', '-g', '30', '-bf', '2',
    '-x264-params', 'scenecut=0:open-gop=0', join(media, 'stream-0.mp4')]);
  for (let n = 1; n < 6; n++) await copyFile(join(media, 'stream-0.mp4'), join(media, `stream-${n}.mp4`));
  const f = await fixture(media, 'stream-0.mp4'), scheduler = new AnalysisScheduler(f.library, coreDir, join(f.folder, 'analysis'));
  assert.equal(scheduler.resources().concurrency, 8);
  scheduler.setConcurrency(2);
  try {
    const entries = (await f.library.list()).entries.filter(e => e.name.startsWith('stream-'));
    assert.equal(entries.length, 6);
    const jobs = await Promise.all(entries.map((entry, n) => scheduler.submit(entry.id, entry.version!, {
      mode: 'stream', sourceVersion: `${entry.id}@${entry.version}`, firstPtsUs: 0, durationUs: 2000000,
    }, `user-${Math.floor(n / 2)}`)));
    const owner = (n: number) => `user-${Math.floor(n / 2)}`;
    // Hold the two active workers at backpressure. Queued requests must not
    // allocate a worker or publish anything, even when their windows allow more.
    for (let n = 0; ; n++) {
      const states = jobs.map((job, i) => scheduler.status(job.requestId, owner(i))!);
      assert.ok(states.filter(state => state.state === 'running').length <= 2);
      if (states.slice(0,2).every(state => state.published === 32)) {
        assert.ok(states.slice(2).every(state => state.state === 'queued' && state.published === 0)); break;
      }
      assert.ok(n < 1000, JSON.stringify(states));
      assert.ok(states.every(state => ['running', 'queued'].includes(state.state)), JSON.stringify(states));
      await new Promise(r => setTimeout(r, 10));
    }
    scheduler.setConcurrency(1);
    assert.equal(scheduler.resources().running, 2, 'reducing capacity does not interrupt active jobs');
    scheduler.release(jobs[5].requestId, owner(5));
    assert.equal(scheduler.status(jobs[5].requestId, owner(5)), null, 'queued cancellation needs no worker');
    const picture = await scheduler.submit(entries[5].id, entries[5].version!, target(entries[5]), 'inspector');
    assert.equal(picture.state, 'queued');
    scheduler.setConcurrency(3);
    assert.equal((await wait(scheduler, picture.requestId, 'inspector')).state, 'complete', 'raising capacity admits the queued picture immediately');
    scheduler.setConcurrency(2);
    scheduler.release(jobs[0].requestId, owner(0));
    assert.equal((await wait(scheduler, picture.requestId, 'inspector')).state, 'complete', 'picture passes older queued streams');
    scheduler.release(picture.requestId, 'inspector');
    for (let n = 0; scheduler.resources().running > 2; n++) {
      assert.ok(n < 1000); await new Promise(r => setTimeout(r, 10));
    }
    await Promise.all(jobs.slice(1,5).map(async (job, j) => {
      const i = j + 1; let cursor = 0;
      for (let n = 0; ; n++) {
        const state = await scheduler.streamStatus(job.requestId, owner(i), cursor);
        assert.ok(state);
        for (const ref of state.chunks) {
          const result = await scheduler.store.get(ref.id);
          assert.equal(result?.picture.sourceVersion, `${entries[i].id}@${entries[i].version}`);
          cursor = ref.cursor;
        }
        if (state.state === 'complete' && cursor === state.published) break;
        assert.ok(n < 1000 && ['queued','running','complete'].includes(state.state), JSON.stringify(state));
        assert.ok(jobs.filter((job, k) => scheduler.status(job.requestId, owner(k))?.state === 'running').length <= 2);
        await new Promise(r => setTimeout(r, 10));
      }
      assert.equal(cursor, 60);
      scheduler.release(job.requestId, owner(i));
    }));
  } finally { await scheduler.close(); await f.close(); await rm(media, { recursive: true, force: true }); }
});

test('overlapping ranges reuse atomic picture chunks after restart and repair evicted holes', async () => {
  const f = await fixture();
  const directory = join(f.folder, 'analysis');
  let scheduler = new AnalysisScheduler(f.library, coreDir, directory);
  const range = { sourceVersion: `${f.entry.id}@${f.entry.version}`, firstPtsUs: 0, startUs: 0, endUs: 100000 };
  const execute = async (startUs: number, endUs: number) => {
    const request = await scheduler.submit(f.entry.id, f.entry.version!, { ...range, startUs, endUs }, 'owner');
    const state = await wait(scheduler, request.requestId, 'owner');
    assert.equal(state.state, 'complete', state.error ?? '');
    return Promise.all(state.chunks.map(async chunk => {
      const id = chunk.id;
      return { id, result: (await scheduler.store.get(id))! };
    }));
  };
  try {
    const original = await execute(0, 100000);
    assert.ok(original.length >= 5);
    await scheduler.close();
    scheduler = new AnalysisScheduler(f.library, coreDir, directory);
    const overlap = await execute(10000, 90000);
    for (const hit of overlap) assert.deepEqual(hit.result, original.find(r => r.id === hit.id)!.result,
      'preserved decoder metrics prove the original chunk was reused');
    await scheduler.close();
    const hole = overlap[Math.floor(overlap.length / 2)];
    await rm(scheduler.store.chunkFile(hole.id));
    scheduler = new AnalysisScheduler(f.library, coreDir, directory);
    const repaired = await execute(10000, 90000);
    assert.equal(repaired.length, overlap.length);
    for (const result of repaired) {
      const previous = original.find(r => r.id === result.id)!.result;
      assert.deepEqual(result.result.blocks, previous.blocks);
      if (result.id !== hole.id) assert.deepEqual(result.result, previous);
    }
  } finally { await scheduler.close(); await f.close(); }
});

test('whole stream restart rebuilds lease cursors from persistent pictures without WASM and repairs evicted or corrupt holes', async () => {
  const { execFileSync } = await import('node:child_process');
  const { mkdir, copyFile, writeFile } = await import('node:fs/promises');
  const media = await mkdtemp(join(tmpdir(), 'vp-stream-restart-')), name = 'restart.mp4';
  execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
    'testsrc2=size=128x64:rate=30:duration=4', '-an', '-c:v', 'libx264', '-g', '30', '-bf', '2',
    '-x264-params', 'scenecut=0:open-gop=0', join(media, name)]);
  const f = await fixture(media, name), directory = join(f.folder, 'analysis');
  let scheduler = new AnalysisScheduler(f.library, coreDir, directory);
  const demand = { mode: 'stream' as const, sourceVersion: `${f.entry.id}@${f.entry.version}`, firstPtsUs: 0, durationUs: 4000000 };
  const consume = async (requestId: string) => {
    const records = new Map<number, { id: string; result: any }>();
    let cursor = 0;
    for (let n = 0; ; n++) {
      assert.ok(n < 1500, 'stream finishes within budget');
      const state = await scheduler.streamStatus(requestId, 'owner', cursor);
      assert.ok(state && ['queued', 'running', 'complete'].includes(state.state), JSON.stringify(state));
      for (const ref of state.chunks) {
        assert.equal(ref.cursor, cursor + 1);
        const result = await scheduler.store.get(ref.id);
        assert.ok(result?.gop); assert.equal(records.has(result.picture.au), false);
        records.set(result.picture.au, { id: ref.id, result }); cursor = ref.cursor;
      }
      if (state.state === 'complete' && cursor === state.published) break;
      await new Promise(r => setTimeout(r, 5));
    }
    assert.equal(records.size, 120);
    await scheduler.streamStatus(requestId, 'owner', cursor);
    await assert.rejects(scheduler.streamStatus(requestId, 'owner', 0), /acknowledgement/);
    return records;
  };
  try {
    const first = await scheduler.submit(f.entry.id, f.entry.version!, demand, 'owner');
    const expected = await consume(first.requestId);
    await scheduler.close();
    // A manifest is enough to establish cache identity. No JS or WASM exists
    // here: a hidden eager load or re-decode cannot accidentally pass.
    const manifestOnly = join(f.folder, 'manifest-only'); await mkdir(manifestOnly);
    await copyFile(join(coreDir, 'manifest.json'), join(manifestOnly, 'manifest.json'));
    scheduler = new AnalysisScheduler(f.library, manifestOnly, directory);
    assert.equal(await scheduler.streamStatus(first.requestId, 'owner', 120), null);
    const resumed = await scheduler.submit(f.entry.id, f.entry.version!, demand, 'owner');
    assert.notEqual(resumed.requestId, first.requestId);
    await assert.rejects(scheduler.streamStatus(resumed.requestId, 'owner', 120), /acknowledgement/);
    const cached = await consume(resumed.requestId);
    assert.deepEqual(cached, expected, 'restart preserves every record including original metrics');
    await scheduler.close();
    scheduler = new AnalysisScheduler(f.library, coreDir, directory);
    const holes = new Set([33, 63]);
    await rm(scheduler.store.chunkFile(expected.get(33)!.id));
    await writeFile(scheduler.store.chunkFile(expected.get(63)!.id), '{broken');
    const repaired = await consume((await scheduler.submit(f.entry.id, f.entry.version!, demand, 'owner')).requestId);
    for (const [au, record] of repaired) {
      const original = expected.get(au)!;
      assert.equal(record.id, original.id);
      if (!holes.has(au)) assert.deepEqual(record.result, original.result);
      else {
        const { metrics: _before, ...before } = original.result;
        const { metrics: _after, ...after } = record.result;
        assert.deepEqual(after, before, 'regenerated hole retains exact picture content');
      }
    }
  } finally { await scheduler.close(); await f.close(); await rm(media, { recursive: true, force: true }); }
});

for (const failure of ['messageerror', 'ack-post', 'cancelled-ack'] as const) {
  test(`server analysis ${failure} releases its Worker admission and permits real recovery`, { timeout: 10000 }, async t => {
    const { Worker } = await import('node:worker_threads');
    const f = await fixture(), scheduler = new AnalysisScheduler(f.library, coreDir, join(f.folder, 'transport-failure'));
    scheduler.setConcurrency(1);
    let active: any;
    let releaseCached: (() => void) | undefined;
    let latePosts = 0;
    let resolveWorker!: (worker: import('node:worker_threads').Worker) => void;
    const created = new Promise<import('node:worker_threads').Worker>(resolve => { resolveWorker = resolve; });
    const on = Worker.prototype.on;
    // Observe listener installation, before the event loop can deliver the
    // first actual Worker message. Only this scheduler's owned Worker matches.
    t.mock.method(Worker.prototype, 'on', function(this: import('node:worker_threads').Worker, event: string, listener: (...args: any[]) => void) {
      const result = on.call(this, event, listener);
      if (event === 'message') {
        const work = [...(scheduler as any).running].find(work => work.worker === this);
        if (work) { active = work; resolveWorker(this); }
      }
      return result;
    });
    try {
      const demand = failure === 'cancelled-ack'
        ? { sourceVersion: target(f.entry).sourceVersion, firstPtsUs: 0, startUs: 0, endUs: 100000 }
        : target(f.entry);
      const request = await scheduler.submit(f.entry.id, f.entry.version!, demand, 'failure-owner');
      const worker = await created;
      if (failure === 'messageerror') worker.emit('messageerror', new Error('injected invalid analysis reply'));
      else if (failure === 'ack-post') {
        let attempted!: () => void;
        const sent = new Promise<void>(resolve => { attempted = resolve; });
        // The worker's real first cache/chunk reply reaches the actual ACK
        // path; failure injection is on this instance only, not other tasks.
        t.mock.method(worker, 'postMessage', () => { attempted(); throw new Error('injected analysis ACK send failure'); });
        await sent;
      } else {
        let cacheSeen!: () => void;
        const arrived = new Promise<void>(resolve => { cacheSeen = resolve; });
        const held = new Promise<void>(resolve => { releaseCached = resolve; });
        // This fresh fixture has no cached pictures; delay that null lookup
        // so cancellation wins before the actual reverse ACK callback resumes.
        t.mock.method(scheduler.store, 'get', async () => { cacheSeen(); await held; return null; });
        t.mock.method(worker, 'postMessage', () => { latePosts++; throw new Error('cancelled worker must not receive late ACK'); });
        await arrived;
        scheduler.release(request.requestId, 'failure-owner');
        releaseCached!();
      }
      await new Promise<void>(resolve => setImmediate(resolve));
      if (failure === 'cancelled-ack') {
        assert.equal(scheduler.status(request.requestId, 'failure-owner'), null);
        assert.equal(active.state, 'cancelled');
        assert.equal(active.reason, undefined);
      } else {
        const failed = scheduler.status(request.requestId, 'failure-owner')!;
        assert.equal(failed.state, 'error', 'live transport failure must settle before the 30-second stall deadline');
        assert.equal(failed.reason?.code, 'internal-error');
      }
      await active.done;
      assert.equal(active.worker, undefined);
      await new Promise<void>(resolve => setImmediate(resolve));
      if (failure === 'cancelled-ack') assert.equal(latePosts, 0);
      assert.deepEqual(scheduler.resources(), { concurrency: 1, running: 0, queued: 0 });
      // Restore observations for recovery. A committed real picture survives
      // ACK failure; other cases reopen a real decoder rather than poisoning
      // the deduplication key or scheduler admission.
      t.mock.restoreAll();
      const recovery = await scheduler.submit(f.entry.id, f.entry.version!, demand, 'recovery-owner');
      assert.equal(recovery.cacheHit, failure === 'ack-post');
      const complete = await wait(scheduler, recovery.requestId, 'recovery-owner');
      assert.equal(complete.state, 'complete', complete.error ?? '');
      assert.notEqual(recovery.requestId, request.requestId);
      assert.equal(scheduler.status(request.requestId, 'failure-owner')?.state, failure === 'cancelled-ack' ? undefined : 'error');
    } finally {
      releaseCached?.(); t.mock.restoreAll(); await scheduler.close(); await f.close();
    }
  });
}


test('large library FLV viewport reuses the shared index and decodes only intersecting GOPs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vp-large-flv-'));
  // Valid padding tags grow the container beyond 64 MiB without adding pictures.
  await copyFile('fixtures/flv-analysis/legacy-h264.flv', join(root, 'large.flv'));
  const file = await open(join(root, 'large.flv'), 'a');
  const padding = Buffer.alloc(1024 * 1024 + 15); padding[0] = 18;
  padding.writeUIntBE(1024 * 1024, 1, 3); padding.writeUInt32BE(1024 * 1024 + 11, padding.length - 4);
  try { for (let i = 0; i < 65; i++) await file.write(padding); } finally { await file.close(); }
  const f = await fixture(root, 'large.flv'), scheduler = new AnalysisScheduler(f.library, coreDir, join(f.folder, 'analysis'));
  try {
    const demand = await scheduler.submit(f.entry.id, f.entry.version!, {
      mode: 'stream', sourceVersion: `${f.entry.id}@${f.entry.version}`, firstPtsUs: 2000000, durationUs: 10000000,
      indexIdentity: (await import('../../shared/media/indexing/media-index-identity.ts')).FLV_MEDIA_INDEX_IDENTITY,
      window: { startUs: 4000000, endUs: 4100000, axis: 'pts' },
    }, 'viewport');
    const state = await wait(scheduler, demand.requestId, 'viewport');
    assert.equal(state.state, 'complete', state.error ?? '');
    assert.ok(state.published! > 0 && state.published! < 100, 'viewport never decodes the full 600-picture film');
    assert.equal(state.progress?.waitingForIndex, false);
    assert.equal(state.progress?.indexComplete, true);
  } finally { await scheduler.close(); await f.close(); await rm(root, { recursive: true, force: true }); }
});

type ReadableStreamSnapshot = { state?: string; cursor: number; published?: number; received: number; counters?: unknown; progress?: unknown };
/** Correctness waits follow consumed/readable products, not seq/counter heartbeats.
 * Ten seconds without readable progress still fails; total execution is bounded.
 * Neither limit is a throughput acceptance threshold for a particular machine. */
function readableStreamWait(phase: string, initialReceived = 0, now = () => performance.now(), emit = (value: unknown) => console.log(JSON.stringify(value))) {
  const started = now(); let lastProgress = started, lastCursor = 0, lastReceived = initialReceived, oldLimitLogged = false;
  let last: ReadableStreamSnapshot = { cursor: 0, received: initialReceived }, polls = 0;
  const detail = () => ({ phase, elapsedMs: now() - started, polls, lastProgressAgeMs: now() - lastProgress, ...last });
  return {
    observe(snapshot: ReadableStreamSnapshot) {
      polls++; last = snapshot;
      const at = now(), diagnostic = JSON.stringify(detail());
      assert.ok(at - started <= 120_000, `Stream correctness total deadline exceeded: ${diagnostic}`);
      assert.ok(at - lastProgress <= 10_000, `Stream has no readable progress: ${diagnostic}`);
      assert.ok(snapshot.cursor >= lastCursor && snapshot.received >= lastReceived, `Stream readable progress regressed: ${diagnostic}`);
      if (snapshot.cursor > lastCursor || snapshot.received > lastReceived) lastProgress = at;
      lastCursor = snapshot.cursor; lastReceived = snapshot.received;
      if (phase === 'resume' && !oldLimitLogged && (polls >= 2000 || at - started >= 10_000)) {
        oldLimitLogged = true; emit({ event: 'stream-test-old-poll-limit', ...detail() });
      }
    },
    done() { const summary = detail(); emit({ event: 'stream-test-phase-complete', ...summary }); return summary; },
  };
}

test('readable stream deadline permits slow advancing work but rejects idle heartbeats and unbounded total work', () => {
  let at = 0; const events: unknown[] = [], progressing = readableStreamWait('resume', 0, () => at, value => events.push(value));
  for (let au = 1; au <= 13; au++) { at += 9000; progressing.observe({ state: 'running', cursor: au, published: au, received: au }); }
  assert.equal(progressing.done().elapsedMs, 117000, 'continued readable progress may cross the former overall ten-second poll cap');
  assert.equal(events.filter(value => (value as {event:string}).event === 'stream-test-old-poll-limit').length, 1);
  at += 9000; assert.throws(() => progressing.observe({ cursor: 14, published: 14, received: 14 }), /total deadline/);
  at = 0; const idle = readableStreamWait('idle', 30, () => at, () => {});
  at = 5000; idle.observe({ state: 'running', cursor: 0, published: 32, received: 30, counters: { feed: 1 } });
  at = 10001; assert.throws(() => idle.observe({ state: 'running', cursor: 0, published: 64, received: 30, counters: { feed: 100 } }), /no readable progress.*"cursor":0.*"published":64.*"received":30.*"feed":100/);
});

test('summary pages resume without duplicate writes; warm work has zero decode and metadata stays independent of blocks',async()=>{
 const {encodeProduct}=await import('../../shared/analysis/bitstream/products.ts');
 const f=await fixture(resolve('fixtures/video'),'mhw_hevc_fullrange_bt709_3s.mp4'),scheduler=new AnalysisScheduler(f.library,coreDir,join(f.folder,'analysis'));
 const sourceVersion=`${f.entry.id}@${f.entry.version}`,request={mode:'stream' as const,product:'summary' as const,sourceVersion,firstPtsUs:0,durationUs:3000000,window:{startUs:500000,endUs:700000,axis:'pts' as const}};
 const writes=new Map<number,number>(),put=scheduler.store.putOutput.bind(scheduler.store);scheduler.store.putOutput=(id,value,protectedFiles)=>{writes.set(value.picture.au,(writes.get(value.picture.au)??0)+1);return put(id,value,protectedFiles);};
 const received=new Set<number>();let bytes=0;
 const snapshot=(state:Awaited<ReturnType<AnalysisScheduler['streamStatus']>>,cursor:number,count:number):ReadableStreamSnapshot=>({state:state?.state,cursor,published:state?.published,received:count,counters:state?.counters,progress:state?.progress});
 try{
  const first=await scheduler.submit(f.entry.id,f.entry.version!,request,'owner');let cursor=0;
  const firstWait=readableStreamWait('first-30');
  while(received.size<30){const state=await scheduler.streamStatus(first.requestId,'owner',cursor);assert.ok(state);assert.ok(['running','queued','complete'].includes(state.state),JSON.stringify(state));for(const ref of state.chunks){if(received.size===30)break;const value=await scheduler.store.getOutput(ref.id,ref.au);assert.ok(value&&'product' in value&&value.product==='summary');assert.ok(!received.has(value.picture.au));received.add(value.picture.au);bytes+=(await encodeProduct(value)).length;cursor=ref.cursor;}firstWait.observe(snapshot(state,cursor,received.size));await new Promise(r=>setTimeout(r,5));}
  firstWait.done();assert.equal(scheduler.release(first.requestId,'owner'),true);assert.equal(scheduler.status(first.requestId,'owner'),null,'cancelled consumer lease is released');
  const resumed=await scheduler.submit(f.entry.id,f.entry.version!,request,'owner');cursor=0;let final;const resumeWait=readableStreamWait('resume',received.size);
  for(;;){
   const state=await scheduler.streamStatus(resumed.requestId,'owner',cursor);assert.ok(state);assert.ok(state.chunks.length<=32);
   for(const ref of state.chunks){if(!received.has(ref.au!)){const value=await scheduler.store.getOutput(ref.id,ref.au);assert.ok(value&&'product' in value&&value.product==='summary');received.add(value.picture.au);bytes+=(await encodeProduct(value)).length;}cursor=ref.cursor;}
   resumeWait.observe(snapshot(state,cursor,received.size));
   if(state.state==='complete'&&cursor===state.published){final=state;resumeWait.done();break;}assert.ok(['running','queued','complete'].includes(state.state),JSON.stringify(state));await new Promise(r=>setTimeout(r,5));
  }
  assert.ok(final);assert.equal(received.size,180);assert.ok(bytes<=512*1024);assert.equal(writes.size,180);assert.ok([...writes.values()].every(n=>n===1),'committed summaries are never written twice on resume');assert.ok(final.counters!.cacheHit>=30);assert.equal(final.counters!.uniqueDelivered,180);scheduler.release(resumed.requestId,'owner');
  const warm=await scheduler.submit(f.entry.id,f.entry.version!,request,'owner');cursor=0;let complete;const warmReceived=new Set<number>(),warmWait=readableStreamWait('warm');
  for(;;){const state=await scheduler.streamStatus(warm.requestId,'owner',cursor);assert.ok(state);for(const ref of state.chunks){const value=await scheduler.store.getOutput(ref.id,ref.au);assert.ok(value&&'product' in value&&value.product==='summary');assert.equal(value.picture.au,ref.au);assert.ok(!warmReceived.has(value.picture.au));warmReceived.add(value.picture.au);cursor=ref.cursor;}warmWait.observe(snapshot(state,cursor,warmReceived.size));if(state.state==='complete'&&cursor===180){complete=state;warmWait.done();break;}assert.ok(['running','queued','complete'].includes(state.state),JSON.stringify(state));await new Promise(r=>setTimeout(r,5));}
  assert.equal(warmReceived.size,180);assert.ok(complete);for(const name of ['init','open','feed','step','decodedAU'] as const)assert.equal(complete.counters![name],0);assert.ok([...writes.values()].every(n=>n===1));scheduler.release(warm.requestId,'owner');
 }finally{await scheduler.close();await f.close();}
});

test('large legacy chunks stop below 32 at the cumulative byte reservation and last consumer releases the worker',async()=>{
 const {PRODUCT_LIMIT}=await import('../../shared/analysis/bitstream/products.ts');const {BUDGET}=await import('../../shared/analysis/bitstream/contract.ts');const f=await fixture(resolve('fixtures/video'),'mhw_hevc_fullrange_bt709_3s.mp4'),scheduler=new AnalysisScheduler(f.library,coreDir,join(f.folder,'analysis'));
 try{const request=await scheduler.submit(f.entry.id,f.entry.version!,{mode:'stream',sourceVersion:`${f.entry.id}@${f.entry.version}`,firstPtsUs:0,durationUs:3000000,window:{startUs:500000,endUs:700000,axis:'pts'}},'slow');let stable=0,previous=-1,status;
  for(let i=0;i<500;i++){status=await scheduler.streamStatus(request.requestId,'slow',0);assert.ok(status);assert.ok(['queued','running'].includes(status.state),JSON.stringify(status));stable=status.published===previous?stable+1:0;previous=status.published!;if(stable>=8&&status.published!>0)break;await new Promise(r=>setTimeout(r,25));}
  assert.ok(status&&status.published!>0&&status.published!<32);assert.ok(status.chunks.reduce((n,ref)=>n+(ref.bytes??0),0)<=PRODUCT_LIMIT.inFlight && status.chunks.reduce((n,ref)=>n+(ref.bytes??0),0)+BUDGET.resultBytes>PRODUCT_LIMIT.inFlight);scheduler.release(request.requestId,'slow');await scheduler.close();assert.equal(scheduler.resources().running,0);
 }finally{await scheduler.close();await f.close();}
});

test('explicit legacy index namespace rejects old valid records and preserves current single/stream retry hits',async()=>{
 const media=await mkdtemp(join(tmpdir(),'vp-legacy-index-'));(await import('node:child_process')).execFileSync('ffmpeg',['-y','-v','error','-f','lavfi','-i','testsrc2=size=64x64:rate=5:duration=1','-an','-c:v','libx264','-g','5','-bf','0',join(media,'namespace.flv')]);
 const f=await fixture(media,'namespace.flv'),scheduler=new AnalysisScheduler(f.library,coreDir,join(f.folder,'legacy-index-namespace'));
 const {FLV_MEDIA_INDEX_IDENTITY:identity}=await import('../../shared/media/indexing/media-index-identity.ts');
 try{
  const old=await scheduler.submit(f.entry.id,f.entry.version!,target(f.entry),'owner'),oldState=await wait(scheduler,old.requestId,'owner');assert.equal(oldState.state,'complete');const oldId=oldState.resultUrl!.match(/chunks\/([a-f0-9]{64})/)![1];const valid=await scheduler.store.get(oldId);assert.ok(valid,'old implicit namespace is a valid checksummed full result');
  const next=await scheduler.submit(f.entry.id,f.entry.version!,{...target(f.entry),indexIdentity:identity},'owner');assert.equal(next.cacheHit,false,'explicit index must not authorize the old valid namespace');const nextState=await wait(scheduler,next.requestId,'owner');assert.equal(nextState.state,'complete');const nextId=nextState.resultUrl!.match(/chunks\/([a-f0-9]{64})/)![1];assert.notEqual(nextId,oldId);
  const retry=await scheduler.submit(f.entry.id,f.entry.version!,{...target(f.entry),indexIdentity:identity},'owner');assert.equal(retry.cacheHit,true);
  const restarted=new AnalysisScheduler(f.library,coreDir,join(f.folder,'legacy-index-namespace'));try{assert.equal((await restarted.submit(f.entry.id,f.entry.version!,{...target(f.entry),indexIdentity:identity},'owner')).cacheHit,true,'current explicit namespace survives scheduler restart');}finally{await restarted.close();}
  const keys=scheduler as unknown as {pictureChunk:(work:{target:{sourceVersion:string;indexIdentity:typeof identity};buildId:string},picture:NonNullable<typeof valid>['picture'])=>string};
  const a=keys.pictureChunk({target:{sourceVersion:valid.picture.sourceVersion,indexIdentity:identity},buildId:valid.buildId},valid.picture),b=keys.pictureChunk({target:{sourceVersion:valid.picture.sourceVersion,indexIdentity:{kind:'ffmpeg',streamKey:'video:0',schemaVersion:(await import('../../shared/media/indexing/ffmpeg-index-cache.ts')).FFMPEG_INDEX_SCHEMA,indexerBuild:'a'.repeat(40)}},buildId:valid.buildId},valid.picture);assert.equal(a,nextId);assert.notEqual(a,b);assert.equal(await scheduler.store.get(b),null);
  const stream=await scheduler.submit(f.entry.id,f.entry.version!,{mode:'stream',sourceVersion:valid.picture.sourceVersion,indexIdentity:identity,firstPtsUs:0,durationUs:10000000,window:{startUs:0,endUs:1000,axis:'pts'}},'owner');let cursor=0,seen=false;
  for(let i=0;i<1000;i++){const status=await scheduler.streamStatus(stream.requestId,'owner',cursor);assert.ok(status);for(const ref of status.chunks){assert.notEqual(ref.id,oldId);if(ref.au===0){assert.equal(ref.id,nextId);seen=true;}cursor=ref.cursor;}if(status.state==='complete'&&cursor===status.published)break;assert.ok(!['error','limited','cancelled'].includes(status.state),JSON.stringify(status));await new Promise(r=>setTimeout(r,5));}assert.ok(seen);
 }finally{await scheduler.close();await f.close();await rm(media,{recursive:true,force:true});}
});

test('canonical blocks single and stream reuse one record across restart without a decoder',async()=>{
 const {mkdir}=await import('node:fs/promises');const media=await mkdtemp(join(tmpdir(),'vp-blocks-canonical-'));
 (await import('node:child_process')).execFileSync('ffmpeg',['-y','-v','error','-f','lavfi','-i','testsrc2=size=64x64:rate=1:duration=1','-an','-c:v','libx264','-g','1','-bf','0',join(media,'one.mp4')]);
 const f=await fixture(media,'one.mp4'),manifestOnly=join(f.folder,'manifest-only');await mkdir(manifestOnly);await copyFile(join(coreDir,'manifest.json'),join(manifestOnly,'manifest.json'));
 try{for(const order of ['single-first','stream-first']){
  const directory=join(f.folder,order),single={...target(f.entry),product:'blocks' as const},stream={mode:'stream' as const,product:'blocks' as const,sourceVersion:single.sourceVersion,firstPtsUs:0,durationUs:1000000};let scheduler=new AnalysisScheduler(f.library,coreDir,directory),id='';
  const readStream=async()=>{const request=await scheduler.submit(f.entry.id,f.entry.version!,stream,'owner');for(let i=0;i<500;i++){const state=await scheduler.streamStatus(request.requestId,'owner',0);assert.ok(state);if(state.chunks.length){assert.equal(state.chunks.length,1);const ref=state.chunks[0];assert.ok(await scheduler.store.getOutput(ref.id));assert.equal(state.counters?.init??0,0);assert.equal(state.counters?.feed??0,0);return ref.id;}assert.ok(!['error','limited'].includes(state.state),JSON.stringify(state));await new Promise(r=>setTimeout(r,10));}throw Error('no cached stream');};
  if(order==='single-first'){const request=await scheduler.submit(f.entry.id,f.entry.version!,single,'owner');const state=await wait(scheduler,request.requestId,'owner');assert.equal(state.state,'complete',state.error??'');id=state.resultUrl!.match(/chunks\/([a-f0-9]{64})/)![1];await scheduler.close();scheduler=new AnalysisScheduler(f.library,manifestOnly,directory);assert.equal(await readStream(),id);}
  else{const request=await scheduler.submit(f.entry.id,f.entry.version!,stream,'owner');for(let i=0;i<500;i++){const state=await scheduler.streamStatus(request.requestId,'owner',0);assert.ok(state);if(state.chunks.length){id=state.chunks[0].id;break;}assert.ok(!['error','limited'].includes(state.state),JSON.stringify(state));await new Promise(r=>setTimeout(r,10));}assert.ok(id);await scheduler.close();scheduler=new AnalysisScheduler(f.library,manifestOnly,directory);const cached=await scheduler.submit(f.entry.id,f.entry.version!,single,'owner');assert.equal(cached.cacheHit,true);const state=await wait(scheduler,cached.requestId,'owner');assert.ok(state.resultUrl!.includes(id));assert.equal(state.counters?.init??0,0);assert.equal(state.counters?.feed??0,0);}
  await scheduler.close();
 }}finally{await f.close();await rm(media,{recursive:true,force:true});}
});
