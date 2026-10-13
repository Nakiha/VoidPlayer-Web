import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { Worker as NodeWorker } from 'node:worker_threads';
import { TsPacketSource, tsDecodeIndex, tsPictureStream, parseTsPacketIndex, TS_PACKET_BUILD } from '../../src/ts-packet-source.ts';
import { RangeReader } from '../../src/range-reader.ts';
import { PacketTimeline } from '../../src/packet-timeline.ts';
import { wasmFlvDecoder } from '../../src/flv-decoder.ts';
import { visiblePixelHash } from '../helpers/visible-pixels.ts';
import { readWasmFrame } from '../../src/wasm-frame.ts';
import { openJsTsAnalysisInput } from '../../src/bitstream-analysis/js-ts-input.ts';
import { analyzePicture } from '../../src/bitstream-analysis/runner.ts';
import { pictureId } from '../../src/bitstream-analysis/contract.ts';
import { tsFixture, loadTsCore } from '../helpers/media/ts-analysis.ts';

const version = 'js-ts-static-source-v1';
const signal = () => new AbortController().signal;
const digest = (bytes: ArrayBuffer | Uint8Array) => createHash('sha256').update(new Uint8Array(bytes)).digest('hex');
async function fixture() {
  const bytes = await readFile('fixtures/ts-analysis/h264-static.ts');
  const source = () => new TsPacketSource(new RangeReader({ file: new Blob([bytes]) }), version, signal());
  return { bytes, source };
}

test('JS TS indexes stable decode ordinals, original PES clocks and opaque locators without loading WASM', async () => {
  const { bytes, source } = await fixture(), first = source();
  try {
    const index = await first.open();
    assert.equal(index.build, TS_PACKET_BUILD); assert.equal(index.packets.length, 600);
    assert.equal(index.sourceVersion, version); assert.equal(index.kind, 'js-ts-packets');
    assert.equal(index.packets.filter(p => p.timing.dts === null).length, 138, 'PES without DTS remains unknown');
    const old = { kind: 'ffmpeg-container', schema: 3, size: bytes.length };
    assert.equal(parseTsPacketIndex(old, version, bytes.length), undefined);
    for (const mutate of [
      (copy: any) => { copy.build = 'old-js-build'; }, (copy: any) => { copy.sourceVersion = 'another-source'; },
      (copy: any) => { copy.packets[2].au = 1; }, (copy: any) => { copy.packets[2].timing.dts = Number.NaN; },
    ]) { const copy = structuredClone(index); mutate(copy); assert.equal(parseTsPacketIndex(copy, version, bytes.length), undefined); }
    let closed = false;
    const cachedAnalysis = await openJsTsAnalysisInput({size:bytes.length,read:async()=>{throw new Error('cache-only index must not read media');},close(){closed=true;}},version,signal(),index);
    assert.equal(cachedAnalysis.bytesRead,0);assert.equal(cachedAnalysis.packets.length,600);cachedAnalysis.close();assert.ok(closed);
    const payload = await first.readUnit(560);
    const second = source();
    try {
      const restored = await second.open(JSON.parse(JSON.stringify(index)));
      assert.equal(second.indexReused, true); assert.deepEqual(restored, index);
      assert.ok(second.bytesRead < bytes.length / 2, 'warm open does not scan the whole track');
      for (const au of [200, 599, 0, 560]) {
        const packet = await second.readUnit(au); assert.equal(packet.length, index.packets[au].size);
        if (au === 560) assert.equal(digest(packet), digest(payload));
      }
      const bad = structuredClone(index); bad.packets[560].timing.dts!++;
      const corrupted = source();
      try { const rebuilt=await corrupted.open(bad);assert.equal(corrupted.indexReused,false);assert.deepEqual(rebuilt,index,'unverified metadata rebuilds from source'); }
      finally { corrupted.close(); }
    } finally { second.close(); }
    await assert.rejects(first.readUnit(-1), /out of bounds/);
  } finally { first.close(); }
});

test('missing, renumbered and fake-complete cache records cannot mint exact AU identities', async () => {
  const {bytes,source}=await fixture(), original=source();
  try {
    const index=await original.open();
    for(const corruption of ['middle','tail','renumbered','partial'] as const){
      const bad=structuredClone(index);
      if(corruption==='middle'||corruption==='renumbered') {bad.packets.splice(1,1);bad.packets.forEach((p,i)=>{p.au=i;});}
      if(corruption==='tail'||corruption==='partial')bad.packets.pop();
      if(corruption==='renumbered'||corruption==='partial')bad.completeness.packets=bad.packets.length;
      if(corruption==='middle'||corruption==='tail')assert.equal(parseTsPacketIndex(bad,version,bytes.length),undefined,'advertised coverage rejects dropped records');
      assert.throws(()=>tsDecodeIndex(bad),/unverified complete index/,'raw documents cannot bypass source verification');
      const playback=source();
      try {
        const rebuilt=await playback.open(bad);assert.equal(playback.indexReused,false);assert.deepEqual(rebuilt,index);
        assert.equal(digest(await playback.readUnit(49)),digest(await original.readUnit(49)),'AU49 never becomes original AU50');
      } finally {playback.close();}
      const analysis=await openJsTsAnalysisInput({size:bytes.length,read:async(at,length)=>bytes.subarray(at,at+length),close(){}},version,signal(),bad);
      try {
        assert.equal(analysis.totalPackets,600,'fake complete prefix is rebuilt to actual EOF');
        const p=analysis.packets[49], target={sourceVersion:version,sourcePtsUs:p.pts,normalizedMediaUs:0,picture:analysis.picture(p,version)};
        assert.equal((await analysis.plan(target)).identity.au,49);
        assert.equal(digest(await analysis.readUnit(p)),digest(await original.readUnit(49)));
      } finally {analysis.close();}
    }
    assert.ok(Object.isFrozen(index));assert.ok(Object.isFrozen(index.packets[1].timing));
  } finally {original.close();}
});

test('a serialized complete document in a fresh runtime rebuilds instead of trusting its own flags', async () => {
  const {bytes,source}=await fixture(), original=source();
  let worker: NodeWorker | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const index=await original.open();
    worker=new NodeWorker(`
      const {parentPort,workerData}=require('node:worker_threads');
      (async()=>{
        const {TsPacketSource}=await import(workerData.module);
        const bytes=workerData.bytes;
        const source=new TsPacketSource({size:bytes.length,read:async(at,len)=>bytes.subarray(at,at+len),close(){}},workerData.version,new AbortController().signal);
        try {const index=await source.open(workerData.index);parentPort.postMessage({reused:source.indexReused,packets:index.packets.length,bytes:source.bytesRead});}
        finally {source.close();parentPort.close();}
      })().catch(error=>{throw error;});
    `,{eval:true,workerData:{bytes,index,version,module:pathToFileURL(resolve('src/ts-packet-source.ts')).href}});
    const result=await new Promise<{reused:boolean;packets:number;bytes:number}>((resolve,reject)=>{
      timer=setTimeout(()=>reject(new Error('fresh-runtime verification timed out')),15000);
      worker!.once('message',resolve);worker!.once('error',reject);
    });
    assert.equal(result.reused,false);assert.equal(result.packets,600);assert.ok(result.bytes>=bytes.length,'untrusted persisted metadata cannot produce exact results with a prefix-only verification');
  } finally {clearTimeout(timer);await worker?.terminate();original.close();}
});

test('JS TS refuses broken transport clocks, short reads and cancelled ownership', async () => {
  const { bytes, source } = await fixture(), reference = source();
  let index;
  try { index = await reference.open(); } finally { reference.close(); }
  const withDts = index.packets.find(p => p.timing.dts !== null)!;
  const offset = withDts.pesOffset!;
  let pes = offset + 4;
  if (bytes[offset + 3] & 0x20) pes += bytes[pes] + 1;
  for (const corrupt of [
    (copy: Uint8Array) => { copy[offset + 1] |= 0x80; },
    (copy: Uint8Array) => { copy[pes + 14] &= 0xfe; },
  ]) {
    const copy = new Uint8Array(bytes); corrupt(copy);
    let closed = false;
    const damaged = new TsPacketSource({ size: copy.length, read: async (at,length) => copy.subarray(at,at+length), close(){closed=true;} },version,signal());
    await assert.rejects(damaged.open(), /errored or scrambled|clock markers/);
    assert.ok(closed, 'failed admission closes its own reader');
  }
  let closed = false;
  const short = new TsPacketSource({ size: bytes.length, read: async (at,length) => bytes.subarray(at,at+Math.max(0,length-1)), close(){closed=true;} },version,signal());
  await assert.rejects(short.open(), /short transport read/); assert.ok(closed);
  const controller = new AbortController();
  const cancelled = new TsPacketSource({size:bytes.length,read:async(at,length)=>bytes.subarray(at,at+length),close(){closed=true;}},version,controller.signal);
  closed=false;controller.abort();assert.ok(closed);
  await assert.rejects(cancelled.open(), {name:'AbortError'});
});

test('warm analysis pre-abort closes its reader before returning cached metadata', async () => {
  const {bytes,source}=await fixture(), original=source();
  try {
    const index=await original.open(), controller=new AbortController();controller.abort();
    let closed=0,reads=0;
    await assert.rejects(openJsTsAnalysisInput({size:bytes.length,read:async()=>{reads++;throw new Error('pre-abort must not read');},close(){closed++;}},version,controller.signal,index),{name:'AbortError'});
    assert.equal(reads,0);assert.equal(closed,1);
  } finally {original.close();}
});

test('hostile PES clock count is rejected before allocating beyond the index budget', async () => {
  const {bytes,source}=await fixture(), original=source();
  let index;
  try {index=await original.open();} finally {original.close();}
  let lastCounter=0;
  for(let at=0;at<bytes.length;at+=188){
    if(((bytes[at+1]&31)*256+bytes[at+2])!==index.pid)continue;
    const control=(bytes[at+3]>>4)&3;
    const payload=at+4+(control&2?bytes[at+4]+1:0);
    if((control&1)&&payload<at+188)lastCounter=bytes[at+3]&15;
  }
  const excess=300000,size=bytes.length+excess*188;
  let highestRead=0,closed=0;
  const hostile=new TsPacketSource({size,async read(offset,length){
    highestRead=Math.max(highestRead,offset+length);
    const result=new Uint8Array(length);
    for(let at=offset;at<offset+length;){
      if(at<bytes.length){const end=Math.min(bytes.length,offset+length);result.set(bytes.subarray(at,end),at-offset);at=end;continue;}
      const number=Math.floor((at-bytes.length)/188),inside=(at-bytes.length)%188;
      const packet=new Uint8Array(188).fill(0xff);
      packet.set([0x47,0x40|(index.pid>>8),index.pid&255,0x10|((lastCounter+number+1)&15),0,0,1,0xe0,0,0,0x80,0x80,5,0x21,0,1,0,1]);
      const count=Math.min(188-inside,offset+length-at);result.set(packet.subarray(inside,inside+count),at-offset);at+=count;
    }
    return result;
  },close(){closed++;}},'hostile-ts-source',signal());
  await assert.rejects(hostile.open(),/PES clock budget exceeded/);
  assert.equal(closed,1);assert.equal(hostile.index,undefined);
  assert.ok(highestRead<=bytes.length+250001*188+188*1024+1024*1024,'bounded scan stops before the hostile tail');
  assert.ok(highestRead<size,'remaining hostile PES headers are never enumerated');
});

test('JS TS packet-fed WASM produces the same real pictures and stable source tokens as the independent container oracle', async () => {
  const { source } = await fixture(), js = source(), oracle = await tsFixture();
  let timeline: PacketTimeline | undefined;
  try {
    const index = await js.open(), decoded = tsDecodeIndex(index);
    const decoder = await wasmFlvDecoder(decoded,
      pathToFileURL(resolve('public/vendor/voidplayer-core/voidplayer-core.js')).href,
      new Uint8Array(await readFile('public/vendor/voidplayer-core/voidplayer-core.wasm')));
    timeline = new PacketTimeline(decoded, decoder, packet => js.readUnit(packet.sequenceNumber!), true, () => true, tsPictureStream(index));
    const checks = [0, 3, 200, 560, 599, 0];
    for (const au of checks) {
      const frame = await timeline.at(index.packets[au].ptsUs);
      assert.equal(frame.pts, index.packets[au].ptsUs);
      assert.deepEqual(frame.packetPicture, { au, configuration: 0, stream: tsPictureStream(index) });
      assert.equal(oracle.play._vp_extract(oracle.ctx, oracle.ordered[au].pts), 1);
      const expected = readWasmFrame(oracle.play, () => oracle.play.HEAPU8, oracle.ctx);
      assert.equal(visiblePixelHash(frame.description,frame.pixels!), visiblePixelHash(expected.description,expected.pixels!), `AU ${au} all visible full-precision source planes`);
      frame.frame?.close();
    }
    const ids = new Set<number>();
    let frame = await timeline.at(decoded.firstPts);
    for (;;) {
      assert.ok(frame.packetPicture); assert.ok(!ids.has(frame.packetPicture.au),'actual output identities never duplicate'); ids.add(frame.packetPicture.au);
      const pts = frame.pts; frame.frame?.close();
      const next = await timeline.next(pts); if (!next) break; frame = next;
    }
    assert.equal(ids.size, 600, 'real EOF drain returns every picture once');
  } finally { timeline?.close(); js.close(); oracle.close(); }
});

test('independent JS TS analysis shares packet identity, preserves missing DTS and matches frozen codec answers', async () => {
  const { bytes, source } = await fixture(), playback = source();
  const index = await playback.open();
  const answers = JSON.parse(await readFile('docs/fixtures/bitstream-analysis-answers.json', 'utf8'))[0];
  try {
    for (const au of [0, 3, 200, 560]) {
      const reader = { size: bytes.length, async read(offset: number, length: number) { return bytes.subarray(offset, offset + length); }, close() {} };
      const controller = new AbortController(), input = await openJsTsAnalysisInput(reader, version, controller.signal, index);
      const packet = input.packets[au], target = { sourceVersion: version, sourcePtsUs: packet.pts, normalizedMediaUs: 0, picture: input.picture(packet, version) };
      const expected = { sourceVersion: version, stream: tsPictureStream(index), configuration: 0, au, picture: 0 as const, layer: 0 as const, field: 'frame' as const };
      assert.equal(pictureId(target.picture), pictureId(expected));
      const core = await loadTsCore();
      // This source must not reach the overlapping analysis container API.
      core._vpd_open = () => { throw new Error('hidden WASM demux is forbidden'); };
      const result = await analyzePicture(reader, target, core, 'js-ts-packets-test', controller.signal, { input });
      assert.equal(result.confidence, 'exact'); assert.deepEqual(result.picture, expected);
      assert.equal(result.sourceDtsUs, index.packets[au].timing.dts === null ? null : Math.round(index.packets[au].timing.dts! * 1e6 / 90000));
      if (!au) for (const block of answers.firstBlocks) assert.deepEqual(result.blocks.find(b => b.x === block.x && b.y === block.y), block);
      assert.equal((await playback.readUnit(au)).length, packet.size, 'analysis did not move or close playback cursor');
    }
  } finally { playback.close(); }
});
