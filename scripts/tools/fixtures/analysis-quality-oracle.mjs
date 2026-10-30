import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  readdirSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import path from "node:path";
import { tmpdir } from "node:os";
const [binaryArg, sourceArg] = process.argv.slice(2);
if (!binaryArg || !sourceArg)
  throw Error(
    "Usage: node scripts/tools/fixtures/analysis-quality-oracle.mjs /path/to/official/vmaf /path/to/Netflix-vmaf-source",
  );
const binary = path.resolve(binaryArg),
  source = path.resolve(sourceArg);
if (
  execFileSync("git", ["-C", source, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim() !== "17a67b238ce0539bdeafdc95961abac64fa16ea8" ||
  execFileSync("git", ["-C", source, "diff", "HEAD"], { encoding: "utf8" })
)
  throw Error("Oracle must use clean pinned official source");
const hash = (b) => createHash("sha256").update(b).digest("hex");
const cases = [];
for (const [metric, fixture] of [["vmaf", "native-vmaf-samples.json"], ["cambi", "native-cambi-samples.json"], ["cambi", "native-cambi-mp4-samples.json"]]) {
  const { samples } = JSON.parse(
    readFileSync(`test/helpers/${fixture}`),
  );
  for (const [sampleIndex, s] of samples.entries())
    for (const model of metric === "vmaf"
      ? ["vmaf_v0.6.1", "vmaf_v0.6.1neg"]
      : [null])
      for (const same of metric === "vmaf" ? [false, true] : [false])
      for (const roi of metric === "vmaf"
        ? [null, { x: 16, y: 16, width: 96, height: 64 }]
        : [null]) {
        const dir = mkdtempSync(path.join(tmpdir(), "vp-quality-oracle-"));
        try {
          const ref = gunzipSync(
              Buffer.from(
                (metric === "cambi" ? s : s.reference).rawGzip,
                "base64",
              ),
            ),
            dist = gunzipSync(
              Buffer.from(
                (metric === "cambi" ? s : same ? s.reference : s.distorted).rawGzip,
                "base64",
              ),
            );
          const crop = (raw) => {
            if (!roi) return raw;
            const rows = [],
              bytes = s.depth === 8 ? 1 : 2,
              frameBytes = ((s.width * s.height * 3) / 2) * bytes;
            for (let frame = 0; frame < s.frames; frame++) {
              let offset = frame * frameBytes;
              for (let plane = 0; plane < 3; plane++) {
                const div = plane ? 2 : 1,
                  stride = (s.width / div) * bytes;
                for (let y = 0; y < roi.height / div; y++) {
                  const at =
                    offset + (roi.y / div + y) * stride + (roi.x / div) * bytes;
                  rows.push(raw.subarray(at, at + (roi.width / div) * bytes));
                }
                offset += (stride * s.height) / div;
              }
            }
            return Buffer.concat(rows);
          };
          const reference = crop(ref),
            distorted = crop(dist);
          writeFileSync(path.join(dir, "ref.yuv"), reference);
          writeFileSync(path.join(dir, "dist.yuv"), distorted);
          const args = [
            "--reference",
            "ref.yuv",
            "--distorted",
            "dist.yuv",
            "--width",
            String(roi?.width ?? s.width),
            "--height",
            String(roi?.height ?? s.height),
            "--pixel_format",
            "420",
            "--bitdepth",
            String(s.depth),
            "--threads",
            "1",
            "--cpumask",
            "0",
            "--json",
            "--output",
            "result.json",
            "--quiet",
          ];
          if (model) args.push("--model", `version=${model}:name=vmaf`);
          else {
            mkdirSync(path.join(dir, "heat"));
            args.push(
              "--no_prediction",
              "--feature",
              "cambi=window_size=63:topk=0.6:tvi_threshold=0.019:max_log_contrast=2:eotf=bt1886:full_ref=false:heatmaps_path=heat",
            );
          }
          execFileSync(binary, args, { cwd: dir, stdio: "pipe" });
          const result = JSON.parse(
            readFileSync(path.join(dir, "result.json")),
          );
          const maps = [];
          if (!model)
            for (const file of readdirSync(path.join(dir, "heat")).sort()) {
              const bytes = readFileSync(path.join(dir, "heat", file)),
                size = bytes.length / s.frames;
              maps.push({
                file,
                frames: Array.from({ length: s.frames }, (_, i) =>
                  hash(bytes.subarray(i * size, (i + 1) * size)),
                ),
              });
            }
          cases.push({
            metric,
            sampleIndex,
            ...(same ? { same: true } : {}),
            ...(fixture.includes("mp4") ? { fixture } : {}),
            model,
            ...(roi ? { roi } : {}),
            referenceSha256: hash(reference),
            distortedSha256: hash(distorted),
            frames: result.frames.map((f) => f.metrics[metric]),
            pooled: result.pooled_metrics[metric],
            heatmaps: maps,
          });
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
}
writeFileSync(
  "test/helpers/analysis-quality-oracle.json",
  JSON.stringify(
    {
      sourceRevision: "17a67b238ce0539bdeafdc95961abac64fa16ea8",
      platform: process.platform + "-" + process.arch,
      assembly: false,
      binarySha256: hash(readFileSync(binary)),
      vmafTolerance: 0.00001,
      cambiTolerance: 0.000001,
      heatmapComparison: "exact-gray16le-sha256",
      cases,
    },
    null,
    2,
  ) + "\n",
);
console.log(`${cases.length} official oracle cases`);
