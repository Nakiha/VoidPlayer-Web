import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import {
  AnalysisScorer,
  validateQualityCore,
} from "../../shared/analysis/quality/analysis-core.ts";
import { rgbaDescription } from "../../shared/media/frame-description.ts";

const directory =
  process.env.VOIDPLAYER_ANALYSIS_CORE_DIR ??
  path.resolve("public/vendor/voidplayer-analysis");
const create = (
  await import(
    pathToFileURL(path.join(directory, "voidplayer-analysis.js")).href
  )
).default;
const core = await create({
  wasmBinary: readFileSync(path.join(directory, "voidplayer-analysis.wasm")),
});
validateQualityCore(core);
const fixtures = Object.fromEntries(
  ["vmaf", "cambi"].map((metric) => [
    metric,
    JSON.parse(
      readFileSync(`test/helpers/native-${metric}-samples.json`, "utf8"),
    ).samples,
  ]),
);
const oracle = JSON.parse(
  readFileSync("test/helpers/analysis-quality-oracle.json", "utf8"),
);
const hash = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
for(const depth of [8,10] as const)test(`CAMBI independently pooled prefix ${depth}-bit retains the official score and maps`,()=>{
 const sampleIndex=fixtures.cambi.findIndex((s:any)=>s.depth===depth&&s.pattern==='banded'),s=fixtures.cambi[sampleIndex];
 const expected=oracle.cases.find((c:any)=>c.metric==='cambi'&&!c.fixture&&c.sampleIndex===sampleIndex);
 assert.ok(expected);assert.ok(expected.frames.every((n:number)=>n===expected.frames[0]),'static fixture has identical official frame scores');
 const raw=gunzipSync(Buffer.from(s.rawGzip,'base64')),bytes=s.width*s.height*3/2*(depth===8?1:2);
 const scorer=new AnalysisScorer(core,{metrics:['cambi'],frames:s.frames});
 try{
  const f=frame(raw.subarray(0,bytes),s.width,s.height,depth);scorer.feed(f,f,{x:0,y:0,width:s.width,height:s.height},0);
  assert.throws(()=>scorer.finish(),/Incomplete/);
  const prefix=scorer.finish({allowPartialCambi:true}).cambi!;assert.equal(prefix.frames.length,1);
  for(const key of ['min','max','mean','harmonic_mean'] as const)assert.ok(Math.abs(prefix.pooled[key]-expected.pooled[key])<=oracle.cambiTolerance);
  for(const map of scorer.heatmaps(0))assert.equal(hash(map.bytes),expected.heatmaps[map.scale].frames[0]);
 }finally{scorer.close();}
});
function frame(raw: Uint8Array, width: number, height: number, depth: 8 | 10) {
  let offset = 0;
  const planes = Array.from({ length: 3 }, (_, i) => {
    const w = width / (i ? 2 : 1),
      h = height / (i ? 2 : 1),
      stride = w * (depth === 8 ? 1 : 2);
    const plane = { offset, stride, width: w, height: h };
    offset += stride * h;
    return plane;
  });
  return {
    pixels: raw,
    description: rgbaDescription(width, height, {
      format: "YUV",
      stride: null,
      byteLength: raw.length,
      color: {
        primaries: "bt709",
        transfer: "bt709",
        matrix: "bt709",
        fullRange: false,
      },
      yuv: {
        bitDepth: depth,
        bitShift: 0,
        subsampleX: 1,
        subsampleY: 1,
        semiplanar: false,
        chromaLocation: 1,
        planes,
      },
    }),
  };
}
for (const expected of oracle.cases)
  test(`analysis core official ${expected.metric} ${expected.fixture ?? "raw"} ${expected.sampleIndex} ${expected.model ?? ""} ${expected.same ? "identical" : "distorted"} ${expected.roi ? "ROI" : "full"}`, () => {
    const s = (expected.fixture ? JSON.parse(readFileSync(`test/helpers/${expected.fixture}`, "utf8")).samples : fixtures[expected.metric])[expected.sampleIndex],
      { width, height, depth } = s;
    const reference = gunzipSync(
      Buffer.from(
        (expected.metric === "cambi" ? s : s.reference).rawGzip,
        "base64",
      ),
    );
    const distorted = gunzipSync(
      Buffer.from(
        (expected.metric === "cambi" ? s : expected.same ? s.reference : s.distorted).rawGzip,
        "base64",
      ),
    );
    assert.equal(
      hash(reference),
      (expected.metric === "cambi" ? s : s.reference).rawSha256,
    );
    assert.equal(
      hash(distorted),
      (expected.metric === "cambi" ? s : expected.same ? s.reference : s.distorted).rawSha256,
    );
    const scorer = new AnalysisScorer(core, {
      metrics: [expected.metric],
      frames: s.frames,
      model: expected.model
        ?.replace("vmaf_v0.", "vmaf_v0_")
        .replace(".1", "_1"),
    });
    const bytes = ((width * height * 3) / 2) * (depth === 8 ? 1 : 2);
    try {
      for (let i = 0; i < s.frames; i++) {
        scorer.feed(
          frame(
            reference.subarray(i * bytes, (i + 1) * bytes),
            width,
            height,
            depth,
          ),
          frame(
            distorted.subarray(i * bytes, (i + 1) * bytes),
            width,
            height,
            depth,
          ),
          expected.roi ?? { x: 0, y: 0, width, height },
          i,
        );
        if (expected.metric === "cambi")
          for (const map of scorer.heatmaps(i))
            assert.equal(
              hash(map.bytes),
              expected.heatmaps[map.scale].frames[i],
              `frame ${i}, scale ${map.scale}`,
            );
      }
      const actual = scorer.finish()[expected.metric as "vmaf" | "cambi"]!;
      // Different architecture/libm. Absolute score tolerance is explicit and
      // independent of each fixture; heatmaps and source pixels remain exact.
      const tolerance = expected.metric === "vmaf" ? 0.00001 : 0.000001;
      actual.frames.forEach((f, i) =>
        assert.ok(
          Math.abs(f.score - expected.frames[i]) <= tolerance,
          `${f.score} != ${expected.frames[i]}`,
        ),
      );
      for (const key of ["min", "max", "mean", "harmonic_mean"] as const)
        assert.ok(
          Math.abs(actual.pooled[key] - expected.pooled[key]) <= tolerance,
          key,
        );
    } finally {
      scorer.close();
    }
  });
test("analysis scorer keeps one temporal context for 4096 frames, rejects incomplete/order changes and releases repeated clips", () => {
  const width = 128,
    height = 96,
    pixels = new Uint8Array((width * height * 3) / 2).fill(128),
    f = frame(pixels, width, height, 8),
    roi = { x: 0, y: 0, width, height };
  const startHeap = core.HEAPU8.byteLength;
  for (let run = 0; run < 3; run++) {
    const scorer = new AnalysisScorer(core, {
      metrics: ["vmaf"],
      frames: 4096,
    });
    try {
      assert.throws(() => scorer.feed(f, f, roi, 1), /order/);
      for (let i = 0; i < 4096; i++) scorer.feed(f, f, roi, i);
      assert.throws(() => scorer.feed(f, f, roi, 4096), /order/);
      assert.equal(scorer.finish().vmaf!.frames.length, 4096);
      assert.ok(
        scorer.heapBytes <= startHeap + 16 * 1024 * 1024,
        "No clip-sized raw frame retention",
      );
    } finally {
      scorer.close();
      scorer.close();
    }
  }
  const incomplete = new AnalysisScorer(core, { metrics: ["vmaf"], frames: 2 });
  incomplete.feed(f, f, roi, 0);
  assert.throws(() => incomplete.finish(), /Incomplete/);
  incomplete.close();
});
