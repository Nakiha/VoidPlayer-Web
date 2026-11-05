import '../helpers/browser-worker-host.ts';
import {openPacketMedia} from '../../src/media/decoding/packet-media.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { WorkerRpc } from '../../src/media/workers/worker-rpc.ts';
import type { FfmpegCommands } from '../../src/media/workers/worker-protocol.ts';
import { floorIndex, nextIndex, openFFmpegMedia, openFFmpegContainerFromUrl } from '../../src/media/decoding/ffmpeg-media.ts';
import { openMedia } from '../../src/media/source.ts';
import type { FallbackDeps } from '../../src/media/decoding/ffmpeg-media.ts';
import type { MediaSource } from '../../src/media/contract.ts';
import { reserveFallbackThreads } from '../../src/media/decoding/fallback-runtime.ts';
import { setWasmThreadMode, wasmThreadMode } from '../../src/media/policy/wasm-threads.ts';
import { visiblePixelHash } from '../helpers/visible-pixels.ts';
import { createMediaServer } from '../../server/app.ts';
import { MediaLibraryIndex } from '../../server/library.ts';
import { nativeFrames, nativeVisibleHash } from '../helpers/media/native-pixels.ts';

for (const shared of [true, false]) test(`local FFmpeg containers preserve exact seek pixels with shared IO ${shared}`, { timeout: 60000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'vp-file-bridge-')), path = join(directory, 'ffv1.avi');
  t.after(() => rm(directory, {recursive:true,force:true}));
  if (!shared) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis,'SharedArrayBuffer')!;
    Object.defineProperty(globalThis,'SharedArrayBuffer',{...descriptor,value:undefined});
    t.after(() => Object.defineProperty(globalThis,'SharedArrayBuffer',descriptor));
  }
  execFileSync('ffmpeg', ['-v','error','-y','-i','fixtures/video/ffv1_yuv422p_8bit.mkv','-an','-c:v','copy','-f','avi',path]);
  const file = new File([await readFile(path)], 'ffv1.avi'), slice = file.slice.bind(file), reads: number[] = [];
  t.mock.method(file, 'slice', (start = 0, end = file.size) => { reads.push(end-start); return slice(start,end); });
  const core = new URL('../../public/vendor/voidplayer-core/', import.meta.url);
  const source = await openFFmpegMedia(file, {glueURL:new URL('voidplayer-core.js',core).href,
    wasmBinary:await readFile(new URL('voidplayer-core.wasm',core))});
  try {
    assert.equal(reads.length > 0, shared, 'shared IO reads the original File outside the synchronous decoder worker');
    assert.ok(reads.every(bytes => bytes <= 256 * 1024), 'opening retains demand-only bounded IO');
    const positions = [0,1,30,59,0], oracle = nativeFrames(path, [...new Set(positions)], 'yuv422p', 320*180*2);
    const probe = JSON.parse(execFileSync('ffprobe', ['-v','error','-select_streams','v:0',
      '-show_entries','stream=time_base:frame=best_effort_timestamp','-of','json',path], {encoding:'utf8'}));
    const [num, den] = probe.streams[0].time_base.split('/').map(Number), first = Number(probe.frames[0].best_effort_timestamp);
    for (const position of positions) {
      const pts = (Number(probe.frames[position].best_effort_timestamp) - first) * num * 1e6 / den;
      const frame = await source.frameAt(Math.round(pts));
      try { assert.equal(visiblePixelHash(frame.description,frame.pixels!), nativeVisibleHash(frame.description,oracle.get(position)!),
        `frame ${position}, actual PTS ${frame.ptsUs}, duration ${source.info.durationUs}`); }
      finally { frame.close(); }
    }
  } finally { source.dispose(); }
});

for (const backend of ['packet', 'container'] as const) test(`${backend}: released replacement budget restores actual WASM threads without changing source pixels or index`, { timeout: 120000 }, async t => {
  t.mock.getter(Navigator.prototype, 'hardwareConcurrency', () => 8);
  const mode = wasmThreadMode(); setWasmThreadMode('auto');
  const old = reserveFallbackThreads('auto');
  const core = new URL('../../public/vendor/voidplayer-core/', import.meta.url);
  const directory = await mkdtemp(join(tmpdir(), 'vp-budget-'));
  const path = join(directory, 'ffv1.avi');
  if (backend === 'container') execFileSync(process.env.VOIDPLAYER_FFMPEG_ORACLE || 'ffmpeg',
    ['-v', 'error', '-y', '-i', resolve('fixtures/video/ffv1_yuv422p_8bit.mkv'), '-map', '0:v:0', '-c', 'copy', '-f', 'avi', path]);
  const file = backend === 'packet'
    ? new File([await readFile(new URL('../../fixtures/video/h264_9s_1920x1080.mp4', import.meta.url))], 'clip.mp4')
    : new File([await readFile(path)], 'ffv1.avi');
  const deps = { glueURL: new URL('voidplayer-core-mt.js', core).href, wasmBinary: await readFile(new URL('voidplayer-core-mt.wasm', core)) };
  let source: MediaSource | undefined;
  let closeLibrary: (() => Promise<void>) | undefined;
  try {
    if (backend === 'packet') source = await openPacketMedia('mp4', { file }, file, { ...deps, forceWasm: true });
    else {
      const library = new MediaLibraryIndex([directory], { watch: false });
      const server = createMediaServer({ roots: [directory], library, onLog() {} });
      closeLibrary = async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await library.close(); };
      await library.refresh();
      const entry = library.browse().entries[0];
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/media/${entry.id}?v=${entry.version}`;
      source = await openFFmpegContainerFromUrl(url, { name: file.name, size: file.size, lastModified: file.lastModified }, deps);
    }
    await source.ensureIndexed?.();
    assert.equal(source.info.decoderThreads, 1);
    const first = await source.frameAt(0), hash = visiblePixelHash(first.description, first.pixels!);
    const originalId = source.info.id, originalIndex = source.info.indexSource;
    first.close();
    const sought = await source.frameAt(1_000_000), targetPts = sought.ptsUs;
    const targetHash = visiblePixelHash(sought.description, sought.pixels!), targetPicture = sought.sourcePicture;
    sought.close();
    old.release();
    const upgraded = await source.frameAt(1_000_000);
    assert.equal(source.info.decoderThreads, 4, 'metadata reports the actual upgraded core, not just the host budget');
    assert.equal(visiblePixelHash(upgraded.description, upgraded.pixels!), targetHash);
    assert.equal(upgraded.ptsUs, targetPts);
    assert.deepEqual(upgraded.sourcePicture, targetPicture);
    assert.equal(source.info.id, originalId);
    assert.equal(source.info.indexSource, originalIndex);
    upgraded.close();
    const frames = await source.framesAfter(0, 3);
    assert.equal(frames.length, 3);
    assert.ok(frames.every((frame, i) => frame.ptsUs > (i ? frames[i - 1].ptsUs : 0)));
    frames.forEach(frame => frame.close());
    const replay = await source.frameAt(0);
    assert.equal(visiblePixelHash(replay.description, replay.pixels!), hash);
    replay.close();
  } finally {
    source?.dispose(); old.release(); setWasmThreadMode(mode);
    await closeLibrary?.();
    await rm(directory, { recursive: true, force: true });
  }
});

test('failed thread growth releases its extra reservation and keeps the original packet decoder usable', async t => {
  t.mock.getter(Navigator.prototype, 'hardwareConcurrency', () => 8);
  const mode = wasmThreadMode(); setWasmThreadMode('auto');
  const old = reserveFallbackThreads('auto'), core = new URL('../../public/vendor/voidplayer-core/', import.meta.url);
  const binary = await readFile(new URL('voidplayer-core-mt.wasm', core));
  const file = new File([await readFile(new URL('../../fixtures/video/h264_9s_1920x1080.mp4', import.meta.url))], 'clip.mp4');
  let source: MediaSource | undefined;
  try {
    source = await openPacketMedia('mp4', { file }, file, { forceWasm: true, glueURL: new URL('voidplayer-core-mt.js', core).href, wasmBinary: binary });
    const first = await source.frameAt(0), hash = visiblePixelHash(first.description, first.pixels!);
    first.close();
    binary.fill(0); // The existing Worker owns a separate copy; only the new candidate fails compilation.
    old.release();
    for (let repeat = 0; repeat < 2; repeat++) {
      const retained = await source.frameAt(0);
      assert.equal(source.info.decoderThreads, 1);
      assert.equal(visiblePixelHash(retained.description, retained.pixels!), hash);
      retained.close();
    }
    source.dispose();
    const fresh = reserveFallbackThreads('auto');
    assert.equal(fresh.threads.general, 4, 'failed growth and source disposal return all reservations');
    fresh.release();
  } finally { source?.dispose(); old.release(); setWasmThreadMode(mode); }
});

test('FFmpeg container worker exposes live VVC tuning independently of MP4 packets', { timeout: 120000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vp-vvc-container-'));
  const rpc = new WorkerRpc<FfmpegCommands>(new Worker(new URL('../../src/media/decoding/ffmpeg-worker.ts', import.meta.url)));
  try {
    const file = join(directory, 'vvc.avi');
    execFileSync(process.env.VOIDPLAYER_FFMPEG_ORACLE || 'ffmpeg',
      ['-v', 'error', '-y', '-i', resolve('fixtures/video/h266_10s_1920x1080.mp4'), '-map', '0:v:0', '-c', 'copy', '-tag:v', 'VVC1', file]);
    const bytes = await readFile(file);
    const core = new URL('../../public/vendor/voidplayer-core/', import.meta.url);
    // Use the normal first-frame handshake. Full index admission belongs to
    // the independent container/index tests.
    const init = await rpc.call('init', { name: 'vvc.avi', file: Uint8Array.from(bytes).buffer,
      glueURL: new URL('voidplayer-core-mt.js', core).href, wasmBinary: await readFile(new URL('voidplayer-core-mt.wasm', core)),
      externalIndexSession: true, mediaSize: bytes.length,
      threads: { general: 4, vvc: 4, vvcFrameContexts: 4, vvcTuning: { threads: 6, contexts: 6 } } });
    assert.equal(init.codec, 'vvc'); assert.ok(init.firstFrame?.pixels.byteLength);
    const before = await rpc.call('tune-vvc', { ctx: init.ctx });
    assert.deepEqual([before?.threads, before?.contexts], [4, 4]);
    assert.equal((await rpc.call('tune-vvc', { ctx: init.ctx, axis: 'threads' }))?.threads, 6);
    assert.equal((await rpc.call('tune-vvc', { ctx: init.ctx, axis: 'contexts' }))?.contexts, 6);
    await rpc.call('dispose', { ctx: init.ctx, path: init.path });
    assert.equal(await rpc.call('tune-vvc', { ctx: init.ctx }), null);
  } finally { rpc.terminate(); await rm(directory, { recursive: true, force: true }); }
});

// --- pure index navigation ---

test('floorIndex and nextIndex resolve frame navigation boundaries', () => {
  const times = [0, 33333, 66667, 100000];
  assert.equal(floorIndex(times, 0), 0);
  assert.equal(floorIndex(times, 66666), 1);
  assert.equal(floorIndex(times, 100000), 3);
  assert.equal(floorIndex(times, 999999), 3);
  assert.equal(nextIndex(times, 0), 1);
  assert.equal(nextIndex(times, 99999), 3);
  assert.equal(nextIndex(times, 100000), -1);
});

// --- real WASM decode against the repository's sample files ---

async function nodeCoreDeps(): Promise<FallbackDeps> {
  const coreDir = new URL('../../public/vendor/voidplayer-core/', import.meta.url);
  let wasmBinary;
  try { wasmBinary = await readFile(new URL('voidplayer-core.wasm', coreDir)); }
  catch {
    throw new Error('缺少 vendor 的 WASM core：先运行 scripts/sync-wasm-core.sh（需要 VoidPlayer-FFmpeg-Build 的构建产物）');
  }
  return { glueURL: new URL('voidplayer-core.js', coreDir).href, wasmBinary };
}
async function openSample(name: string, onProgress?: import('../../src/media/progress.ts').MediaOpenProgress): Promise<MediaSource> {
  const deps = await nodeCoreDeps();
  const data = await readFile(new URL(`../../fixtures/video/${name}`, import.meta.url));
  const file=new File([data],name);return openPacketMedia(name.endsWith('.mkv')?'matroska':name.endsWith('.ts')?'ts':'mp4',{file},file,{...deps,onProgress,forceWasm:true,sourceVersion:name});
}

test('WASM fallback indexes and decodes an FFV1 Matroska sample frame-exactly', async () => {
  const source = await openSample('ffv1_yuv422p_8bit.mkv');
  try {
    assert.equal(source.info.codec, 'ffv1');
    assert.equal(source.info.decoder, 'ffmpeg-wasm');
    assert.equal(source.info.pixelFormat, 'yuv422p');
    assert.equal(source.info.width, 320); assert.equal(source.info.height, 180);
    assert.ok(Math.abs(source.info.durationUs - 2000000) <= 2000);
    const first = await source.frameAt(0);
    assert.equal(first.ptsUs, 0); assert.equal(first.sourcePtsUs, 0);
    const mid = await source.frameAt(33999);
    assert.equal(mid.ptsUs, 33000);
    const after = await source.framesAfter(0, 2);
    assert.deepEqual(after.map(f => f.ptsUs), [33000, 67000]);
    const tail = await source.framesAfter(1934000, 5);
    assert.deepEqual(tail.map(f => f.ptsUs), [1967000]);
    const pixels = (mid as { pixels?: Uint8ClampedArray }).pixels;
    assert.equal(pixels?.length, 320 * 180 * 2);
    assert.ok(new Set(pixels!.slice(0, 4096)).size > 1, 'frame must not be blank');
  } finally { source.dispose(); }
});

test('WASM fallback handles an MPEG-2 TS sample through the finite JS PES adapter', async () => {
  const stages: string[] = [];
  const source = await openSample('mpeg2_10s_1280x720.ts', stage => stages.push(stage));
  assert.deepEqual(stages.filter((stage, i) => stage !== stages[i - 1]), ['inspect', 'index', 'decoder', 'first-frame']);
  try {
    assert.equal(source.info.codec, 'mpeg2video');
    assert.equal(source.info.width, 1280); assert.equal(source.info.height, 720);
    assert.equal(source.info.firstPtsUs, 316667);
    assert.ok(Math.abs(source.info.durationUs - 10000000) <= 100);
    const first = await source.frameAt(0);
    assert.equal(first.ptsUs, 0); assert.equal(first.sourcePtsUs, 316667);
    const after = await source.framesAfter(0, 2);
    assert.equal(after.length, 2);
    assert.ok(Math.abs(after[0].ptsUs - 16667) <= 2 && Math.abs(after[1].ptsUs - 33333) <= 2);
    assert.ok(source.framesFollowing, 'actual FFmpeg source supplies strict playback successors');
    const stream=source.framesFollowing!(0),sequence:number[]=[];
    for(let i=0;i<3;i++){const next=await stream.next();assert.equal(next.done,false);sequence.push(next.value!.ptsUs);next.value!.close();}
    await stream.return(undefined);
    const resumed=source.framesFollowing!(sequence.at(-1)!);const following=await resumed.next();assert.equal(following.done,false);
    assert.ok(following.value!.ptsUs>sequence.at(-1)!);assert.ok(Math.abs(following.value!.ptsUs-66667)<=2);
    following.value!.close();await resumed.return(undefined);assert.ok(Math.abs(sequence[0]-16667)<=2);assert.ok(Math.abs(sequence[2]-50000)<=2);
    assert.equal((await source.framesFollowing!(source.info.durationUs).next()).done,true);
    // Backward/random access must recover through a fresh GOP decode.
    const late = await source.frameAt(5000000);
    const back = await source.frameAt(0);
    assert.equal(back.ptsUs, 0);
    assert.ok(late.ptsUs > 4999000 && late.ptsUs <= 5000000);
  } finally { source.dispose(); }
});

test('WASM fallback covers H.264 High 4:2:2, which browsers do not decode', async () => {
  // avc1.7a000d (High 4:2:2) is rejected by WebCodecs on all mainstream
  // browsers; the fallback must carry it like any other codec gap.
  const source = await openSample('h264_high422p_1s_320x180.mp4');
  try {
    assert.equal(source.info.codec, 'h264');
    assert.equal(source.info.width, 320); assert.equal(source.info.height, 180);
    const first = await source.frameAt(0);
    assert.equal(first.ptsUs, 0);
    assert.ok(new Set((first as { pixels?: Uint8ClampedArray }).pixels!.slice(0, 4096)).size > 1, 'frame must not be blank');
  } finally { source.dispose(); }
});

test('WASM fallback decodes H.266/VVC through the n9.0.1 core', async () => {
  const source = await openSample('h266_10s_1920x1080.mp4');
  try {
    assert.equal(source.info.codec, 'vvc');
    assert.equal(source.info.width, 1920); assert.equal(source.info.height, 1080);
    const first = await source.frameAt(0);
    assert.equal(first.ptsUs, 0);
    const pixels = (first as { pixels?: Uint8ClampedArray }).pixels;
    assert.equal(pixels?.length, 1920 * 1080 * 1.5);
    assert.ok(new Set(pixels!.slice(0, 8192)).size > 1, 'frame must not be blank');
  } finally { source.dispose(); }
});

test('openMedia keeps FFV1 on JS packets and never invokes a container fallback', async () => {
  const { BrowserWorker: NodeWorker } = await import('../helpers/browser-worker-host.ts'),deps=await nodeCoreDeps();
  const globals=globalThis as unknown as {document?:{baseURI:string};Worker?:unknown};
  const priorDocument=globals.document,priorWorker=globals.Worker;
  globals.document={baseURI:new URL('../../public/index.html',import.meta.url).href};
  class PacketWorker extends NodeWorker {
    constructor(url:URL){super(url);}
    override postMessage(message:any,transfers:any[]=[]){super.postMessage(message.type==='init'?{...message,wasmBinary:deps.wasmBinary}:message,transfers);}
  }
  globals.Worker=PacketWorker;
  try{
    const data=await readFile(new URL('../../fixtures/video/ffv1_yuv422p10le.mkv',import.meta.url));let fallback=0;
    const source=await openMedia(new File([data],'ffv1_yuv422p10le.mkv'),async()=>{fallback++;throw new Error('Container fallback forbidden');});
    try{assert.equal(fallback,0);assert.equal(source.info.decoder,'ffmpeg-wasm');assert.equal(source.info.codec,'ffv1');assert.equal(source.info.demuxBackend,'js-matroska-packets');
      const frame=await source.frameAt(0);assert.equal(frame.pixels?.length,source.info.width*source.info.height*4);frame.close();
    }finally{source.dispose();}
  }finally{if(priorDocument===undefined)delete globals.document;else globals.document=priorDocument;if(priorWorker===undefined)delete globals.Worker;else globals.Worker=priorWorker;}
});

test('WASM source metadata retains 10-bit layout and decoded BT.709 tags in original YUV planes', async () => {
  const tenBit = await openSample('ffv1_yuv444p10le.mkv');
  try { assert.equal(tenBit.info.pixelFormat, 'yuv444p10le'); }
  finally { tenBit.dispose(); }
  const full = await openSample('mhw_hevc_fullrange_bt709_3s.mp4');
  try {
    // This fixture's MP4 colr says PC, but ffprobe -show_frames confirms TV in the bitstream.
    assert.equal(full.info.color?.fullRange, false);
    assert.equal(full.info.colorSource, 'decoder');
    assert.equal(full.info.color?.primaries, 'bt709');
    assert.equal(full.info.color?.transfer, 'bt709');
    assert.equal(full.info.color?.matrix, 'bt709');
    assert.ok(full.info.pixelFormat?.startsWith('yuv'));
  } finally { full.dispose(); }
});
