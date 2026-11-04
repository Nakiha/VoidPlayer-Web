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
import { floorIndex, nextIndex, openFFmpegMedia } from '../../src/media/decoding/ffmpeg-media.ts';
import { openMedia } from '../../src/media/source.ts';
import type { FallbackDeps } from '../../src/media/decoding/ffmpeg-media.ts';
import type { MediaSource } from '../../src/media/contract.ts';

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
