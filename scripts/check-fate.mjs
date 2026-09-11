import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { openFlvMedia } from '../src/flv-media.ts';
import { openFFmpegMedia } from '../src/ffmpeg-media.ts';
import { openPacketMedia } from '../src/packet-media.ts';
import { pixelSignature, planeSignature, checkFrame, checkSequence, expectedAt, classify } from './fate-oracle.ts';
import { yuvToRgba } from '../src/yuv-color.ts';
const manifest = JSON.parse(await readFile(new URL('./fate-samples.json', import.meta.url)));
const reference = JSON.parse(await readFile(new URL('./fate-reference.json', import.meta.url)));
const expectations = JSON.parse(await readFile(new URL('./fate-expectations.json', import.meta.url)));
const report = [];
for (const item of manifest) {
  const bytes = await readFile(new URL('../fixtures/fate/' + item.file, import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), item.sha256);
  const ref=reference.samples[item.path];assert.equal(ref.sha256,item.sha256);
  for (const backend of ['container-single', 'container-multi', ...(item.file.endsWith('.flv') ? ['flv-packets'] : /\.(mp4|mov)$/.test(item.file) ? ['mp4-packets'] : [])]) {
    const file = new File([bytes], item.file), variant = backend.endsWith('multi') ? '-mt' : '';
    const deps = {glueURL: new URL(`../public/vendor/voidplayer-core/voidplayer-core${variant}.js`,import.meta.url).href,
      wasmBinary:await readFile(new URL(`../public/vendor/voidplayer-core/voidplayer-core${variant}.wasm`,import.meta.url)),forceWasm:true};
    const row = {sample:item.path,backend,referenceFrames:ref.frames.length,frames:[],seeks:[],failures:[],phase:'open'};
    // ABI v2 delivers raw YUV planes; fingerprint 8-bit planar frames directly
    // (bit-exact decode gate) alongside the shared CPU reference RGB conversion
    // for frames whose reference predates plane fingerprints.
    const observe = frame => {
      const layout = frame.description?.yuv;
      const yuv = frame.kind === 'yuv' && frame.pixels ? frame : null;
      const planes = yuv && layout && layout.bitDepth === 8 && !layout.semiplanar ? planeSignature(yuv.pixels, layout) : undefined;
      const pixels = yuv ? yuvToRgba(frame.description, yuv.pixels) : frame.pixels;
      return { ptsUs: frame.ptsUs, width: frame.width, height: frame.height, planeSignature: planes,
        bytes: pixels?.byteLength, signature: pixels && pixelSignature(pixels, frame.width, frame.height) };
    };
    let source;
    try {
      source = await (backend==='flv-packets' ? openFlvMedia({file},file,deps) : backend==='mp4-packets' ? openPacketMedia('mp4',{file},file,deps) : openFFmpegMedia(file,deps));
      row.info=structuredClone(source.info); row.phase='first';
      const first=await source.frameAt(0);try{row.failures.push(...checkFrame(observe(first),ref.frames[0],'first'));}finally{first.close();}
      row.phase='index'; await source.ensureIndexed?.();row.phase='play';
      for await(const frame of source.framesFrom(0)) {
        try{row.frames.push(observe(frame));}finally{frame.close();}
        if(row.frames.length>2000)throw new Error('audit frame limit');
      }
      row.failures.push(...checkSequence(row.frames,ref.frames));
      row.phase='seek';
      for(const time of [0,Math.floor(source.info.durationUs/2),Math.max(0,source.info.durationUs-1),0]) {
        const f=await source.frameAt(time);try{const actual=observe(f);row.seeks.push({requested:time,...actual});row.failures.push(...checkFrame(actual,expectedAt(ref.frames,time),`seek ${time}`));}finally{f.close();}
      }
      row.phase='complete';
    } catch(e) {row.error={message:e.message,stage:e.stage};row.failures.push({code:`${row.phase}:${e.stage??'decode'}`,detail:e.message});}
    finally {source?.dispose();}
    row.status=classify(row.failures,expectations.node[item.path]?.[backend]??{});
    report.push(row);console.log(JSON.stringify({sample:row.sample,backend,status:row.status,frames:row.frames.length,failures:row.failures}));
  }
}
await mkdir('.run/playback-reports',{recursive:true});await writeFile('.run/playback-reports/fate-report.json',JSON.stringify({referenceGenerator:reference.generator,report},null,2)+'\n');
console.log('FATE integration:',Object.fromEntries(['pass','expected-rejection','known-failure','fail'].map(s=>[s,report.filter(r=>r.status===s).length])));
if(report.some(r=>r.status==='fail') && !process.argv.includes('--report-only'))process.exitCode=1;
