import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { nativeFixture } from "../helpers/native-vmaf.mjs";
import { cambiFixture } from "../helpers/native-cambi.mjs";
import { qualityEvidenceValue } from "../../shared/review/quality-evidence.ts";
import { clockDeltaEquals } from "../../shared/media/indexing/rational-clock.ts";
const oracle = JSON.parse(
  readFileSync("test/helpers/analysis-quality-oracle.json", "utf8"),
);
const samples = JSON.parse(
  readFileSync("test/helpers/native-vmaf-samples.json", "utf8"),
).samples;
for (const timescale of [24, 30, 60, 24000, 30000]) {
  const cadence = { ticks: timescale > 1000 ? 1001 : 1, timescale };
  test(
    `actual MP4 HTTP VMAF exact ${timescale}/${cadence.ticks} source clocks`,
    { timeout: 120000 },
    async (t) => {
      const f = await nativeFixture({
        component: false,
        distorted: true,
        containers: ["mp4", "mp4"],
        frameRate: cadence,
      });
      t.after(() => f.close());
      assert.equal(
        (await f.json("/api/quality/vmaf/capability")).enabled,
        true,
      );
      const { job } = await f.json(
        "/api/quality/vmaf/jobs",
        f.input,
        "wasm-clock",
      );
      const completed = await f.wait(job.id);
      assert.equal(
        completed.state,
        "completed",
        JSON.stringify(completed.reason),
      );
      const result = await f.json(`/api/quality/vmaf/jobs/${job.id}/result`);
      assert.equal(result.vmaf.component.executor, "analysis-wasm");
      assert.equal(result.vmaf.resources.executor, "analysis-wasm");
      assert.equal("supervisorSha256" in result.vmaf.component, false);
      const expected = oracle.cases.find(
        (c: any) =>
          c.metric === "vmaf" &&
          c.model === "vmaf_v0.6.1" &&
          samples[c.sampleIndex].codec === "h264" &&
          samples[c.sampleIndex].depth === 8 &&
          samples[c.sampleIndex].tagged,
      );
      result.vmaf.frames.forEach((v: any, i: number) =>
        assert.ok(Math.abs(v.score - expected.frames[i]) < 0.00001),
      );
      const policy = {
        space: "default",
        side: "reference",
        maxScore: 100,
        limit: 1,
        minFrameDistance: 1,
        text: "Exact source-tick temporal measurement",
        severity: 2,
      };
      const publication = await f.json(
        `/api/quality/vmaf/jobs/${job.id}/candidates`,
        policy,
      );
      const annotation = await f.json(
        "/api/annotations/spaces/default/" + publication.createdIds[0],
      );
      const evidence = annotation.document.mark.qualityEvidence[0].value;
      qualityEvidenceValue(evidence);
      assert.deepEqual(evidence.sequenceVmaf.sequence.cadence, cadence);
      for (const side of ["reference", "distorted"]) {
        const frames = evidence.sequenceVmaf.sequence.pairs;
        const time = (f: any) => ({
          ticks: f.container.sample.dtsTicks + f.container.sample.ctsTicks,
          timescale: f.container.timescale,
        });
        for (let i = 1; i < frames.length; i++)
          assert.ok(
            clockDeltaEquals(
              time(frames[i][side]),
              time(frames[i - 1][side]),
              cadence,
            ),
          );
      }
      assert.equal(
        (await f.json("/api/quality/vmaf/jobs", f.input, "wasm-clock")).job.id,
        job.id,
      );
      assert.deepEqual(
        (await f.json(`/api/quality/vmaf/jobs/${job.id}/candidates`, policy))
          .createdIds,
        publication.createdIds,
      );
    },
  );
}
for (const depth of [8, 10])
  test(
    `actual ${depth}-bit CAMBI HTTP uses analysis core and exact official heatmaps`,
    { timeout: 120000 },
    async (t) => {
      const f = await cambiFixture({ component: false, depth });
      t.after(() => f.close());
      const { job } = await f.json(
        "/api/quality/cambi/jobs",
        f.input,
        "wasm-cambi",
      );
      const done = await f.wait(job.id);
      assert.equal(done.state, "completed", JSON.stringify(done.reason));
      const result = await f.json(`/api/quality/cambi/jobs/${job.id}/result`);
      assert.equal(result.component.executor, "analysis-wasm");
      const expected = oracle.cases.find(
        (c: any) =>
          c.metric === "cambi" && c.referenceSha256 === f.sample.rawSha256,
      );
      assert.ok(expected);
      const page = await f.json(`/api/quality/cambi/jobs/${job.id}/frames`);
      for (const frame of page.entries) {
        assert.ok(
          Math.abs(frame.score - expected.frames[frame.index]) <= 0.000001,
        );
        for (const map of frame.heatmaps)
          assert.equal(
            map.sha256,
            expected.heatmaps[map.scale].frames[frame.index],
          );
      }
    },
  );

for (const depth of [8, 10])
  test(
    `${depth}-bit fixed ROI VMAF is recomputed from exact cropped source pixels`,
    { timeout: 120000 },
    async (t) => {
      const roi = { x: 16, y: 16, width: 96, height: 64 },
        f = await nativeFixture({
          component: false,
          distorted: true,
          containers: ["mp4", "mp4"],
          depth,
          roi,
        });
      t.after(() => f.close());
      const { job } = await f.json(
        "/api/quality/vmaf/jobs",
        f.input,
        "wasm-roi",
      );
      const done = await f.wait(job.id);
      assert.equal(done.state, "completed", JSON.stringify(done.reason));
      const result = await f.json(`/api/quality/vmaf/jobs/${job.id}/result`);
      const expected = oracle.cases.find(
        (c: any) =>
          c.metric === "vmaf" &&
          c.model === "vmaf_v0.6.1" &&
          c.roi &&
          samples[c.sampleIndex].depth === depth &&
          samples[c.sampleIndex].tagged &&
          samples[c.sampleIndex].codec === (depth === 8 ? "h264" : "hevc"),
      );
      assert.ok(expected);
      assert.deepEqual(result.vmaf.recipe.roi, roi);
      assert.equal(result.raw.referenceSha256, expected.referenceSha256);
      assert.equal(result.raw.distortedSha256, expected.distortedSha256);
      result.vmaf.frames.forEach((v: any, i: number) =>
        assert.ok(Math.abs(v.score - expected.frames[i]) <= 0.00001),
      );
      const publication = await f.json(
        `/api/quality/vmaf/jobs/${job.id}/candidates`,
        {
          space: "default",
          side: "reference",
          maxScore: 100,
          limit: 1,
          minFrameDistance: 1,
          text: "Fixed crop temporal measurement",
          severity: 2,
        },
      );
      const annotation = await f.json(
          "/api/annotations/spaces/default/" + publication.createdIds[0],
        ),
        evidence = annotation.document.mark.qualityEvidence[0].value;
      qualityEvidenceValue(evidence);
      assert.equal(
        evidence.sequenceVmaf.spatial,
        "cropped-region-temporal-score-not-localized",
      );
      assert.deepEqual(evidence.result.metric.roi, roi);
      const tampered = structuredClone(evidence);
      tampered.sequenceVmaf.recipe.roi.x += 2;
      assert.throws(() => qualityEvidenceValue(tampered));
    },
  );

test(
  "more than the old lifetime quota completes; release preserves receipts and protects published evidence",
  { timeout: 120000 },
  async (t) => {
    const f = await nativeFixture({
      component: false,
      distorted: true,
      containers: ["mp4", "mp4"],
    });
    t.after(() => f.close());
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) {
      const { job } = await f.json(
        "/api/quality/vmaf/jobs",
        f.input,
        "batch-" + i,
      );
      ids.push(job.id);
      assert.equal((await f.wait(job.id)).state, "completed");
    }
    const tasks = await f.json("/api/tasks?kind=vmaf&limit=50");
    assert.equal(tasks.total, 20);
    assert.ok(tasks.entries.some((e: any) => e.id === ids[0]));
    const released = await f.json(
      `/api/tasks/vmaf/${ids[0]}/release-result`,
      {},
    );
    assert.equal(released.receiptRetained, true);
    assert.equal(
      (await f.json("/api/quality/vmaf/jobs", f.input, "batch-0")).job.id,
      ids[0],
    );
    assert.equal(
      (await f.json(`/api/tasks/vmaf/${ids[0]}`)).task.result.available,
      false,
    );
    const policy = {
      space: "default",
      side: "reference",
      maxScore: 100,
      limit: 1,
      minFrameDistance: 1,
      text: "Retained shared evidence",
      severity: 2,
    };
    await f.json(`/api/quality/vmaf/jobs/${ids[1]}/candidates`, policy);
    assert.equal(
      (await f.request(`/api/tasks/vmaf/${ids[1]}/release-result`, {})).status,
      409,
    );
    assert.equal(
      (await f.json(`/api/tasks/vmaf/${ids[1]}`)).task.result.available,
      true,
    );
  },
);

for (const [codec, depth] of [
  ["h264", 8],
  ["hevc", 8],
  ["hevc", 10],
] as const)
  test(
    `192-frame ${codec} ${depth}-bit reordered clip uses one decode per 64-frame GOP`,
    { timeout: 180000 },
    async (t) => {
      const f = await nativeFixture({
        component: false,
        distorted: true,
        sequence: true,
        codec,
        depth,
      });
      t.after(() => f.close());
      const { job } = await f.json(
          "/api/quality/vmaf/jobs",
          f.input,
          "long-sequence",
        ),
        done = await f.wait(job.id);
      assert.equal(done.state, "completed", JSON.stringify(done.reason));
      const result = await f.json(`/api/quality/vmaf/jobs/${job.id}/result`),
        sample = f.sample;
      assert.equal(result.coverage.vmafScoredFrames, 192);
      assert.equal(result.work.packets, 384);
      assert.equal(
        result.work.outputFrames,
        384,
        "pre-roll/drain counted once per source GOP",
      );
      assert.equal(result.raw.referenceSha256, sample.reference.rawSha256);
      assert.equal(result.raw.distortedSha256, sample.distorted.rawSha256);
      result.vmaf.frames.forEach((frame: any, i: number) =>
        assert.ok(
          Math.abs(frame.score - sample.vmaf.frames[i]) <= 0.00001,
          `frame ${i}: ${frame.score} vs ${sample.vmaf.frames[i]}`,
        ),
      );
      for (const key of ["mean", "min", "max", "harmonic_mean"])
        assert.ok(
          Math.abs(result.vmaf.pooled[key] - sample.vmaf.pooled[key]) <=
            0.00001,
        );
      assert.ok(result.work.heapBytes <= 256 * 1024 * 1024);
      assert.ok(result.vmaf.resources.heapBytes <= 512 * 1024 * 1024);
      const publication = await f.json(
        `/api/quality/vmaf/jobs/${job.id}/candidates`,
        {
          space: "default",
          side: "reference",
          maxScore: 100,
          limit: 1,
          minFrameDistance: 1,
          text: "Long continuous clip with B-frame identity and complete drain",
          severity: 2,
        },
      );
      const annotation = await f.json(
          "/api/annotations/spaces/default/" + publication.createdIds[0],
        ),
        evidence = annotation.document.mark.qualityEvidence[0].value;
      qualityEvidenceValue(evidence);
      assert.equal(evidence.sequenceVmaf.frames, 192);
      assert.ok(
        evidence.sequenceVmaf.sequence.indices.includes(
          evidence.sequenceVmaf.index,
        ),
      );
      assert.match(
        evidence.sequenceVmaf.sequence.pairsSha256,
        /^[a-f0-9]{64}$/,
      );
      assert.equal(
        evidence.result.provenance.reference.dependency.outputIdentity.outputs
          .length,
        64,
      );
    },
  );

test('one-frame NTSC offset joins exact source ticks; rounded microseconds cannot match and actual range scores use those pairs', {timeout:120000}, async t=>{
  const f=await nativeFixture({component:false,distorted:true,containers:['mp4','mp4'],frameRate:{ticks:1001,timescale:30000}});
  t.after(()=>f.close());
  const original=await f.json(`/api/quality/correspondence-plans/${f.input.plan.id}`);
  const build=async(exact:boolean)=>{
    const relation=(await f.json('/api/quality/reference-relations',{...original.plan.relation.input,clock:{mode:'piecewise-exact-source-pts-offset',segments:[{id:'one-frame',referenceStartUs:0,referenceEndUs:10000000,offsetUs:33367,...(exact?{offset:{ticks:1001,timescale:30000}}:{})}]}},exact?'exact-shift':'rounded-shift')).relation;
    const accepted=await f.json('/api/quality/correspondence-plans',{...f.planInput,relation:{id:relation.id,revision:1}},exact?'exact-plan':'rounded-plan');
    let result;
    for(let i=0;i<600;i++){result=await f.json(`/api/quality/correspondence-plans/${accepted.plan.id}`);if(!['queued','running'].includes(result.plan.state))break;await new Promise(r=>setTimeout(r,10));}
    assert.equal(result.plan.state,exact?'completed':'blocked',JSON.stringify(result));
    return {plan:result.plan,rows:(await f.json(`/api/quality/correspondence-plans/${accepted.plan.id}/rows`)).entries};
  };
  const exact=await build(true),mapped=exact.rows.filter((r:any)=>r.status==='mapped');assert.equal(mapped.length,7);
  const time=(fact:any)=>({ticks:fact.clock.dtsTicks+fact.clock.ctsTicks,timescale:fact.clock.timescale});
  for(const row of mapped){assert.ok(clockDeltaEquals(time(row.distorted),time(row.reference),{ticks:1001,timescale:30000}));assert.equal(row.expectedDistortedPtsUs,row.distorted.ptsUs);}
  const rounded=await build(false);assert.equal(rounded.rows.filter((r:any)=>r.status==='mapped').length,0);assert.ok(rounded.rows.every((r:any)=>r.reason==='target-pts-missing'));
  const {job}=await f.json(`/api/quality/correspondence-plans/${exact.plan.id}/execute`,{digest:exact.plan.resultDigest});
  let range;
  for(let i=0;i<1200;i++){range=await f.json(`/api/quality/ranges/${job.id}`);if(!['queued','running','cancelling'].includes(range.job.state))break;await new Promise(r=>setTimeout(r,10));}
  assert.equal(range.job.state,'partial',JSON.stringify(range));assert.equal(range.job.summary.scoredPairs,7);
  for(const sample of range.job.samples){const result=await f.json(`/api/quality/jobs/${sample.jobId}/result`),row=mapped.find((r:any)=>r.au===sample.au);assert.equal(result.value.result.provenance.reference.picture.au,row.reference.au);assert.equal(result.value.result.provenance.distorted.picture.au,row.distorted.au);}
  const pinned=await f.request(`/api/tasks/single/${range.job.samples[0].jobId}/release-result`,{});assert.equal(pinned.status,409);assert.equal((await pinned.json()).code,'result-pinned-by-range');
});
