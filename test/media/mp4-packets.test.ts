import '../helpers/browser-worker-host.ts';
import { packetFixture } from '../packet-fixture.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { visiblePixelHash } from '../helpers/visible-pixels.ts';
import {fileURLToPath} from 'node:url';
import { Mp4Engine } from '../../src/media/decoding/mp4-engine.ts';
import { WorkerRpc } from '../../src/media/workers/worker-rpc.ts';
import type { PacketCommands } from '../../src/media/workers/worker-protocol.ts';
import {nativeFrames,nativeVisibleHash,nativeVisibleFrameBytes,nativeVideoMetadata,nativeSeekFrame} from '../helpers/media/native-pixels.ts';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {setWasmThreadMode} from '../../src/media/policy/wasm-threads.ts';
const core = new URL('../../public/vendor/voidplayer-core/', import.meta.url);

test('VVC automatic growth accepts local and HTTP MP4 with a two-thread starting budget', { timeout: 120000 }, async t => {
  t.mock.getter(Navigator.prototype, 'hardwareConcurrency', () => 4);
  setWasmThreadMode('auto-grow');
  t.after(() => setWasmThreadMode('auto'));
  const { openPacketMedia } = await import('../../src/media/decoding/packet-media.ts');
  const bytes = await packetFixture('h266_10s_1920x1080.mp4');
  const wasmBinary = await readFile(new URL('voidplayer-core-mt.wasm', core));
  const server = createServer((req, res) => {
    const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '');
    assert.ok(range);
    const start = Number(range[1]), end = Math.min(Number(range[2]), bytes.length - 1);
    res.writeHead(206, { 'content-range': `bytes ${start}-${end}/${bytes.length}`, 'content-length': end - start + 1 });
    res.end(bytes.subarray(start, end + 1));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const file = new File([bytes], 'vvc.mp4');
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/video.mp4`;
    for (const input of [{ file }, { url, size: bytes.length }]) {
      const source = await openPacketMedia('mp4', input, file, {
        glueURL: new URL('voidplayer-core-mt.js', core).href, wasmBinary, forceWasm: true,
      });
      try {
        const first = await source.frameAt(0), signature = visiblePixelHash(first.description, first.pixels!);
        first.close();
        assert.deepEqual([source.info.decoderThreads, source.info.decoderFrameContexts], [2, 2]);
        const frames = await source.framesAfter(0, 12);
        frames.forEach(frame => frame.close());
        assert.equal((await source.tuneVvc!('threads'))?.threads, 4);
        assert.equal((await source.tuneVvc!('contexts'))?.contexts, 4);
        assert.deepEqual([source.info.decoderThreads, source.info.decoderFrameContexts], [4, 4]);
        const restored = await source.frameAt(0);
        assert.equal(visiblePixelHash(restored.description, restored.pixels!), signature);
        restored.close();
      } finally { source.dispose(); }
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

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
      assert.equal(init.decoderThreads, 1);
      assert.equal(init.decoderFrameContexts, 1);
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

test('MP4 VVC grows workers and contexts on the same decoder without changing frame identity', { timeout: 120000 }, async () => {
  const bytes = await packetFixture('h266_10s_1920x1080.mp4');
  const glueURL = new URL('voidplayer-core-mt.js', core).href;
  const wasmBinary = await readFile(new URL('voidplayer-core-mt.wasm', core));
  async function decode(grow: boolean) {
    const rpc = new WorkerRpc<PacketCommands>(new Worker(new URL('../../src/media/decoding/packet-worker.ts', import.meta.url)));
    try {
      const init = await rpc.call('init', { input: { file: new Blob([bytes]) }, container: 'mp4', glueURL, wasmBinary, forceWasm: true,
        threads: { general: 4, vvc: 4, vvcFrameContexts: 4, ...(grow ? { vvcTuning: { threads: 6, contexts: 6 } } : {}) } });
      assert.equal(init.decoderThreads, 4);
      assert.equal(init.decoderFrameContexts, 4);
      const output: Array<[number, string]> = [];
      const record = (frame: NonNullable<Awaited<ReturnType<Mp4Engine['at']>>>) =>
        output.push([frame.pts, visiblePixelHash(frame.description, frame.pixels!)]);
      let frame = await rpc.call('at', { pts: init.firstPtsUs });
      for (let i = 0; i < 48; i++) {
        assert.ok(frame);
        if (grow && (i === 12 || i === 24)) {
          const axis = i === 12 ? 'contexts' : 'threads';
          const before = await rpc.call('tune-vvc', {});
          assert.ok(before);
          assert.ok(before.dispatched > 0 && before.inFlight > 0);
          const after = await rpc.call('tune-vvc', { axis });
          assert.equal(after?.[axis], 6);
          assert.equal(after?.[axis === 'contexts' ? 'threads' : 'contexts'], before[axis === 'contexts' ? 'threads' : 'contexts']);
        }
        record(frame);
        frame = await rpc.call('next', { pts: frame.pts });
      }
      const tail = await rpc.call('at', { pts: init.firstPtsUs + init.times.at(-1)! });
      assert.ok(tail); record(tail);
      assert.equal(await rpc.call('next', { pts: tail.pts }), null);
      const first = await rpc.call('at', { pts: init.firstPtsUs });
      assert.ok(first); record(first);
      if (grow) {
        const state = await rpc.call('tune-vvc', {});
        assert.deepEqual([state?.threads, state?.contexts], [6, 6]);
      }
      await rpc.call('dispose', {});
      return output;
    } finally { rpc.terminate(); }
  }
  assert.deepEqual(await decode(true), await decode(false));
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
