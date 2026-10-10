// Run real analysis from the extracted native executable with an empty PATH.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import path from "node:path";
import os from "node:os";
import { validateResult } from "../src/bitstream-analysis/contract.ts";
const root = path.resolve(import.meta.dirname, "..");
const archive = path.resolve(
  process.argv[2] ??
    JSON.parse(
      await readFile(path.join(root, "artifacts/latest-release.json"), "utf8"),
    ).archive,
);
const temp = await mkdtemp(path.join(os.tmpdir(), "vp-analysis-release-"));
let child,
  output = "";
async function stop() {
  if (!child || child.exitCode !== null) return;
  const stopped = once(child, "close");
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    await stopped;
  } finally {
    clearTimeout(timer);
  }
}
try {
  const tar =
    process.platform === "win32"
      ? path.join(process.env.SystemRoot, "System32", "tar.exe")
      : "tar";
  execFileSync(tar, ["-xzf", archive, "-C", temp]);
  const directory = path.join(temp, path.basename(archive, ".tar.gz")),
    manifest = JSON.parse(
      await readFile(path.join(directory, "release.json"), "utf8"),
    );
  const executable = path.join(directory, manifest.executable),
    data = path.join(temp, "data"),
    cwd = path.join(temp, "unrelated"),
    empty = path.join(temp, "empty-path");
  await Promise.all([mkdir(data), mkdir(cwd), mkdir(empty)]);
  const socket = createServer();
  await new Promise((r) => socket.listen(0, "127.0.0.1", r));
  const port = socket.address().port;
  await new Promise((r) => socket.close(r));
  const base = `http://127.0.0.1:${port}`;
  await writeFile(
    path.join(data, "voidplayer.config.json"),
    JSON.stringify({
      host: "127.0.0.1",
      port,
      mediaRoots: [
        { id: "qa", name: "QA", path: path.join(root, "fixtures/video") },
      ],
      indexWatch: false,
      logsDir: null,
    }),
  );
  const env = { ...process.env, PATH: empty };
  for (const key of Object.keys(env))
    if (
      key.startsWith("VOIDPLAYER_") ||
      ["BUN_OPTIONS", "BUN_INSPECT"].includes(key)
    )
      delete env[key];
  async function start() {
    output = "";
    child = spawn(executable, ["--data-dir", data], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (b) => (output += b));
    child.stderr.on("data", (b) => (output += b));
    for (let i = 0; i < 200; i++) {
      if (child.exitCode !== null) throw new Error(output);
      if (
        await fetch(base + "/api/ready")
          .then((r) => r.ok)
          .catch(() => false)
      )
        return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(output || "Native startup timeout");
  }
  async function request(entry) {
    const version = entry.version,
      response = await fetch(
        `${base}/api/media/${entry.id}/bitstream-analysis/requests?v=${version}`,
        {
          method: "POST",
          headers: {
            origin: base,
            "content-type": "application/json",
            "x-voidplayer-action": "bitstream-analysis",
          },
          body: JSON.stringify({
            version,
            target: {
              sourceVersion: `${entry.id}@${version}`,
              sourcePtsUs: entry.name.startsWith('h265_')?-50000:0,
              normalizedMediaUs: 0,
            },
          }),
        },
      );
    assert.equal(response.status, 202, await response.clone().text());
    return response.json();
  }
  async function result(request) {
    for (let i = 0; i < 200; i++) {
      const state = await (
        await fetch(
          `${base}/api/bitstream-analysis/requests/${request.requestId}`,
        )
      ).json();
      assert.notEqual(state.state, "error", state.error ?? output);
      if (state.state === "complete") {
        const result = await (await fetch(base + state.resultUrl)).json();
        validateResult(result);
        assert.equal(result.confidence, "exact");
        return result;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.fail("Native analysis timed out");
  }
  await start();
  const entries = (await (await fetch(base + "/api/library")).json()).entries,
    rows = [];
  for (const [codec, name] of [
    ["h264", "h264_9s_1920x1080.mp4"],
    ["hevc", "h265_10s_1920x1080.mp4"],
    ["vvc", "h266_10s_1920x1080.mp4"],
  ]) {
    const entry = entries.find((e) => e.name === name);
    assert.ok(entry, name);
    const r = await result(await request(entry));
    assert.equal(r.codec, codec);
    rows.push({ codec, picture: r.picture, blocks: r.blocks.length });
  }
  await stop();
  await start();
  assert.equal(
    (await request(entries.find((e) => e.name === "h264_9s_1920x1080.mp4")))
      .cacheHit,
    true,
    "native restart reuses completed chunks",
  );
  const report = path.resolve(
    process.env.VOIDPLAYER_TEST_ARTIFACTS ??
      path.join(root, ".run/analysis-release"),
  );
  await mkdir(report, { recursive: true });
  await writeFile(
    path.join(report, "native-analysis.json"),
    JSON.stringify({ target: manifest.target, rows }, null, 2),
  );
  console.log(
    `PASS ${manifest.target}: native H264/HEVC/VVC analysis and restart cache, empty PATH`,
  );
} finally {
  await stop();
  await rm(temp, { recursive: true, force: true });
}
