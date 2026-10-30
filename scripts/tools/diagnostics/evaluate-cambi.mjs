/** Explicit local observations, never a cloud performance gate or subjective
 * calibration. Uses committed encoded media and independent official oracles. */
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import {
  cambiFixture,
  cambiOracle,
} from "../../../test/helpers/native-cambi.mjs";
import { assertOfficial } from "../../../test/helpers/official-quality-oracle.mjs";
import { CAMBI_RECIPE } from "../../../shared/analysis/quality/cambi.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const options = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.split("=");
    return [k, v.join("=")];
  }),
);
assert.ok(
  Object.keys(options).every((k) => ["--rounds", "--output"].includes(k)),
  "Use --rounds=N --output=FILE",
);
const rounds = Number(options["--rounds"] ?? 3);
assert.ok(Number.isInteger(rounds) && rounds >= 1 && rounds <= 5);
const output = path.resolve(
  options["--output"] ?? ".run/cambi-screening/report.json",
);
const fixtures = await readFile(
  path.join(root, "test/helpers/native-cambi-samples.json"),
);
const rows = [],
  threshold = 10;
const construction = {
  banded: {
    target: "coarse-step-present",
    description: "100+floor(x/24) luma codes, no added noise",
  },
  smooth: {
    target: "no-added-coarse-step",
    description:
      "80+140*x/width luma ramp, quantized at source depth; 8-bit plateaus are not a pristine reference",
  },
  texture: {
    target: "no-added-coarse-step",
    description:
      "Periodic high-detail luma ((31*x+17*y+11*frame)%220); content changes across frames",
  },
  grain: {
    target: "coarse-step-present",
    description:
      "The banded ramp plus deterministic uniform [-7,7] luma noise; injected steps may be perceptually masked",
  },
  flat: {
    target: "no-added-coarse-step",
    description: "Constant luma100; chroma128",
  },
  natural: {
    target: "unlabelled",
    description:
      "Pinned licensed processed natural frame, repeated four times; 10-bit version left-shifts8-bit codes and does not restore precision",
  },
};
const percentile = (values, p) =>
  values.length
    ? [...values].sort((a, b) => a - b)[
        Math.min(values.length - 1, Math.ceil(values.length * p) - 1)
      ]
    : null;
const distribution = (values) => ({
  count: values.length,
  p50: percentile(values, 0.5),
  p95: percentile(values, 0.95),
  max: values.length ? Math.max(...values) : null,
});
const git = (...args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const startedAt = new Date().toISOString(),
  revision = git("rev-parse", "HEAD"),
  dirty = git("status", "--porcelain").length > 0;
for (const depth of [8, 10])
  for (const pattern of Object.keys(construction))
    for (let round = 0; round < rounds; round++) {
      const f = await cambiFixture({ depth, pattern });
      let stop = false,
        monitor,
        timer,
        peakRss = process.memoryUsage().rss;
      try {
        const baseline = [];
        for (let i = 0; i < 8; i++) {
          const start = performance.now();
          const r = await f.request("/api/library/browse?limit=1");
          assert.equal(r.status, 200);
          await r.arrayBuffer();
          baseline.push(performance.now() - start);
        }
        const latency = [];
        timer = setInterval(() => {
          peakRss = Math.max(peakRss, process.memoryUsage().rss);
        }, 10);
        const start = performance.now(),
          job = (
            await f.json(
              "/api/quality/cambi/jobs",
              f.input,
              `evaluation-${round}`,
            )
          ).job;
        monitor = (async () => {
          while (!stop && latency.length < 128) {
            const start = performance.now(),
              r = await f.request("/api/library/browse?limit=1");
            assert.equal(r.status, 200);
            await r.arrayBuffer();
            latency.push(performance.now() - start);
            if (!stop) await new Promise((r) => setTimeout(r, 10));
          }
        })();
        // Observe rejection immediately even while the real job is being awaited.
        void monitor.catch(() => {});
        const done = await f.wait(job.id);
        stop = true;
        await monitor;
        const elapsedMs = performance.now() - start;
        assert.equal(done.state, "completed", JSON.stringify(done));
        const result = await f.json(`/api/quality/cambi/jobs/${job.id}/result`),
          page = await f.json(`/api/quality/cambi/jobs/${job.id}/frames`),
          oracle = await cambiOracle(f, depth);
        assertOfficial(
          result.pooled,
          oracle.result.pooled_metrics.cambi,
          0.000001,
        );
        assert.equal(page.entries.length, 4);
        for (const frame of page.entries) {
          assert.ok(
            Math.abs(
              frame.score - oracle.result.frames[frame.index].metrics.cambi,
            ) <= 0.000001,
          );
          for (const m of frame.heatmaps)
            assert.equal(
              m.sha256,
              oracle.heatmaps[m.scale].frames[frame.index],
            );
        }
        const target = construction[pattern].target,
          flagged = result.pooled.max >= threshold;
        const screeningOutcome =
          target === "unlabelled"
            ? "unlabelled"
            : target === "coarse-step-present"
              ? flagged
                ? "injected-step-hit"
                : "injected-step-miss"
              : flagged
                ? "coarse-step-policy-false-positive"
                : "coarse-step-policy-negative";
        rows.push({
          pattern,
          depth,
          round,
          ...construction[pattern],
          screeningOutcome,
          illustrativeThreshold: threshold,
          input: {
            encodedSha256: f.sample.flvSha256,
            rawSha256: f.sample.rawSha256,
            width: f.sample.width,
            height: f.sample.height,
            frames: f.sample.frames,
            upstream: f.sample.upstream ?? null,
          },
          scores: page.entries.map((frame) => frame.score),
          pooled: result.pooled,
          component: result.component,
          observed: {
            submitToObservedTerminalMs: elapsedMs,
            queueMs: done.startedAt - done.createdAt,
            executionMs: done.endedAt - done.startedAt,
            scorer: result.resources,
            decode: result.work,
            heatBytes: result.output.actualBytes,
            processRssPeakBytes: peakRss,
            libraryHttpBaselineMs: distribution(baseline),
            libraryHttpDuringJobMs: distribution(latency),
          },
        });
      } finally {
        stop = true;
        clearInterval(timer);
        await monitor?.catch(() => {});
        await f.close();
      }
    }
const grouped = Object.entries(construction).flatMap(([pattern, definition]) =>
  [8, 10].map((depth) => {
    const selected = rows.filter(
      (r) => r.pattern === pattern && r.depth === depth,
    );
    assert.ok(
      selected.every(
        (r) => JSON.stringify(r.scores) === JSON.stringify(selected[0].scores),
      ),
      "Repeated cold jobs must retain identical scores",
    );
    return {
      pattern,
      depth,
      ...definition,
      screeningOutcome: selected[0].screeningOutcome,
      pooled: selected[0].pooled,
      executionMs: distribution(selected.map((r) => r.observed.executionMs)),
      queueMs: distribution(selected.map((r) => r.observed.queueMs)),
      processRssPeakBytes: Math.max(
        ...selected.map((r) => r.observed.processRssPeakBytes),
      ),
      libraryHttpP95Ms: distribution(
        selected
          .map((r) => r.observed.libraryHttpDuringJobMs.p95)
          .filter((v) => v !== null),
      ),
    };
  }),
);
const report = {
  schema: "voidplayer-cambi-screening-observations",
  version: 1,
  startedAt,
  finishedAt: new Date().toISOString(),
  revision,
  dirty,
  host: {
    platform: os.platform(),
    arch: os.arch(),
    cpu: os.cpus()[0]?.model,
    logicalCpus: os.availableParallelism(),
    memoryBytes: os.totalmem(),
    node: process.version,
  },
  fixtureSha256: createHash("sha256").update(fixtures).digest("hex"),
  recipe: CAMBI_RECIPE,
  rounds,
  method: {
    labels:
      "Known synthetic construction, not human visibility/quality labels. Natural source is unlabelled.",
    threshold:
      "10 is an illustrative fixed coarse-step screening policy, not a calibrated recommendation or product default.",
    runtime:
      "Independent cold HTTP jobs with committed media; OS caches may remain warm. No time/throughput assertion.",
    processRss:
      "10ms samples of this whole Node service/test process including Workers, not an isolated task or OS quota.",
    http: "Sequential read-only library probes, bounded128 samples, no flood or percentile gate.",
    limitations: [
      "Small structured fixture set, not a population accuracy estimate.",
      "Natural footage is one processed repeated frame.",
      "No subjective pass/fail, temporal tracking, HDR or arbitrary-content certification.",
      "Content-changing texture and noise are covered; camera motion, cuts and flicker need separate labelled temporal data.",
    ],
  },
  grouped,
  rows,
};
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(report, null, 2) + "\n");
console.log(
  JSON.stringify({
    report: output,
    rounds,
    jobs: rows.length,
    groups: grouped.length,
    officialNumericsAndAllHeatmaps: true,
    performanceGates: false,
  }),
);
