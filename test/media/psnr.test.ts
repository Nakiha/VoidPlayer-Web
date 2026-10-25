import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { measurePsnr } from '../../shared/analysis/quality/psnr.ts';
import type { PsnrFrame } from '../../shared/analysis/quality/psnr.ts';
import { rgbaDescription } from '../../shared/media/frame-description.ts';

const ffmpeg = (args: string[]) => execFileSync('ffmpeg', ['-hide_banner', '-nostdin', ...args], { encoding: 'utf8', timeout: 30000, stdio: 'pipe' });
const width = 32, height = 24;
function decodedFrame(pixels: Uint8Array, depth: 8 | 10): PsnrFrame {
  const bytes = depth === 8 ? 1 : 2;
  return { pixels, description: rgbaDescription(width, height, { format: 'YUV', stride: null, byteLength: pixels.byteLength,
    color: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false },
    yuv: { bitDepth: depth, bitShift: 0, subsampleX: 1, subsampleY: 1, semiplanar: false, chromaLocation: 1,
      planes: [{ offset: 0, stride: width * bytes, width, height },
        { offset: width * height * bytes, stride: width / 2 * bytes, width: width / 2, height: height / 2 },
        { offset: width * height * 5 / 4 * bytes, stride: width / 2 * bytes, width: width / 2, height: height / 2 }] } }) };
}

for (const depth of [8, 10] as const) test(`generated decoded ${depth}-bit YUV420 full/ROI PSNR matches independent FFmpeg`, { timeout: 90000 }, async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'vp-psnr-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  t.diagnostic(ffmpeg(['-version']).split('\n')[0]);
  const format = depth === 8 ? 'yuv420p' : 'yuv420p10le', encodedFile = path.join(dir, 'source.mkv');
  const referenceFile = path.join(dir, 'reference.yuv'), distortedFile = path.join(dir, 'distorted.yuv');
  ffmpeg(['-v', 'error', '-f', 'lavfi', '-i', `testsrc2=size=${width}x${height}:rate=1`, '-frames:v', '1',
    '-filter_threads', '1', '-pix_fmt', format, '-c:v', 'ffv1', '-level', '3', '-color_primaries', 'bt709', '-color_trc', 'bt709',
    '-colorspace', 'bt709', '-color_range', 'tv', '-chroma_sample_location', 'left', encodedFile]);
  ffmpeg(['-v', 'error', '-i', encodedFile, '-frames:v', '1', '-pix_fmt', format, '-f', 'rawvideo', referenceFile]);
  const reference = new Uint8Array(await readFile(referenceFile)), distorted = reference.slice(), bytes = depth === 8 ? 1 : 2;
  assert.equal(reference.byteLength, width * height * 3 / 2 * bytes);
  // Perturb actual decoded code words; never convert through RGB or round 10-bit to 8-bit.
  for (let i = 0; i < distorted.length; i += bytes) {
    const value = reference[i] + (bytes === 2 ? reference[i + 1] * 256 : 0);
    const delta = 1 + (i / bytes % 7), peak = depth === 8 ? 255 : 1023, changed = value > peak - delta ? value - delta : value + delta;
    distorted[i] = changed & 255; if (bytes === 2) distorted[i + 1] = changed >> 8;
  }
  await writeFile(distortedFile, distorted);
  for (const roi of [{ x: 0, y: 0, width, height }, { x: 2, y: 4, width: 24, height: 16 }]) {
    const whole = measurePsnr({ domain: 'source-yuv-code-values', reference: decodedFrame(reference, depth), distorted: decodedFrame(distorted, depth), roi, spatial:{blockWidth:14,blockHeight:10} });
    for(const actual of [whole,...whole.spatial!.blocks]) {
    const roi=actual.roi;
    const input = (file: string) => ['-f', 'rawvideo', '-pixel_format', format, '-video_size', `${width}x${height}`, '-framerate', '1', '-i', file];
    const crop = `crop=${roi.width}:${roi.height}:${roi.x}:${roi.y}`;
    // execFileSync returns stdout; FFmpeg's machine-readable stats use stdout explicitly.
    const output = ffmpeg(['-v', 'error', ...input(referenceFile), ...input(distortedFile), '-filter_complex_threads', '1',
      '-filter_complex', `[0:v]${crop}[a];[1:v]${crop}[b];[a][b]psnr=stats_file=-:stats_version=2:output_max=1`, '-frames:v', '1', '-f', 'null', '-']);
    const stats = new Map([...output.matchAll(/([a-z_]+):([0-9.]+)/g)].map(m => [m[1], Number(m[2])]));
    assert.equal(stats.get('max_avg'), whole.peak);
    for (const [key, value] of Object.entries({ y: actual.planes.y, u: actual.planes.u, v: actual.planes.v, avg: actual.aggregate })) {
      assert.equal(value.psnr.kind, 'finite');
      assert.ok(Math.abs(stats.get(`mse_${key}`)! - value.mse) <= 0.00501, `${depth}-bit ${key} MSE: ${output}`);
      assert.ok(Math.abs(stats.get(`psnr_${key}`)! - value.psnr.db!) <= 0.00501, `${depth}-bit ${key} PSNR: ${output}`);
    }
    t.diagnostic(JSON.stringify({ depth, roi, sse: actual.aggregate.sse, samples: actual.aggregate.samples, psnr: actual.aggregate.psnr, ffmpeg: Object.fromEntries(stats) }));
    }
  }
});
