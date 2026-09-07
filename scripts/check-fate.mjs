// Targeted player integration audit, not a replacement for FFmpeg's FATE suite.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { openFlvMedia } from '../src/flv-media.ts';
import { openFFmpegMedia } from '../src/ffmpeg-media.ts';
import { openPacketMedia } from '../src/packet-media.ts';
const manifest = JSON.parse(await readFile(new URL('./fate-samples.json', import.meta.url)));
const report = [];
for (const item of manifest) {
  const path = new URL('../fixtures/fate/' + item.file, import.meta.url);
  const bytes = await readFile(path);
  if (createHash('sha256').update(bytes).digest('hex') !== item.sha256) throw new Error('FATE sample checksum mismatch: '+item.file);
  const reference = JSON.parse(execFileSync('ffprobe', ['-v','quiet','-select_streams','v:0','-show_frames','-show_entries','frame=best_effort_timestamp_time,width,height,pix_fmt','-of','json',path.pathname], {maxBuffer:16*1024*1024,timeout:30000}));
  for (const backend of ['container-single', 'container-multi', ...(item.file.endsWith('.flv') ? ['flv-packets'] : /\.(mp4|mov)$/.test(item.file) ? ['mp4-packets'] : [])]) {
    const file = new File([bytes], item.file), variant = backend.endsWith('multi') ? '-mt' : '';
    const deps = {glueURL: new URL(`../public/vendor/voidplayer-core/voidplayer-core${variant}.js`,import.meta.url).href,
      wasmBinary:await readFile(new URL(`../public/vendor/voidplayer-core/voidplayer-core${variant}.wasm`,import.meta.url)),forceWasm:true};
    const row = {sample:item.path,backend,referenceFrames:reference.frames?.length,referenceGeometry:[...new Set(reference.frames?.map(f=>`${f.width}x${f.height}:${f.pix_fmt}`))],frames:0,geometry:[],geometryMismatches:[],seeks:[],phase:'open'};
    let source;
    try {
      source = await (backend==='flv-packets' ? openFlvMedia({file},file,deps) : backend==='mp4-packets' ? openPacketMedia('mp4',{file},file,deps) : openFFmpegMedia(file,deps));
      row.info=structuredClone(source.info); row.phase='first'; (await source.frameAt(0)).close();
      row.phase='index'; await source.ensureIndexed?.(); row.durationUs=source.info.durationUs;
      row.phase='play';
      for await(const frame of source.framesFrom(0)) {
        const expected=reference.frames?.[row.frames];
        if(expected && (expected.width!==frame.width || expected.height!==frame.height) && row.geometryMismatches.length<8) row.geometryMismatches.push({frame:row.frames,expected:[expected.width,expected.height],actual:[frame.width,frame.height],bytes:frame.pixels?.byteLength});
        row.frames++; const size=`${frame.width}x${frame.height}`;if(!row.geometry.includes(size))row.geometry.push(size);frame.close(); if(row.frames>2000)throw new Error('audit frame limit');
      }
      row.phase='seek';
      for(const time of [0,Math.floor(source.info.durationUs/2),Math.max(0,source.info.durationUs-1),0]) {const f=await source.frameAt(time);row.seeks.push({requested:time,actual:f.ptsUs});f.close();}
      row.phase='complete';
    } catch(e) {row.error={message:e.message,stage:e.stage};}
    finally {source?.dispose();}
    row.passed = row.phase==='complete' && row.frames===row.referenceFrames && !row.geometryMismatches.length;
    report.push(row); console.log(JSON.stringify(row));
  }
}
await mkdir('.run/playback-reports',{recursive:true}); await writeFile('.run/playback-reports/fate-report.json',JSON.stringify(report,null,2)+'\n');
console.log(`FATE integration audit: ${report.filter(r=>r.passed).length}/${report.length} passed; failures are recorded, not release gates.`);
