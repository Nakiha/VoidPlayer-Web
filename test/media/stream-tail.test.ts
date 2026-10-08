import {createHash} from 'node:crypto';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openFFmpegMedia} from '../../src/ffmpeg-media.ts';
import {openFlvMedia} from '../../src/flv-media.ts';

const core=new URL('../../public/vendor/voidplayer-core/',import.meta.url);
for(const [kind,encoder] of [['ts','mpeg2video'],['ts','libx264'],['ts','libx265'],['flv','libx264']] as const)test(`${kind}/${encoder} damaged tails retain real decoded frames, playback and backward seek`,{timeout:60000},async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'vp-tail-'));
  try {
    const file=path.join(dir,`video.${kind}`);
    execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=160x96:rate=25','-t','2','-c:v',encoder,'-threads','1',...(encoder==='libx265'?['-x265-params','pools=none:frame-threads=1:log-level=error']:[]),'-g','12','-bf','2','-y',file]);
    const bytes=await readFile(file),deps={glueURL:new URL('voidplayer-core.js',core).href,wasmBinary:await readFile(new URL('voidplayer-core.wasm',core))};
    let gapInput:Buffer<ArrayBuffer>|undefined;
    if(kind==='flv'){
      const tags:number[]=[];for(let offset=bytes.readUInt32BE(5)+4;offset<bytes.length;offset+=15+bytes.readUIntBE(offset+1,3))tags.push(offset);
      const at=tags.at(-7)!;gapInput=Buffer.concat([bytes.subarray(0,at),Buffer.alloc(149,0xa5),bytes.subarray(at)]);
    }
    let cleanFrames:string[]|undefined;
    const largeTail = Buffer.concat([bytes, Buffer.alloc(190 * 1024, 0xa5)]);
    const inputs=kind==='ts'?[bytes,bytes.subarray(0,bytes.length-1),bytes.subarray(0,bytes.length-187),Buffer.concat([bytes,Buffer.alloc(37,0xa5)]),largeTail]
      :[bytes,bytes.subarray(0,bytes.length-1),Buffer.concat([bytes,Buffer.alloc(37,0xa5)]),gapInput!];
    let firstPixels:Uint8ClampedArray|undefined;
    for(const input of inputs){
      const f=new File([input],`video.${kind}`);
      const source=kind==='ts'?await openFFmpegMedia(f,deps):await openFlvMedia({file:f},f,{...deps,forceWasm:true});
      try{
        const first=await source.frameAt(0);
        try{firstPixels??=first.pixels!.slice();assert.deepEqual(first.pixels,firstPixels);}finally{first.close();}
        await source.ensureIndexed?.();
        let count=0,last=-1;const frames:string[]=[];
        for await(const frame of source.framesFrom(0)){try{assert.ok(frame.ptsUs>=last);last=frame.ptsUs;count++;frames.push(`${frame.ptsUs}:${createHash("sha256").update(frame.pixels!).digest("hex")}`);}finally{frame.close();}}
        if(input===bytes)cleanFrames=frames;
        if(input===gapInput) {
          assert.equal(source.info.indexIntegrity, 'recovered');
          assert.ok(frames.every(frame => cleanFrames!.includes(frame)), 'resynchronization retains only original, independently recoverable pictures');
          assert.equal(frames.at(-1), cleanFrames!.at(-1), 'the next IDR and tail remain playable');
        }
        if(input===largeTail) {
          assert.equal(source.info.indexState, 'complete');
          assert.equal(source.info.indexIntegrity, 'prefix');
          assert.match(source.info.indexWarning!, /有效前段/);
          assert.ok(source.info.indexTruncatedAt! < bytes.length);
          assert.ok(count > 0 && count < 50);
          assert.ok(frames.every(frame => cleanFrames!.includes(frame)), 'every retained reordered frame matches the undamaged decode');
          const lastFrame = await source.frameAt(source.info.durationUs - 1);
          try { assert.equal(`${lastFrame.ptsUs}:${createHash('sha256').update(lastFrame.pixels!).digest('hex')}`, frames.at(-1)); }
          finally { lastFrame.close(); }
          const analysis = await source.queryAnalysis!({ requestId: 1, startUs: 0, endUs: source.info.durationUs, axis: 'pts', pixelWidth: 100, bitrateWindowUs: 1000000 });
          assert.equal(analysis.coverageUs, null);
          assert.match(analysis.capability.note!, /有效前段/);
        } else assert.ok(count>=45,`retained ${count}/50 frames`);
        const sought=await source.frameAt(0);try{assert.deepEqual(sought.pixels,firstPixels);}finally{sought.close();}
        if(kind==='flv'&&input!==bytes)assert.match(source.info.indexWarning!,input===gapInput?/重同步/:/尾部/);
      }finally{source.dispose();}
    }
  }finally{await rm(dir,{recursive:true,force:true});}
});

for (const [kind, encoder] of [['mkv', 'ffv1'], ['webm', 'libvpx-vp9'], ['avi', 'mpeg4'], ['mpg', 'mpeg2video']] as const)
test(`${kind} shares corruption policy without losing readable frames to an appended tail`, { timeout: 60000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'vp-container-tail-'));
  const deps = { glueURL: new URL('voidplayer-core.js', core).href, wasmBinary: await readFile(new URL('voidplayer-core.wasm', core)) };
  try {
    const file = path.join(dir, `video.${kind}`);
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x96:rate=25', '-t', '2',
      '-c:v', encoder, '-threads', '1', '-g', '12', '-y', file]);
    const bytes = await readFile(file);
    const original = await openFFmpegMedia(new File([bytes], `original.${kind}`), deps);
    const expected = new Map<string, string>();
    try {
      for await (const frame of original.framesFrom(0)) {
        try { expected.set(String(frame.sourcePtsUs), createHash('sha256').update(frame.pixels!).digest('hex')); }
        finally { frame.close(); }
      }
    } finally { original.dispose(); }
    const source = await openFFmpegMedia(new File([bytes, Buffer.alloc(190 * 1024, 0xa5)], `tail.${kind}`), deps);
    try {
      await source.ensureIndexed?.();
      assert.equal(source.info.indexState, 'complete');
      let count = 0;
      for await (const frame of source.framesFrom(0)) {
        try { assert.equal(createHash('sha256').update(frame.pixels!).digest('hex'), expected.get(String(frame.sourcePtsUs))); count++; }
        finally { frame.close(); }
      }
      assert.ok(count > 0 && count <= expected.size);
      for (const time of [source.info.durationUs - 1, 0]) {
        const frame = await source.frameAt(time);
        try { assert.equal(createHash('sha256').update(frame.pixels!).digest('hex'), expected.get(String(frame.sourcePtsUs))); }
        finally { frame.close(); }
      }
    } finally { source.dispose(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
