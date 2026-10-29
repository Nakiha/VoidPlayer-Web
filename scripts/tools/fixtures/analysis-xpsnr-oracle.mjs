/** Maintainer-only: independent pinned upstream CLI, never product scores. */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  XPSNR_SOURCE_REVISION,
  XPSNR_FILTER_SHA256,
} from "../../../shared/analysis/quality/xpsnr.ts";
const source = path.resolve(
    process.argv[2] ?? ".run/quality-convergence/xpsnr-oracle-source",
  ),
  binary = path.join(source, "ffmpeg");
const sha = (b) => createHash("sha256").update(b).digest("hex");
if (
  execFileSync("git", ["-C", source, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim() !== XPSNR_SOURCE_REVISION ||
  execFileSync("git", ["-C", source, "diff", "HEAD"], { encoding: "utf8" }) ||
  sha(readFileSync(path.join(source, "libavfilter/vf_xpsnr.c"))) !==
    XPSNR_FILTER_SHA256
)
  throw Error("Expected clean pinned official XPSNR source");
const cases = [],
  dir = mkdtempSync(path.join(tmpdir(), "vp-xpsnr-oracle-"));
const samples = JSON.parse(
  readFileSync("test/helpers/native-vmaf-samples.json"),
).samples;
const crop = (raw, s, roi) => {
  if (!roi) return raw;
  const rows = [],
    unit = s.depth === 8 ? 1 : 2,
    frameBytes = ((s.width * s.height * 3) / 2) * unit;
  for (let f = 0; f < s.frames; f++) {
    let offset = f * frameBytes;
    for (let plane = 0; plane < 3; plane++) {
      const div = plane ? 2 : 1,
        stride = (s.width / div) * unit;
      for (let y = 0; y < roi.height / div; y++) {
        const at = offset + (roi.y / div + y) * stride + (roi.x / div) * unit;
        rows.push(raw.subarray(at, at + (roi.width / div) * unit));
      }
      offset += (stride * s.height) / div;
    }
  }
  return Buffer.concat(rows);
};
function run(
  s,
  ref,
  dist,
  rate = { ticks: 250000, timescale: 1000000 },
  roi = null,
) {
  const reference = crop(ref, s, roi),
    distorted = crop(dist, s, roi),
    referenceSha256 = sha(reference),
    distortedSha256 = sha(distorted);
  if (
    cases.some(
      (c) =>
        c.referenceSha256 === referenceSha256 &&
        c.distortedSha256 === distortedSha256 &&
        JSON.stringify(c.rate) === JSON.stringify(rate),
    )
  )
    return;
  writeFileSync(path.join(dir, "reference.yuv"), reference);
  writeFileSync(path.join(dir, "distorted.yuv"), distorted);
  const args = [
    "-hide_banner",
    "-nostdin",
    "-loglevel",
    "info",
    "-cpuflags",
    "0",
    "-filter_complex_threads",
    "1",
  ];
  for (const name of ["reference", "distorted"])
    args.push(
      "-threads",
      "1",
      "-f",
      "rawvideo",
      "-pixel_format",
      s.depth === 8 ? "yuv420p" : "yuv420p10le",
      "-video_size",
      `${roi?.width ?? s.width}x${roi?.height ?? s.height}`,
      "-framerate",
      `${rate.timescale}/${rate.ticks}`,
      "-i",
      name + ".yuv",
    );
  args.push(
    "-filter_complex",
    "[0:v][1:v]xpsnr=stats_file=oracle.txt:shortest=1:repeatlast=0[out]",
    "-map",
    "[out]",
    "-threads",
    "1",
    "-f",
    "null",
    "-",
  );
  execFileSync(binary, args, { cwd: dir, stdio: "pipe" });
  const text = readFileSync(path.join(dir, "oracle.txt"), "utf8");
  cases.push({
    codec: s.codec,
    depth: s.depth,
    frames: s.frames,
    width: roi?.width ?? s.width,
    height: roi?.height ?? s.height,
    rate,
    roi,
    referenceSha256,
    distortedSha256,
    text,
    sha256: sha(text),
  });
}
try {
  for (const s of samples) {
    const ref = gunzipSync(Buffer.from(s.reference.rawGzip, "base64")),
      dist = gunzipSync(Buffer.from(s.distorted.rawGzip, "base64"));
    for (const rate of [
      { ticks: 250000, timescale: 1000000 },
      { ticks: 1001, timescale: 30000 },
      { ticks: 1, timescale: 60 },
    ])
      for (const roi of [null, { x: 16, y: 16, width: 96, height: 64 }])
        for (const other of [ref, dist]) run(s, ref, other, rate, roi);
  }
  const variants = JSON.parse(
      readFileSync("test/helpers/native-xpsnr-variants.json"),
    ),
    base = samples.find((s) => s.codec === "h264" && s.depth === 8 && s.tagged),
    ref = gunzipSync(Buffer.from(base.reference.rawGzip, "base64"));
  if (sha(ref) !== variants.referenceRawSha256)
    throw Error("Variant reference changed");
  for (const v of variants.variants)
    run(base, ref, gunzipSync(Buffer.from(v.rawGzip, "base64")));
  const long = JSON.parse(
    readFileSync("test/helpers/analysis-quality-sequence.json"),
  ).samples;
  for (const s of long) {
    const raws = {};
    for (const side of ["reference", "distorted"]) {
      writeFileSync(
        path.join(dir, side + ".mp4"),
        Buffer.from(s[side].mp4, "base64"),
      );
      const raw = execFileSync(
        "ffmpeg",
        [
          "-v",
          "error",
          "-threads",
          "1",
          "-i",
          path.join(dir, side + ".mp4"),
          "-f",
          "rawvideo",
          "-pix_fmt",
          s.depth === 8 ? "yuv420p" : "yuv420p10le",
          "pipe:1",
        ],
        { maxBuffer: 64 * 1024 * 1024 },
      );
      if (sha(raw) !== s[side].rawSha256)
        throw Error("Decoded fixture pixels changed");
      raws[side] = raw;
    }
    for (const roi of [null, { x: 16, y: 16, width: 96, height: 64 }])
      run(s, raws.reference, raws.distorted, s.rate, roi);
  }
  writeFileSync(
    "test/helpers/analysis-xpsnr-oracle.json",
    JSON.stringify(
      {
        sourceRevision: XPSNR_SOURCE_REVISION,
        filterSha256: XPSNR_FILTER_SHA256,
        binarySha256: sha(readFileSync(binary)),
        tolerance: 0.000051,
        cases,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`Recorded ${cases.length} independent XPSNR clips`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
