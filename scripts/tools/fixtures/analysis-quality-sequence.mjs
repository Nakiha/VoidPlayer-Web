// Regenerate only with explicit host oracle paths. Product scoring never starts these tools.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
const [ffmpeg, vmaf] = process.argv.slice(2);
if (!ffmpeg || !vmaf)
  throw Error("Pass explicit ffmpeg and official libvmaf CLI paths");
const hash = (b) => createHash("sha256").update(b).digest("hex"),
  directory = mkdtempSync(path.join(tmpdir(), "vp-sequence-oracle-"));
const samples = [];
try {
  for (const [codec, depth] of [
    ["h264", 8],
    ["hevc", 8],
    ["hevc", 10],
  ]) {
    const width = 320,
      height = 192,
      frames = 192,
      rate = { ticks: 1001, timescale: 30000 },
      frameBytes = ((width * height * 3) / 2) * (depth === 8 ? 1 : 2),
      raw = Buffer.alloc(frameBytes * frames);
    for (let frame = 0; frame < frames; frame++)
      for (let i = 0; i < (width * height * 3) / 2; i++) {
        const value =
          i < width * height
            ? 32 + (((i % width) + Math.floor(i / width) * 3 + frame * 7) % 180)
            : 128 + ((frame + i) % 21) - 10;
        if (depth === 8) raw[frame * frameBytes + i] = value;
        else raw.writeUInt16LE(value * 4, frame * frameBytes + i * 2);
      }
    const sample = {
      codec,
      depth,
      width,
      height,
      frames,
      tagged: true,
      rate,
      gop: 64,
    };
    for (const role of ["reference", "distorted"]) {
      const file = path.join(directory, role + ".mp4"),
        pixels = depth === 8 ? "yuv420p" : "yuv420p10le";
      const params =
        "keyint=64:min-keyint=64:scenecut=0:open-gop=0:bframes=3:colorprim=bt709:transfer=bt709:colormatrix=bt709:range=limited:chromaloc=0" +
        (codec === "hevc" ? ":pools=none:frame-threads=1:log-level=error" : "");
      execFileSync(
        ffmpeg,
        [
          "-v",
          "error",
          "-y",
          "-f",
          "rawvideo",
          "-pix_fmt",
          pixels,
          "-s",
          `${width}x${height}`,
          "-r",
          "30000/1001",
          "-i",
          "pipe:0",
          "-an",
          "-c:v",
          codec === "h264" ? "libx264" : "libx265",
          "-threads",
          "1",
          "-preset",
          "medium",
          "-qp",
          role === "reference" ? "18" : "34",
          codec === "h264" ? "-x264-params" : "-x265-params",
          params,
          "-vf",
          "setsar=1/1,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=limited",
          "-color_primaries",
          "bt709",
          "-color_trc",
          "bt709",
          "-colorspace",
          "bt709",
          "-color_range",
          "tv",
          "-tag:v",
          codec === "h264" ? "avc1" : "hvc1",
          "-use_editlist",
          "0",
          "-movflags",
          "+faststart+write_colr",
          "-video_track_timescale",
          "30000",
          file,
        ],
        { input: raw, maxBuffer: 64 * 1024 * 1024 },
      );
      const decoded = execFileSync(
        ffmpeg,
        [
          "-v",
          "error",
          "-i",
          file,
          "-pix_fmt",
          pixels,
          "-fps_mode",
          "passthrough",
          "-f",
          "rawvideo",
          "pipe:1",
        ],
        { maxBuffer: 64 * 1024 * 1024 },
      );
      if (decoded.length !== frameBytes * frames)
        throw Error("Native oracle changed frame count");
      writeFileSync(path.join(directory, role + ".yuv"), decoded);
      const encoded = readFileSync(file);
      sample[role] = {
        mp4: encoded.toString("base64"),
        mp4Sha256: hash(encoded),
        rawSha256: hash(decoded),
        rawFrames: Array.from({ length: frames }, (_, i) =>
          hash(decoded.subarray(i * frameBytes, (i + 1) * frameBytes)),
        ),
      };
    }
    execFileSync(
      vmaf,
      [
        "--reference",
        "reference.yuv",
        "--distorted",
        "distorted.yuv",
        "--width",
        String(width),
        "--height",
        String(height),
        "--pixel_format",
        "420",
        "--bitdepth",
        String(depth),
        "--threads",
        "1",
        "--cpumask",
        "0",
        "--model",
        "version=vmaf_v0.6.1:name=vmaf",
        "--json",
        "--output",
        "vmaf.json",
        "--quiet",
      ],
      { cwd: directory, stdio: "pipe" },
    );
    const result = JSON.parse(readFileSync(path.join(directory, "vmaf.json")));
    sample.vmaf = {
      frames: result.frames.map((f) => f.metrics.vmaf),
      pooled: result.pooled_metrics.vmaf,
    };
    const heatDirectory=path.join(directory,'heat');mkdirSync(heatDirectory,{recursive:true});
    execFileSync(vmaf,['--reference','distorted.yuv','--distorted','distorted.yuv','--width',String(width),'--height',String(height),'--pixel_format','420','--bitdepth',String(depth),'--threads','1','--cpumask','0','--no_prediction','--feature','cambi=window_size=63:topk=0.6:tvi_threshold=0.019:max_log_contrast=2:eotf=bt1886:full_ref=false:heatmaps_path=heat','--json','--output','cambi.json','--quiet'],{cwd:directory,stdio:'pipe'});
    const cambi=JSON.parse(readFileSync(path.join(directory,'cambi.json')));
    sample.cambi={frames:cambi.frames.map(f=>f.metrics.cambi),pooled:cambi.pooled_metrics.cambi,heatmaps:readdirSync(heatDirectory).sort().map(file=>{const scale=Number(/scale_(\d+)_/.exec(file)[1]),data=readFileSync(path.join(heatDirectory,file)),bytes=data.length/frames;if(!Number.isSafeInteger(bytes))throw Error('Official heatmap length');return {scale,bytes,frames:Array.from({length:frames},(_,i)=>hash(data.subarray(i*bytes,(i+1)*bytes)))};})};
    rmSync(heatDirectory,{recursive:true});
    samples.push(sample);
  }
  writeFileSync(
    "test/helpers/analysis-quality-sequence.json",
    JSON.stringify(
      {
        generator: {
          ffmpeg: execFileSync(ffmpeg, ["-version"], {
            encoding: "utf8",
          }).split("\n")[0],
          vmafBinarySha256: hash(readFileSync(vmaf)),
          vmafRevision: "17a67b238ce0539bdeafdc95961abac64fa16ea8",
        },
        samples,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`${samples.length} long reordered sequence fixtures`);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
