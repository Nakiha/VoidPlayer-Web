// Explicit maintenance command. Normal tests only read the committed oracle.
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { pixelSignature } from './fate-oracle.ts';
const manifest = JSON.parse(await readFile(new URL('./fate-samples.json', import.meta.url)));
const reference = { generator: execFileSync('ffmpeg', ['-version'], {encoding:'utf8'}).split('\n')[0],
  method: 'ffprobe display frames; decode from start + select timestamp + one RGB24 PPM frame per PTS; 4x4 RGB regional means', samples: {} };
for (const item of manifest) {
  const path = new URL('../fixtures/fate/' + item.file, import.meta.url).pathname;
  assert.equal(createHash('sha256').update(await readFile(path)).digest('hex'), item.sha256);
  const probed = JSON.parse(execFileSync('ffprobe', ['-v','quiet','-select_streams','v:0','-show_frames','-show_entries','frame=best_effort_timestamp_time,width,height','-of','json',path], {maxBuffer:16*1024*1024})).frames;
  const first = Math.round(Number(probed[0].best_effort_timestamp_time) * 1e6);
  const frames = [];
  for (const f of probed) {
    const ptsUs = Math.round(Number(f.best_effort_timestamp_time) * 1e6) - first;
    const row = { ptsUs, width:f.width, height:f.height };
    // Policy-rejected malformed FLV and unsupported raw HEVC remain geometry-only references.
    if (!/test-4867|paramchange/.test(item.file)) {
      const ppm = execFileSync('ffmpeg', ['-v','fatal','-i',path,'-vf',`select=gte(t\\,${ptsUs/1e6-0.0000001}),scale=${f.width}:${f.height}`,'-fps_mode','passthrough','-frames:v','1','-c:v','ppm','-f','image2pipe','pipe:1'], {maxBuffer:64*1024*1024});
      let offset=0;const line=()=>{const end=ppm.indexOf(10,offset),text=ppm.subarray(offset,end).toString();offset=end+1;return text;};
      assert.equal(line(),'P6', `${item.file} at ${ptsUs}`);const [w,h]=line().split(' ').map(Number);assert.equal(line(),'255');
      assert.deepEqual([w,h],[f.width,f.height], `${item.file} at ${ptsUs}`);
      assert.equal(ppm.length-offset,w*h*3);
      row.signature=pixelSignature(ppm.subarray(offset),w,h,3);
    }
    frames.push(row);
  }
  reference.samples[item.path] = { sha256:item.sha256, firstPtsUs:first, frames };
  console.log(item.path,frames.length);
}
await writeFile(new URL('./fate-reference.json',import.meta.url),JSON.stringify(reference)+'\n');
