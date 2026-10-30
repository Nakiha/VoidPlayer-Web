import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { assertOfficial } from "../helpers/official-quality-oracle.mjs";
import { xpsnrFixture } from "../helpers/native-xpsnr.mjs";
import { qualityEvidenceValue } from "../../shared/review/quality-evidence.ts";
import { parseXpsnrStatistics } from "../../shared/analysis/quality/xpsnr.ts";
import { readXpsnrComparison } from "../../src/services/xpsnr-comparison.ts";
import { pinComparison } from "../../shared/analysis/quality/xpsnr-comparison.ts";

const assertXpsnr = (actual: unknown, expected: unknown) =>
  assertOfficial(actual, expected, 0.000051);

for (const [codec, depth] of [
  ["h264", 8],
  ["hevc", 8],
  ["hevc", 10],
] as const)
  for (const long of [false, true])
    test(
      `analysis XPSNR ${codec}/${depth}: ${long ? "192-frame continuous GOP" : "30000/1001 source clock"} cropped region, official pool and last-frame evidence`,
      { timeout: 120000 },
      async (t) => {
        const roi = { x: 16, y: 16, width: 96, height: 64 };
        const f = await xpsnrFixture({
          codec,
          depth,
          distorted: true,
          containers: ["mp4", "mp4"],
          roi,
          ...(long
            ? { sequence: true }
            : { frameRate: { ticks: 1001, timescale: 30000 } }),
        });
        t.after(() => f.close());
        const run = async (key: string) => {
          const j = (await f.json("/api/quality/xpsnr/jobs", f.input, key)).job;
          const done = await f.wait(j.id);
          assert.equal(done.state, "completed", JSON.stringify(done));
          return {
            job: done,
            result: await f.json(`/api/quality/xpsnr/jobs/${j.id}/result`),
          };
        };
        const { job, result: r } = await run("crop");
        const oracle = JSON.parse(
          await readFile(
            new URL("../helpers/analysis-xpsnr-oracle.json", import.meta.url),
            "utf8",
          ),
        );
        const expected = oracle.cases.find(
          (c: any) =>
            c.referenceSha256 === r.raw.referenceSha256 &&
            c.distortedSha256 === r.raw.distortedSha256 &&
            c.rate.ticks / c.rate.timescale ===
              f.input.cadence.ticks / f.input.cadence.timescale,
        );
        assert.ok(expected, "committed independent pixel/rate oracle");
        const scores = parseXpsnrStatistics(expected.text, r.companionPairs);
        assertXpsnr(r.xpsnr.frames, scores.frames);
        assertXpsnr(r.xpsnr.pooled, scores.pooled);
        assert.deepEqual(r.xpsnr.recipe.roi, roi);
        assert.equal(r.companionPairs, long ? 192 : 8);
        assert.equal(r.work.outputFrames, r.companionPairs * 2);
        const last = r.companionPairs - 1,
          url = `/api/quality/xpsnr/jobs/${job.id}/evidence?index=${last}&side=reference&attemptId=${job.attemptId}&digest=${job.resultDigest}`;
        const evidence = await f.json(url);
        assert.doesNotThrow(() => qualityEvidenceValue(evidence.value));
        const a = evidence.value.sequenceXpsnr;
        assert.equal(a.index, last);
        assert.equal(a.spatial, "cropped-region-temporal-score-not-localized");
        if (long) {
          assert.deepEqual(a.sequence.indices, [0, last]);
          assert.equal(a.sequence.pairs.length, 2);
        }
        const bad = structuredClone(evidence.value);
        bad.sequenceXpsnr.sequence.pairs.at(-1).reference.container.sample
          .ctsTicks++;
        assert.throws(() => qualityEvidenceValue(bad));
        const second = await run("compare");
        const ids = [job.id, second.job.id];
        const client: any = {
          request: (_actor: string, url: string) => f.json(url),
        };
        const comparison = await readXpsnrComparison(
          client,
          f.actor,
          ids,
          new AbortController().signal,
        );
        assert.equal(comparison.summaries[0].companionPairs, r.companionPairs);
        const tail = await readXpsnrComparison(
          client,
          f.actor,
          ids,
          new AbortController().signal,
          pinComparison(comparison.comparison, long ? 188 : 4),
        );
        assert.equal(tail.pages[0].entries.at(-1)!.index, last);
      },
    );
