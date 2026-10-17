import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { WorkerRpc } from '../../src/media/workers/worker-rpc.ts';
import type { PacketCommands } from '../../src/media/workers/worker-protocol.ts';
import { tsPictureStream } from '../../shared/media/indexing/ts-packet-index.ts';
import { visiblePixelHash } from '../helpers/visible-pixels.ts';
import {nativeFrames,nativeVisibleHash} from '../helpers/media/native-pixels.ts';
import { loadTsCore } from '../helpers/media/ts-analysis.ts';
import { openJsTsAnalysisInput } from '../../shared/analysis/bitstream/js-ts-input.ts';
import { analyzePicture } from '../../shared/analysis/bitstream/runner.ts';

test('real packet Worker TS engine drains, seeks and shares exact identity with independent codec analysis without container WASM', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'voidplayer-js-ts-engine-'));
  const bytes = await readFile('fixtures/ts-analysis/h264-static.ts');
  const glue = pathToFileURL(resolve('public/vendor/voidplayer-core/voidplayer-core.js')).href;
  // Trap the actual loaded core API, rather than inferring routing from names.
  const wrapper = join(directory, 'packet-only.mjs');
  await writeFile(wrapper, `import load from ${JSON.stringify(glue)}; export default async function(options) { const core = await load(options); core._vp_open = () => { throw new Error('container WASM forbidden'); }; return core; }`);
  const worker = new Worker(new URL('../../src/media/decoding/packet-worker.ts', import.meta.url));
  const rpc = new WorkerRpc<PacketCommands>(worker as unknown as globalThis.Worker);
  try {
    const admitted = await rpc.call('prepare-ts', {input:{file:new Blob([bytes])},sourceVersion:'engine-ts-v1'});
    assert.equal(admitted.admitted,true);
    assert.deepEqual(await rpc.call('analysis-index',{}),{packets:600,complete:true});
    const initialized = await rpc.call('init', { container: 'ts', input: { file: new Blob([bytes]) }, sourceVersion: 'engine-ts-v1', preparedTsSession:admitted.session,
      glueURL: pathToFileURL(wrapper).href, wasmBinary: new Uint8Array(await readFile('public/vendor/voidplayer-core/voidplayer-core.wasm')),
      forceWasm: false, threads: 1 }, [], 60000);
    assert.equal(initialized.decoder, 'ffmpeg-wasm', 'Node native-unavailable fallback is packet-fed');
    assert.equal(initialized.codec, 'h264'); assert.equal(initialized.times.length, 600);
    const index = await rpc.call('analysis-ts-index', {});
    assert.equal(index.sourceVersion, 'engine-ts-v1'); assert.equal(index.packets.length, 600);
    assert.equal(initialized.seekAnchorCount,index.packets.filter(packet=>packet.key).length);assert.ok(initialized.seekAnchorCount!>0);
    assert.equal(index.packets.filter(p => p.timing.dts === null).length, 138);
    const checks=[0,3,200,560,599,0],display=checks.map(au=>index.packets.filter(p=>p.ptsUs<index.packets[au].ptsUs).length);
    const expectedFrames=nativeFrames('fixtures/ts-analysis/h264-static.ts',display,'yuv420p',1920*1080*3/2);
    for (const au of checks) {
      const frame = await rpc.call('at', { pts: index.packets[au].ptsUs }); assert.ok(frame);
      assert.deepEqual(frame.packetPicture, { au, configuration: 0, stream: tsPictureStream(index) });
      assert.equal(frame.pts, index.packets[au].ptsUs);
      const position=index.packets.filter(p=>p.ptsUs<index.packets[au].ptsUs).length;
      assert.equal(visiblePixelHash(frame.description, frame.pixels!),nativeVisibleHash(frame.description,expectedFrames.get(position)!), `AU ${au}: full visible planes`);
      frame.frame?.close();
    }
    const ids = new Set<number>();
    let frame = await rpc.call('at', { pts: index.packets[0].ptsUs });
    while (frame) {
      assert.ok(frame.packetPicture); assert.ok(!ids.has(frame.packetPicture.au)); ids.add(frame.packetPicture.au);
      const pts = frame.pts; frame.frame?.close(); frame = await rpc.call('next', { pts });
    }
    assert.equal(ids.size, 600, 'actual complete EOF output, no fabricated index frames');
    const reader = { size: bytes.length, async read(offset: number, length: number) { return bytes.subarray(offset, offset + length); }, close() {} };
    const signal = new AbortController().signal;
    // Worker serialization is metadata, not an authority token: a separate
    // analysis reader fully verifies it, while playback retains its own cursor.
    const analysis = await openJsTsAnalysisInput(reader, index.sourceVersion, signal, index);
    const packet = analysis.packets[560], picture = analysis.picture(packet, index.sourceVersion);
    const core = await loadTsCore(); core._vpd_open = () => { throw new Error('analysis container WASM forbidden'); };
    const result = await analyzePicture(reader, { sourceVersion: index.sourceVersion, sourcePtsUs: packet.pts, normalizedMediaUs: 0, picture }, core, 'engine-test', signal, { input: analysis });
    assert.equal(result.confidence, 'exact'); assert.deepEqual(result.picture, picture);
    const after = await rpc.call('at', { pts: index.packets[560].ptsUs }); assert.ok(after);
    assert.deepEqual(after.packetPicture, { au: picture.au, configuration: picture.configuration, stream: picture.stream });
    after.frame?.close();
    const presentationOrder = [...index.packets].sort((a,b)=>a.ptsUs-b.ptsUs);
    const ranked = await rpc.call('extract', {position:3}); assert.equal(ranked?.packetPicture?.au,presentationOrder[3].au); ranked?.frame?.close();
    await assert.rejects(rpc.call('extract', { position: 600 }), /out of bounds/);
    assert.equal((await rpc.call('analysis-index', {})).complete, true, 'failed input request leaves the source intact');
    await rpc.call('dispose', {});
    await assert.rejects(rpc.call('at', { pts: index.packets[0].ptsUs }), /未初始化/);
  } finally { rpc.terminate();  await rm(directory, { recursive: true, force: true }); }
});

test('admitted multislice and MBAFF TS prepare without a decoder and never claim exact picture identity', async () => {
  for (const name of ['progressive-two-slices.ts','mbaff.ts']) {
    const worker = new Worker(new URL('../../src/media/decoding/packet-worker.ts', import.meta.url));
    const rpc = new WorkerRpc<PacketCommands>(worker as unknown as globalThis.Worker);
    try {
      const bytes = await readFile(`fixtures/ts-analysis/${name}`);
      const result=await rpc.call('prepare-ts',{sourceVersion:`admitted-${name}`,input:{file:new Blob([bytes])}},[],60000);
      assert.equal(result.admitted,true);
      assert.equal(result.index.kind,'js-ts-packets');
      assert.equal(result.index.sourceVersion,`admitted-${name}`);
      assert.equal(result.index.exactPictureMapping,false);
      assert.ok(result.index.packets.length>0);
      await rpc.call('dispose', {});
    } finally { rpc.terminate(); }
  }
});


test('real late PSI changes defer the declared combination, while bad CRC remains a hard input failure', async () => {
  const original = new Uint8Array(await readFile('fixtures/ts-analysis/h264-static.ts'));
  let found = -1, sectionStart = 0, sectionEnd = 0;
  for(let at=Math.floor(original.length/2/188)*188;at+188<=original.length;at+=188) {
    if(!(original[at+1]&64)||!(original[at+3]&16))continue;
    let pos=at+4;if(original[at+3]&32)pos+=1+original[pos];if(pos>=at+188)continue;
    pos+=1+original[pos];if(pos+3>=at+188||original[pos]!==2)continue;
    const end=pos+3+((original[pos+1]&15)*256+original[pos+2]);
    if(end<=at+188){found=at;sectionStart=pos;sectionEnd=end;break;}
  }
  assert.ok(found>=0,'actual PMT after the startup prefix');
  for(const badCrc of [false,true]) {
    const bytes=original.slice();bytes[sectionStart+5]^=2;
    let crc=0xffffffff;
    for(const b of bytes.subarray(sectionStart,sectionEnd-4)){crc^=b<<24;for(let i=0;i<8;i++)crc=(crc<<1)^(crc&0x80000000?0x04c11db7:0);}
    new DataView(bytes.buffer).setUint32(sectionEnd-4,(crc>>>0)^(badCrc?1:0));
    const worker=new Worker(new URL('../../src/media/decoding/packet-worker.ts',import.meta.url));
    const rpc=new WorkerRpc<PacketCommands>(worker as unknown as globalThis.Worker);
    try {
      const request=rpc.call('prepare-ts',{input:{file:new Blob([bytes])},sourceVersion:'psi-boundary'},[],60000);
      if(badCrc)await assert.rejects(request,/invalid PSI CRC/);
      else {const result=await request;assert.equal(result.admitted,false);if(!result.admitted)assert.match(result.reason,/program-map changes/);}
      await rpc.call('dispose',{});
    } finally {rpc.terminate();}
  }
});

test('native and software first-frame failures release each actual timeline decoder once', async () => {
  const {TsEngine}=await import('../../src/media/decoding/ts-engine.ts');
  const {MediaOpenError}=await import('../../shared/media/io/media-errors.ts');
  const bytes=await readFile('fixtures/ts-analysis/h264-static.ts');
  const closed={native:0,software:0};
  const failed=(name:'native'|'software'):import('../../src/media/decoding/flv-decoder.ts').PacketDecoder=>({
    kind:name==='native'?'webcodecs':'ffmpeg-wasm',reset(){},receive(){return null;},drain:async()=>{},
    async send(){throw new MediaOpenError('decode',`${name} first frame failed`);},close(){closed[name]++;},
  });
  const engine=new TsEngine({file:new Blob([bytes])},'failed-firsts',{
    native:async()=>failed('native'),software:async()=>failed('software'),
  });
  try {await assert.rejects(engine.open('unused-core',undefined,false),/software first frame failed/);}
  finally {engine.close();}
  assert.deepEqual(closed,{native:1,software:1});
  assert.equal(engine.packetIndex,undefined);assert.equal(engine.analysisIndex,undefined);
});

test('real Worker concurrent index requests reject during initialization and remain usable after ready and disposal', async () => {
  const {createServer}=await import('node:http');
  const bytes=await readFile('fixtures/ts-analysis/h264-static.ts');
  let release!:()=>void,entered!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const requested=new Promise<void>(resolve=>{entered=resolve;});
  const server=createServer(async(req,res)=>{
    entered();await gate;if(res.destroyed)return;
    const range=/^bytes=(\d+)-(\d+)$/.exec(req.headers.range??'');
    const start=range?Number(range[1]):0,end=range?Math.min(Number(range[2]),bytes.length-1):bytes.length-1;
    res.writeHead(range?206:200,{'content-length':end-start+1,'accept-ranges':'bytes',etag:'"ts-ready"',
      ...(range?{'content-range':`bytes ${start}-${end}/${bytes.length}`}:{})});res.end(bytes.subarray(start,end+1));
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const worker=new Worker(new URL('../../src/media/decoding/packet-worker.ts',import.meta.url));
  const rpc=new WorkerRpc<PacketCommands>(worker as unknown as globalThis.Worker);
  try {
    const init=rpc.call('init',{container:'ts',sourceVersion:'ready-race',input:{url:`http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/video`,size:bytes.length},
      forceWasm:true,glueURL:pathToFileURL(resolve('public/vendor/voidplayer-core/voidplayer-core.js')).href,
      wasmBinary:new Uint8Array(await readFile('public/vendor/voidplayer-core/voidplayer-core.wasm'))},[],60000);
    void init.catch(()=>{});
    let timer:ReturnType<typeof setTimeout>;
    try {await Promise.race([requested,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('HTTP gate was not entered')),1500);})]);}
    finally{clearTimeout(timer!);}
    const early=await Promise.allSettled([rpc.call('analysis-ts-index',{}),rpc.call('analysis-index',{})]);
    for(const result of early){assert.equal(result.status,'rejected');if(result.status==='rejected')assert.match(String(result.reason),/not ready/);}
    release();await init;
    assert.equal((await rpc.call('analysis-ts-index',{})).packets.length,600);
    assert.deepEqual(await rpc.call('analysis-index',{}),{packets:600,complete:true});
    await rpc.call('dispose',{});
    await assert.rejects(rpc.call('analysis-ts-index',{}),/未初始化/);
    await assert.rejects(rpc.call('analysis-index',{}),/未初始化/);
  } finally {release();rpc.terminate();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('native first-frame decode failure uses real packet WASM with the same verified JS index',async()=>{
  const {TsEngine}=await import('../../src/media/decoding/ts-engine.ts');
  const {MediaOpenError}=await import('../../shared/media/io/media-errors.ts');
  const bytes=await readFile('fixtures/ts-analysis/h264-static.ts');
  const directory=await mkdtemp(join(tmpdir(),'voidplayer-ts-native-failure-'));
  const glue=pathToFileURL(resolve('public/vendor/voidplayer-core/voidplayer-core.js')).href;
  const wrapper=join(directory,'packet-only.mjs');
  await writeFile(wrapper,`import load from ${JSON.stringify(glue)};export default async options=>{const core=await load(options);core._vp_open=()=>{throw Error('container demux forbidden');};return core;};`);
  let nativeClosed=0;
  const engine=new TsEngine({file:new Blob([bytes])},'native-failure-real-wasm',{
    native:async()=>({kind:'webcodecs',reset(){},receive(){return null;},drain:async()=>{},async send(){throw new MediaOpenError('decode','injected native decode failure');},close(){nativeClosed++;}}),
  });
  try {
    const index=await engine.prepare();
    const info=await engine.open(pathToFileURL(wrapper).href,new Uint8Array(await readFile('public/vendor/voidplayer-core/voidplayer-core.wasm')),false);
    assert.equal(info.decoder,'ffmpeg-wasm');assert.equal(nativeClosed,1);assert.equal(engine.packetIndex,index,'fallback retains the actual verified JS index');
    const frame=await engine.at(index.packets[200].ptsUs);
    assert.deepEqual(frame.packetPicture,{au:200,configuration:0,stream:tsPictureStream(index)});
    const position=index.packets.filter(p=>p.ptsUs<index.packets[200].ptsUs).length,expected=nativeFrames('fixtures/ts-analysis/h264-static.ts',[position],'yuv420p',1920*1080*3/2).get(position)!;
    assert.equal(visiblePixelHash(frame.description,frame.pixels!),nativeVisibleHash(frame.description,expected));frame.frame?.close();
  } finally {engine.close();await rm(directory,{recursive:true,force:true});}
});

// These use the actual product packet Worker and actual HTTP Range reads, not
// a fabricated progress heartbeat or the independent server index watchdog.
for(const mode of ['advancing','stalled'] as const)test(`product prepare-ts ${mode} Range scan retains a genuine progress-idle deadline`,{timeout:20000},async()=>{
  const {createServer}=await import('node:http');
  const bytes=mode==='advancing'?execFileSync('ffmpeg',['-v','error','-i','fixtures/video/h264_9s_1920x1080.mp4','-map','0:v:0','-an','-c:v','copy','-frames:v','128','-bsf:v','h264_mp4toannexb','-f','mpegts','pipe:1'],{maxBuffer:8*1024*1024}):await readFile('fixtures/ts-analysis/h264-static.ts');let requests=0;
  const server=createServer((req,res)=>{
    const match=/^bytes=(\d+)-(\d+)$/.exec(String(req.headers.range));assert.ok(match);
    const start=Number(match[1]),end=Math.min(Number(match[2]),bytes.length-1);requests++;
    if(mode==='stalled'&&requests>5)return;
    const timer=setTimeout(()=>{if(!res.destroyed){res.writeHead(206,{'content-range':`bytes ${start}-${end}/${bytes.length}`,'content-length':end-start+1});res.end(bytes.subarray(start,end+1));}},80);
    res.once('close',()=>clearTimeout(timer));
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const worker=new Worker(new URL('../../src/media/decoding/packet-worker.ts',import.meta.url));
  const rpc=new WorkerRpc<PacketCommands>(worker as unknown as globalThis.Worker);
  const advances:{wall:number;data:any}[]=[];worker.on('message',message=>{if(message.type==='index-progress')advances.push({wall:performance.now(),data:message.data});});
  await assert.rejects(rpc.call('analysis-index',{},[],2000),/not ready/);
  const started=performance.now(),idle=500;
  try{
    const pending=rpc.call('prepare-ts',{input:{url:`http://127.0.0.1:${(server.address() as {port:number}).port}/fixture.ts`,size:bytes.length},sourceVersion:`product-${mode}`},[],idle,true);
    if(mode==='advancing'){
      const result=await pending;assert.equal(result.admitted,true);if(result.admitted)assert.equal(result.index.packets.length,128);
      assert.ok(performance.now()-started>idle*2,'actual scan outlives at least two shortened idle periods');
      assert.ok(advances.length>=3);assert.equal(advances.at(-1)!.data.packets,128);
      assert.ok(advances.some(item=>item.data.scannedBytes===bytes.length));
      for(let i=1;i<advances.length;i++)assert.ok(advances[i].data.bytesRead>=advances[i-1].data.bytesRead,'reported IO is actual monotonic source work');
      await rpc.call('dispose',{});
    }else{
      await assert.rejects(pending,/prepare-ts.*超时/);assert.ok(requests>=2,'real Range request stalls after successful work');
      assert.ok(advances.some(item=>item.data.bytesRead>0),'failure follows real measured work');
      assert.ok(performance.now()-advances.at(-1)!.wall>=idle-20,'no periodic heartbeat renews a stalled reader');
      assert.equal(Reflect.get(rpc,'pending').size,0);await assert.rejects(rpc.call('analysis-ts-index',{}),/超时/);
    }
  }finally{rpc.terminate();await worker.terminate();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('product TS admission abort settles a genuinely held Range request and terminates its own worker',{timeout:10000},async()=>{
  const {createServer}=await import('node:http'),{admitTsMedia}=await import('../../src/media/decoding/ts-media.ts');
  const bytes=await readFile('fixtures/ts-analysis/h264-static.ts');let entered!:()=>void;const requested=new Promise<void>(resolve=>{entered=resolve;});
  const server=createServer(()=>entered());await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const worker=new Worker(new URL('../../src/media/decoding/packet-worker.ts',import.meta.url));const exited=once(worker,'exit');const abort=new AbortController();
  const pending=admitTsMedia({url:`http://127.0.0.1:${(server.address() as {port:number}).port}/held.ts`,size:bytes.length},{name:'held.ts',size:bytes.length,lastModified:0},'product-cancel',
    {signal:abort.signal,workerFactory:()=>worker as unknown as globalThis.Worker});void pending.catch(()=>{});
  try{
    let timer:ReturnType<typeof setTimeout>;try{await Promise.race([requested,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('held product request did not start')),1500);})]);}finally{clearTimeout(timer!);}
    abort.abort(new Error('cancel owned TS admission'));await assert.rejects(pending,/cancel owned TS admission/);
    let endedTimer:ReturnType<typeof setTimeout>;try{await Promise.race([exited,new Promise<never>((_,reject)=>{endedTimer=setTimeout(()=>reject(new Error('admission did not terminate its owned worker')),1500);})]);}finally{clearTimeout(endedTimer!);}
  }finally{abort.abort();await worker.terminate();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('actual product prepare-ts examines a second same-packet PMT section before any decoder initialization',async()=>{
  const original=new Uint8Array(await readFile('fixtures/ts-analysis/h264-static.ts'));
  let start=-1,end=0,packetAt=0;
  for(let at=0;at+188<=original.length;at+=188){
    if(!(original[at+1]&64)||!(original[at+3]&16))continue;
    let pos=at+4;if(original[at+3]&32)pos+=1+original[pos];if(pos>=at+188)continue;pos+=1+original[pos];
    if(pos+3>=at+188||original[pos]!==2)continue;
    const next=pos+3+((original[pos+1]&15)*256+original[pos+2]);
    if(next+(next-pos)<=at+188){start=pos;end=next;packetAt=at;break;}
  }
  assert.ok(start>=0,'real startup PMT has room for a second complete section');
  for(const mode of ['repeat','changed','crc','adaptation'] as const){
    const bytes=original.slice(),second=bytes.slice(start,end);
    if(mode==='changed'){
      second[5]^=2;let crc=0xffffffff;for(const b of second.subarray(0,-4)){crc^=b<<24;for(let bit=0;bit<8;bit++)crc=(crc<<1)^(crc&0x80000000?0x04c11db7:0);}
      new DataView(second.buffer).setUint32(second.length-4,crc>>>0);
    }else if(mode==='crc')second[second.length-1]^=1;
    bytes.set(second,end);
    if(mode==='adaptation'){bytes[packetAt+3]=(bytes[packetAt+3]&15)|0x30;bytes[packetAt+4]=184;}
    const worker=new Worker(new URL('../../src/media/decoding/packet-worker.ts',import.meta.url)),rpc=new WorkerRpc<PacketCommands>(worker as unknown as globalThis.Worker);
    try{
      const pending=rpc.call('prepare-ts',{input:{file:new Blob([bytes])},sourceVersion:`second-section-${mode}`},[],60000,true);
      if(mode==='crc'||mode==='adaptation')await assert.rejects(pending,mode==='crc'?/invalid PSI CRC/:/invalid PSI adaptation length/);
      else{const result=await pending;assert.equal(result.admitted,mode==='repeat');if(result.admitted)assert.equal(result.index.packets.length,600);else assert.match(result.reason,/program-map changes/);}
      await rpc.call('dispose',{});
    }finally{rpc.terminate();await worker.terminate();}
  }
});
