// Explicit maintenance command. Normal tests only read the committed oracle.
// RGB signatures are legacy swscale-converted fingerprints; regenerate only
// when absent. Plane fingerprints are bit-exact raw-plane regional means.
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { pixelSignature, planeSignature } from './fate-oracle.ts';
const manifest = JSON.parse(await readFile(new URL('./fate-samples.json', import.meta.url)));
const existing = JSON.parse(await readFile(new URL('./fate-reference.json', import.meta.url), 'utf8').catch(() => '{"samples":{}}'));
const reference = { generator: execFileSync('ffmpeg', ['-version'], {encoding:'utf8'}).split('\n')[0],
  method: 'ffprobe display frames; decode from start + select timestamp + one RGB24 PPM frame per PTS; 4x4 RGB regional means; bit-exact raw YUV plane regional means for 8-bit planar 420/422', samples: {} };
for (const item of manifest) {
  const path = new URL('../fixtures/fate/' + item.file, import.meta.url).pathname;
  assert.equal(createHash('sha256').update(await readFile(path)).digest('hex'), item.sha256);
  const probed = JSON.parse(execFileSync('ffprobe', ['-v','quiet','-select_streams','v:0','-show_frames','-show_entries','frame=best_effort_timestamp_time,width,height','-of','json',path], {maxBuffer:16*1024*1024})).frames;
  const pixFmt = JSON.parse(execFileSync('ffprobe', ['-v','quiet','-select_streams','v:0','-show_entries','stream=pix_fmt','-of','json',path])).streams[0]?.pix_fmt;
  const subsampling = { yuv420p: [1, 1], yuvj420p: [1, 1], yuv422p: [1, 0] }[pixFmt];
  const first = Math.round(Number(probed[0].best_effort_timestamp_time) * 1e6);
  const frames = [];
  for (const [index, f] of probed.entries()) {
    const ptsUs = Math.round(Number(f.best_effort_timestamp_time) * 1e6) - first;
    const row = { ptsUs, width:f.width, height:f.height };
    // Policy-rejected malformed FLV and unsupported raw HEVC remain geometry-only references.
    if (!/test-4867|paramchange/.test(item.file)) {
      const prior = existing.samples[item.path]?.frames[index];
      if (prior?.signature && prior.width === f.width && prior.height === f.height) row.signature = prior.signature;
      else {
        const ppm = execFileSync('ffmpeg', ['-v','fatal','-i',path,'-vf',`select=gte(t\\,${ptsUs/1e6-0.0000001}),scale=${f.width}:${f.height}`,'-fps_mode','passthrough','-frames:v','1','-c:v','ppm','-f','image2pipe','pipe:1'], {maxBuffer:64*1024*1024});
        let offset=0;const line=()=>{const end=ppm.indexOf(10,offset),text=ppm.subarray(offset,end).toString();offset=end+1;return text;};
        assert.equal(line(),'P6', `${item.file} at ${ptsUs}`);const [w,h]=line().split(' ').map(Number);assert.equal(line(),'255');
        assert.deepEqual([w,h],[f.width,f.height], `${item.file} at ${ptsUs}`);
        assert.equal(ppm.length-offset,w*h*3);
        row.signature=pixelSignature(ppm.subarray(offset),w,h,3);
      }
      if (subsampling) {
        const [sx, sy] = subsampling;
        const raw = execFileSync('ffmpeg', ['-v','fatal','-i',path,'-vf',`select=gte(t\\,${ptsUs/1e6-0.0000001})`,'-fps_mode','passthrough','-frames:v','1','-f','rawvideo','-pix_fmt',pixFmt==='yuvj420p'?'yuv420p':pixFmt,'pipe:1'], {maxBuffer:64*1024*1024});
        const cw = Math.ceil(f.width / 2 ** sx), ch = Math.ceil(f.height / 2 ** sy);
        // Broken-SPS samples can decode at dimensions different from what
        // ffprobe reports; those frames keep the RGB-only reference.
        if (raw.length === f.width * f.height + 2 * cw * ch) {
          row.planeSignature = planeSignature(raw, { bitDepth: 8, semiplanar: false, planes: [
            { offset: 0, stride: f.width, width: f.width, height: f.height },
            { offset: f.width * f.height, stride: cw, width: cw, height: ch },
            { offset: f.width * f.height + cw * ch, stride: cw, width: cw, height: ch }] });
        }
      }
    }
    frames.push(row);
  }
  reference.samples[item.path] = { sha256:item.sha256, firstPtsUs:first, frames };
  console.log(item.path,frames.length);
}
await writeFile(new URL('./fate-reference.json',import.meta.url),JSON.stringify(reference)+'\n');
