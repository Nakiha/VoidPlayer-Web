import { packetFixture } from '../packet-fixture.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { visiblePixelHash } from '../helpers/visible-pixels.ts';
import {fileURLToPath} from 'node:url';
import { Mp4Engine } from '../../src/media/decoding/mp4-engine.ts';
import {nativeFrames,nativeVisibleHash,nativeVisibleFrameBytes,nativeVideoMetadata,nativeSeekFrame} from '../helpers/media/native-pixels.ts';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const core = new URL('../../public/vendor/voidplayer-core', import.meta.url);

for (const name of ['h266_10s_1920x1080.mp4', 'h264_high422p_1s_320x180.mp4', 'hevc-packet-1080p.mp4']) {
  test(`MP4 packet WASM ${name}: metadata-only indexing and exact pixels across GOP seeks and EOF`, { timeout: 120000 }, async () => {
    const bytes = await packetFixture(name);
    let readBytes = 0;
    class ChunkBlob extends Blob {
      override arrayBuffer(): Promise<ArrayBuffer> { throw new Error('whole-file materialization forbidden'); }
      override slice(start = 0, end = this.size) { readBytes += Math.min(end, this.size) - start; assert.ok(end - start <= 256 * 1024); return super.slice(start, end); }
    }
    const engine = new Mp4Engine({ file: new ChunkBlob([bytes]) });
    const deps = { glueURL: new URL('voidplayer-core.js', core).href, wasmBinary: await readFile(new URL('voidplayer-core.wasm', core)) };
    const directory=await mkdtemp(join(tmpdir(),'vp-mp4-oracle-')),file=join(directory,name);await writeFile(file,bytes);
    try {
      const init = await engine.open(deps.glueURL, deps.wasmBinary);
      const probe=nativeVideoMetadata(file);assert.equal(init.codec,probe.codec_name);assert.equal(init.pixelFormat,probe.pix_fmt);
      const positions=[0,1,2,Math.floor(init.times.length*.6),0,init.times.length-1],first=await engine.extract(0),native=nativeFrames(file,positions,first.description.sourcePixelFormat!,nativeVisibleFrameBytes(first.description));first.frame?.close();
      if (name.startsWith('h266')) assert.ok(readBytes < bytes.length / 2, `initial read ${readBytes}/${bytes.length}`);
      for (const position of positions) {
        const actual = await engine.extract(position);
        assert.equal(actual.pts, init.firstPtsUs + init.times[position]);
        assert.equal(visiblePixelHash(actual.description, actual.pixels!), nativeVisibleHash(actual.description,native.get(position)!),`frame ${position}`);actual.frame?.close();
      }
    } finally { engine.close(); await rm(directory,{recursive:true,force:true}); }
  });
}

test('MP4 packet worker shares the session frame contract, handles EOF and releases pending work', async () => {
  const { openPacketMedia } = await import('../../src/media/decoding/packet-media.ts');
  const bytes = await readFile(new URL('../../fixtures/video/h264_high422p_1s_320x180.mp4', import.meta.url));
  const source = await openPacketMedia('mp4', { file: new Blob([bytes]) }, { name: 'high422.mp4', size: bytes.length, lastModified: 0 }, {
    glueURL: new URL('voidplayer-core.js', core).href, wasmBinary: await readFile(new URL('voidplayer-core.wasm', core)),
  });
  try {
    const first = await source.frameAt(0); assert.equal(first.kind, 'yuv'); first.close();
    const frames = await source.framesAfter(0, 2); assert.equal(frames.length, 2); frames.forEach(f => f.close());
    assert.deepEqual(await source.framesAfter(source.info.durationUs, 2), []);
    source.dispose(); await assert.rejects(source.frameAt(0), /释放/);
  } finally { source.dispose(); }
});

for(const codec of ['h264','hevc'] as const)test(`multi-stsd ${codec} preserves every configuration and native-reference plane through packet software decoding`,async t=>{
  const file=fileURLToPath(new URL(`../../fixtures/fate/${codec}--extradata-reload-multi-stsd.mov`,import.meta.url)),bytes=await readFile(file);
  const probed:VideoDecoderConfig[]=[];
  // Track-level metadata must not select a native decoder for multi-stsd.
  // Every output below comes from the real compiled packet WASM decoder.
  const previous=Object.getOwnPropertyDescriptor(globalThis,'VideoDecoder');
  Object.defineProperty(globalThis,'VideoDecoder',{configurable:true,value:class{
    static async isConfigSupported(config:VideoDecoderConfig){probed.push(config);return {supported:false,config};}
  }});
  t.after(()=>{if(previous)Object.defineProperty(globalThis,'VideoDecoder',previous);else Reflect.deleteProperty(globalThis,'VideoDecoder');});
  const engine=new Mp4Engine({file:new Blob([bytes])});
  try{
    const info=await engine.open(new URL('voidplayer-core.js',core).href,await readFile(new URL('voidplayer-core.wasm',core)),false);
    assert.deepEqual(probed,[],'multi-stsd retains the verified software route before any misleading track-level native config');
    assert.equal(info.decoder,'ffmpeg-wasm');
    assert.deepEqual(engine.analysisIndex!.packets.map(packet=>packet.configuration),[0,0,1,1]);
    assert.equal(info.firstPtsUs,0);assert.deepEqual(info.times,[0,40000,80000,120000]);
    for(const position of [0,1,2,3,0]){const frame=await engine.extract(position);try{
      const native=nativeSeekFrame(file,position*40000,frame.description.sourcePixelFormat!,nativeVisibleFrameBytes(frame.description));
      assert.equal(visiblePixelHash(frame.description,frame.pixels!),nativeVisibleHash(frame.description,native),'every actual visible plane matches native decode across the configuration boundary');
      assert.equal(frame.pts,position*40000);assert.equal(frame.width,codec==='h264'&&position<2?256:128);assert.equal(frame.height,codec==='hevc'&&position>=2?256:128);
    }finally{frame.frame?.close();}}
  }finally{engine.close();}
});
