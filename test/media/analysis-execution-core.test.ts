import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {analyzePicture,analyzeRange,analyzeStream} from '../../shared/analysis/bitstream/runner.ts';
import {openAnalysisInput} from '../../shared/analysis/bitstream/input.ts';
import {countCore,emptyCounters} from '../../shared/analysis/bitstream/counters.ts';
import {RETRY_FULL} from '../../shared/analysis/bitstream/execution-error.ts';
import {createThreadedAnalysisCore} from '../../server/analysis/bitstream/core-memory.ts';
import {isProduct,readBlock} from '../../shared/analysis/bitstream/products.ts';
import type {AnalysisOutput} from '../../shared/analysis/bitstream/products.ts';
const manifest=JSON.parse(await readFile('public/vendor/voidplayer-analysis/manifest.json','utf8'));
const create=(await import(pathToFileURL(path.resolve('public/vendor/voidplayer-analysis/voidplayer-analysis.js')).href)).default;
const probe=await create(),extension=typeof probe._vpa_execution_abi==='function'&&probe._vpa_execution_abi()===1;probe._vpa_close();
const reader=(data:Uint8Array)=>({size:data.length,async read(at:number,n:number){assert.ok(at>=0&&n>=0&&at+n<=data.length);return data.slice(at,at+n);},close(){}});
const canonical=(r:AnalysisOutput)=>{const {metrics,...rest}=r;return rest;};
const assertMain10=(r:AnalysisOutput)=>{
 assert.equal(r.qp.bitDepth,10);assert.equal(r.capabilities.qp,'unsupported');assert.equal(r.qp.mean,null);assert.deepEqual(r.reasonCodes,['unsupported-qp-depth']);
 assert.equal(r.confidence,'exact');assert.equal(r.capabilities.blocks,'ready');assert.equal(r.capabilities.modes,'ready');assert.equal(r.capabilities.motion,'unsupported');
 if(isProduct(r)){if(r.product==='blocks'){const view=new DataView(r.payload);for(let i=0;i<r.validatedBlockCount;i++)assert.equal(readBlock(view,i).qp,null);}}
 else assert.ok(r.blocks.length>0&&r.blocks.every(b=>b.qp===null));
};
for(const name of ['normal','late-hash','late-grain','late-pps','main10','main10-late-hash','main10-late-grain','main10-late-pps','open-gop'] as const)
test(`HEVC summary ${name}: full incremental publication and same cached source identity`,async()=>{
 const data=await readFile(`fixtures/analysis-execution/${name}.mp4`),input=await openAnalysisInput(reader(data),new AbortController().signal),firstPtsUs=Math.min(...input.packets.map(p=>p.pts)),durationUs=input.sourceEndUs-firstPtsUs;
 const target={mode:'stream' as const,product:'summary' as const,sourceVersion:name,firstPtsUs,durationUs,window:{startUs:name==='open-gop'?1200000:100000,endUs:name==='open-gop'?1400000:300000,axis:'pts' as const}},cache=new Map<number,AnalysisOutput>();input.close();let expected:AnalysisOutput[]|undefined;
 for(const full of [true,false]){
  const counters=emptyCounters(),retry:{reason:number;visible:number}[]=[],outputs:AnalysisOutput[]=[];let firstDecoded=0;
  const factory=async()=>{const c=await create();if(full&&extension){const mode=c._vpa_execution_mode.bind(c);c._vpa_execution_mode=()=>mode(0);}
   for(const name of ['_vpa_feed','_vpa_feed_known','_vpa_step']){const call=c[name].bind(c);c[name]=(...args:any[])=>{const ret=call(...args);if(ret===RETRY_FULL)retry.push({reason:c._vpa_execution_reason(),visible:outputs.length});return ret;};}return countCore(c,counters);
  };
  await analyzeStream(reader(data),target,factory,manifest.buildId,new AbortController().signal,async r=>{if(!outputs.length)firstDecoded=counters.decodedAU;if(name.startsWith('main10'))assertMain10(r);outputs.push(r);if(!full)cache.set(r.picture.au,structuredClone(r));},async()=>{});
  if(full)expected=outputs;else{
   assert.ok(isDeepStrictEqual(outputs.map(canonical),expected!.map(canonical)),'all semantic fields and source/GOP identities');
   assert.equal(counters.fallback,0);assert.equal(counters.fastOpen,0);assert.equal(counters.stagedBytesPeak,0);
   assert.deepEqual(retry,[]);assert.equal(counters.open,1);assert.equal(counters.fullOpen,1);
   assert.ok(firstDecoded<counters.decodedAU,'first summary is visible before decoding completes, including reference preroll');
   assert.equal(new Set(outputs.map(r=>r.picture.au)).size,outputs.length);
  }
 }
 if(name==='normal')for(const window of [target.window,{...target.window,startUs:500000,endUs:700000}]){
  let covered=0;await analyzeStream(reader(data),{...target,window},()=>{throw Error('warm/moved request initialized decoder');},manifest.buildId,new AbortController().signal,async()=>{covered++;},async()=>{},undefined,async p=>cache.get(p.au)??null);assert.equal(covered,cache.size);
 }
});
test('legacy core ABI remains usable without opting into execution extension',async()=>{
 assert.equal(probe._vpa_abi(),1);assert.equal(probe._vpa_reference_abi(),1);
 if(extension){assert.equal(probe._vpa_execution_mode(0),0);assert.equal(probe._vpa_execution_path(),0);}
});
test('missing closed anchor is unsupported before allocating a decoder',async()=>{
 const data=await readFile('fixtures/analysis-execution/missing-anchor.mp4'),input=await openAnalysisInput(reader(data),new AbortController().signal),firstPtsUs=Math.min(...input.packets.map(p=>p.pts)),durationUs=input.sourceEndUs-firstPtsUs;input.close();
 await assert.rejects(analyzeStream(reader(data),{mode:'stream',product:'summary',sourceVersion:'missing-anchor',firstPtsUs,durationUs,window:{startUs:100000,endUs:300000,axis:'pts'}},()=>{throw Error('unsafe anchor allocated decoder');},manifest.buildId,new AbortController().signal,async()=>{throw Error('unsafe exact result escaped');},async()=>{}),error=>error instanceof Error&&'code' in error&&error.code==='no-safe-anchor-within-budget');
});
async function assertPreciseBlocks(name:string,au:number,fastOpen:number,reason:number|null) {
 const data=await readFile(`fixtures/analysis-execution/${name}.mp4`),input=await openAnalysisInput(reader(data),new AbortController().signal),packet=input.packets[au],picture=input.picture(packet,'exact-'+name),target={product:'blocks' as const,sourceVersion:'exact-'+name,sourcePtsUs:packet.pts,normalizedMediaUs:packet.pts-Math.min(...input.packets.map(p=>p.pts)),picture};input.close();let expected:AnalysisOutput|undefined,feeds=0;
 for(const full of [true,false]){const counters=emptyCounters(),retries:number[]=[],factory=async()=>{const c=await create(),mode=c._vpa_execution_mode.bind(c);if(full)c._vpa_execution_mode=()=>mode(0);
  for(const method of ['_vpa_feed','_vpa_feed_known','_vpa_step']){const call=c[method].bind(c);c[method]=(...args:any[])=>{const value=call(...args);if(value===RETRY_FULL)retries.push(c._vpa_execution_reason());return value;};}return countCore(c,counters);};
  const result=await analyzePicture(reader(data),target,factory,manifest.buildId,new AbortController().signal);
  if(name.startsWith('main10'))assertMain10(result);
  if(full){expected=result;feeds=counters.feed;}else{assert.ok(isDeepStrictEqual(canonical(result),canonical(expected!)),'complete target semantics including blocks, references and source identity');
   assert.equal(counters.fastOpen,fastOpen);assert.equal(counters.fallback,reason===null?0:1);assert.equal(counters.open,reason===null?1:2);assert.equal(counters.products,0,'publication belongs to the caller');assert.ok(counters.stagedBytesPeak<=32*1024*1024);assert.equal(result.picture.au,packet.au);
   if(reason===null){assert.equal(counters.feed,feeds);assert.ok(feeds>1);assert.deepEqual(retries,[]);}else{assert.ok(counters.feed>feeds);assert.deepEqual(retries,[reason]);}
  }
 }
}
for(const [name,reason,fastOpen] of [['normal',null,1],['late-hash',4,1],['late-grain',3,1],['late-pps',2,1],['main10',null,1],['main10-late-hash',4,1],['main10-late-grain',3,1],['main10-late-pps',2,1],['open-gop',null,0]] as const)
test(`HEVC precise blocks ${name}: same reference preroll and winning target`,{skip:!extension?'requires upstream execution ABI1; older pinned core remains full':false},()=>assertPreciseBlocks(name,name==='open-gop'?36:12,fastOpen,reason));
const vvcCases=[['vvc',null,1],['vvc-late-hash',4,1],['vvc-late-pps',null,1],['vvc-late-changed-pps',2,1],['vvc-late-grain',3,1]] as const;
for(const [name,reason,fastOpen] of vvcCases){
 const ready=existsSync(path.join('fixtures/analysis-execution',name+'.mp4'));
 test(`VVC precise blocks ${name}: same reference preroll and winning target`,{skip:!ready?'VVC fixtures require the synced h266 sample':!extension?'requires upstream execution ABI1; older pinned core remains full':false},()=>assertPreciseBlocks(name,12,fastOpen,reason));
}

for (const [name, fallback] of [
 ['vvc', 0], ['vvc-late-hash', 1], ['vvc-late-grain', 1], ['vvc-late-changed-pps', 1], ['main10', 0], ['normal', 1],
] as const) {
 const fixture = `fixtures/analysis-execution/${name}.mp4`;
 test(`Continuous blocks ${name}: publish only winning results`, { skip: !extension || !existsSync(fixture) }, async () => {
  const data = await readFile(fixture);
  const input = await openAnalysisInput(reader(data), new AbortController().signal);
  const firstPtsUs = Math.min(...input.packets.map(packet => packet.pts));
  const target = { mode: 'stream', product: 'blocks', sourceVersion: name, firstPtsUs, durationUs: input.sourceEndUs - firstPtsUs } as const;
  const count = input.packets.length;
  input.close();
  const run = async (full: boolean) => {
   const counters = emptyCounters(), output: AnalysisOutput[] = [];
   const core = countCore(await create(), counters);
   if (full) {
    const mode = core._vpa_execution_mode.bind(core);
    core._vpa_execution_mode = () => mode(0);
   }
   let firstDecoded = 0, progress = 0;
   await analyzeStream(reader(data), target, core, manifest.buildId, new AbortController().signal, async result => {
    if (!output.length) firstDecoded = counters.decodedAU;
    output.push(result);
   }, async state => {
    assert.equal(state.pictures, output.length);
    progress = state.pictures;
   }, undefined, async () => null);
   assert.equal(output.length, count);
   assert.equal(progress, count);
   assert.equal(new Set(output.map(result => result.picture.au)).size, count);
   return { counters, output, firstDecoded };
  };
  const full = await run(true), fast = await run(false);
  assert.deepEqual(fast.output.map(canonical), full.output.map(canonical));
  assert.ok(full.firstDecoded < count);
  assert.equal(fast.counters.fastOpen, 1);
  assert.equal(fast.counters.fallback, fallback);
  if (!fallback) {
   assert.equal(fast.firstDecoded, count);
   const cached = new Map(fast.output.map(result => [result.picture.au, result]));
   const delivered = new Set<number>();
   await analyzeStream(reader(data), target, () => { throw Error('Warm stream initialized decoder'); }, manifest.buildId,
    new AbortController().signal, async result => { delivered.add(result.picture.au); }, async () => {},
    undefined, async picture => cached.get(picture.au) ?? null);
   assert.equal(delivered.size, count);
  }
  else assert.equal(fast.counters.fullOpen, 1);
 });
}
test('a one-picture legacy range and a viewport with one missing blocks picture stay full',async()=>{
 const data=await readFile('fixtures/analysis-execution/normal.mp4'),input=await openAnalysisInput(reader(data),new AbortController().signal),packet=input.packets[12],firstPtsUs=Math.min(...input.packets.map(p=>p.pts)),durationUs=input.sourceEndUs-firstPtsUs;input.close();
 const cache=new Map<number,AnalysisOutput>(),target={mode:'stream' as const,product:'blocks' as const,sourceVersion:'one-miss',firstPtsUs,durationUs,window:{startUs:100000,endUs:200000,axis:'pts' as const}};
 await analyzeStream(reader(data),target,create,manifest.buildId,new AbortController().signal,async r=>{cache.set(r.picture.au,r);},async()=>{});const expected=cache.get(12);assert.ok(expected);cache.delete(12);
 const viewportCounters=emptyCounters(),delivered:AnalysisOutput[]=[];
 await analyzeStream(reader(data),target,async()=>countCore(await create(),viewportCounters),manifest.buildId,new AbortController().signal,async r=>{delivered.push(r);},async()=>{},undefined,async p=>cache.get(p.au)??null);
 assert.equal(viewportCounters.fastOpen,0);assert.equal(viewportCounters.fullOpen,1);assert.equal(viewportCounters.stagedBytesPeak,0);assert.equal(delivered.length,24);assert.ok(isDeepStrictEqual(canonical(delivered.find(r=>r.picture.au===12)!),canonical(expected!)));
 const rangeCounters=emptyCounters(),range:AnalysisOutput[]=[];
 await assert.rejects(analyzeRange(reader(data),{product:'blocks',sourceVersion:target.sourceVersion,firstPtsUs,startUs:packet.pts-firstPtsUs,endUs:packet.pts-firstPtsUs+1},()=>{throw Error('invalid range initialized decoder');},manifest.buildId,new AbortController().signal,async()=>{}),/Explicit analysis products require/);
 await analyzeRange(reader(data),{sourceVersion:target.sourceVersion,firstPtsUs,startUs:packet.pts-firstPtsUs,endUs:packet.pts-firstPtsUs+1},async()=>countCore(await create(),rangeCounters),manifest.buildId,new AbortController().signal,async r=>{range.push(r);});
 assert.equal(range.length,1);assert.equal(range[0].picture.au,12);assert.equal(rangeCounters.fastOpen,0);assert.equal(rangeCounters.fullOpen,1);assert.equal(rangeCounters.stagedBytesPeak,0);
 const legacyCounters=emptyCounters();await analyzePicture(reader(data),{sourceVersion:target.sourceVersion,sourcePtsUs:packet.pts,normalizedMediaUs:packet.pts-firstPtsUs},async()=>countCore(await create(),legacyCounters),manifest.buildId,new AbortController().signal);
 assert.equal(legacyCounters.fastOpen,0);assert.equal(legacyCounters.fullOpen,1);assert.equal(legacyCounters.stagedBytesPeak,0);
});

for (const [name, product, fallback] of [
 ['vvc-long', 'blocks', 0], ['vvc-long-late-hash', 'blocks', 1], ['vvc-late-hash', 'summary', 1],
] as const) {
 const fixture = `fixtures/analysis-execution/${name}.mp4`;
 test(`VVC progressive ${product} ${name}: verified prefix survives a full replay`, { skip: !extension || !existsSync(fixture) }, async () => {
  const data = await readFile(fixture), signal = new AbortController().signal;
  const input = await openAnalysisInput(reader(data), signal);
  const firstPtsUs = Math.min(...input.packets.map(packet => packet.pts)), count = input.packets.length;
  const target = { mode: 'stream', product, sourceVersion: name, firstPtsUs, durationUs: input.sourceEndUs - firstPtsUs } as const;
  input.close();
  if (product === 'blocks') assert.ok(count > 128);
  const run = async (full: boolean) => {
   const counters = emptyCounters(), outputs: AnalysisOutput[] = [];
   const core = countCore(await create(), counters);
   if (full) {
    const mode = core._vpa_execution_mode.bind(core);
    core._vpa_execution_mode = () => mode(0);
   }
   let firstDecoded = 0, previous = 0, visibleAtFallback = 0;
   for (const key of ['_vpa_feed', '_vpa_feed_known', '_vpa_step'] as const) {
    const call = core[key].bind(core);
    core[key] = (...args: any[]) => {
     const result = call(...args);
     if (result === RETRY_FULL) visibleAtFallback = outputs.length;
     return result;
    };
   }
   await analyzeStream(reader(data), target, core, manifest.buildId, signal, async result => {
    if (!outputs.length) firstDecoded = counters.decodedAU;
    outputs.push(result);
   }, async state => {
    assert.equal(state.pictures, outputs.length);
    assert.ok(state.pictures >= previous);
    previous = state.pictures;
   });
   assert.equal(outputs.length, count);
   assert.equal(new Set(outputs.map(row => row.picture.au)).size, count);
   assert.equal(previous, count);
   return { counters, outputs, firstDecoded, visibleAtFallback };
  };
  const fast = await run(false), full = await run(true);
  assert.equal(fast.counters.fastOpen, 1);
  assert.equal(fast.counters.fallback, fallback);
  assert.equal(fast.counters.stagedBytesPeak, 0);
  assert.ok(fast.firstDecoded < count);
  if (fallback) assert.ok(fast.visibleAtFallback > 0, 'the verified prefix was already visible when the decoder requested pixels');
  assert.deepEqual(fast.outputs.map(canonical), full.outputs.map(canonical));
 });
}

test('VVC server thread settings preserve progressive outputs through a late full replay', {
 skip: !existsSync('public/vendor/voidplayer-analysis/threading.json') ||
   !existsSync('fixtures/analysis-execution/vvc-long-late-hash.mp4'),
}, async () => {
 const data = await readFile('fixtures/analysis-execution/vvc-long-late-hash.mp4');
 const signal = new AbortController().signal;
 const input = await openAnalysisInput(reader(data), signal);
 const firstPtsUs = Math.min(...input.packets.map(packet => packet.pts));
 const count = input.packets.length;
 const target = { mode: 'stream', product: 'blocks', sourceVersion: 'vvc-threading',
  firstPtsUs, durationUs: input.sourceEndUs - firstPtsUs } as const;
 input.close();
 const stem = path.resolve('public/vendor/voidplayer-analysis/voidplayer-analysis-mt');
 const createThreaded = (await import(pathToFileURL(stem + '.js').href)).default;
 const wasmBinary = await readFile(stem + '.wasm');
 let expected: unknown;
 for (const [threads, contexts] of [[1, 1], [2, 2], [4, 2]]) {
  const core = await createThreadedAnalysisCore(createThreaded, wasmBinary, threads > 1 ? threads : 0);
  try {
   assert.equal(core._vpa_configure_threads(threads, contexts), 0);
   const initialHeap = core.HEAPU8, step = core._vpa_step.bind(core);
   let staleViewInjected = false;
   core._vpa_step = () => {
    const ret = step();
    // Reproduce a delayed main-runtime view update after real decoder growth.
    if (ret === 1 && core.HEAPU8.byteLength > initialHeap.byteLength) {
     core.HEAPU8 = initialHeap; staleViewInjected = true;
    }
    return ret;
   };
   const counters = emptyCounters(), outputs: AnalysisOutput[] = [];
   await analyzeStream(reader(data), target, countCore(core, counters), manifest.buildId, signal,
    async result => { outputs.push(result); }, async () => {});
   assert.equal(outputs.length, count);
   assert.equal(counters.fallback, 1);
   assert.equal(staleViewInjected, true, 'the real decoder crossed the initial shared-memory view');
   const ordered = outputs.sort((a, b) => a.picture.au - b.picture.au).map(canonical);
   if (threads === 1) expected = ordered;
   else assert.deepEqual(ordered, expected);
  } finally { core.PThread.terminateAllThreads(); }
 }
});

test('VVC viewport summaries use a private fast attempt with the same output as full', {
 skip: !extension || !existsSync('fixtures/analysis-execution/vvc.mp4'),
}, async () => {
 const data = await readFile('fixtures/analysis-execution/vvc.mp4'), signal = new AbortController().signal;
 const input = await openAnalysisInput(reader(data), signal);
 const firstPtsUs = Math.min(...input.packets.map(packet => packet.pts));
 const durationUs = input.sourceEndUs - firstPtsUs;
 input.close();
 const target = { mode: 'stream', product: 'summary', sourceVersion: 'vvc-viewport', firstPtsUs, durationUs,
  window: { startUs: 0, endUs: durationUs, axis: 'pts' } } as const;
 const run = async (full: boolean) => {
  const counters = emptyCounters(), outputs: AnalysisOutput[] = [];
  const core = countCore(await create(), counters);
  if (full) {
   const mode = core._vpa_execution_mode.bind(core);
   core._vpa_execution_mode = () => mode(0);
  }
  await analyzeStream(reader(data), target, core, manifest.buildId, signal, async result => { outputs.push(result); }, async () => {});
  return { counters, outputs };
 };
 const fast = await run(false), full = await run(true);
 assert.ok(fast.counters.fastOpen > 0);
 assert.equal(fast.counters.fallback, 0);
 assert.ok(fast.outputs.length > 0);
 assert.deepEqual(fast.outputs.map(canonical), full.outputs.map(canonical));
});

test('H264 retains incremental GOP summaries, exact QP/refs and cache-only reuse',async()=>{
 const data=await readFile('fixtures/analysis-execution/h264.mp4'),input=await openAnalysisInput(reader(data),new AbortController().signal),firstPtsUs=Math.min(...input.packets.map(p=>p.pts)),durationUs=input.sourceEndUs-firstPtsUs,packet=input.packets[12],picture=input.picture(packet,'h264');input.close();
 const target={mode:'stream' as const,product:'summary' as const,sourceVersion:'h264',firstPtsUs,durationUs,window:{startUs:100000,endUs:300000,axis:'pts' as const}},cache=new Map<number,AnalysisOutput>(),counters=emptyCounters();let firstDecoded=0;
 await analyzeStream(reader(data),target,async()=>countCore(await create(),counters),manifest.buildId,new AbortController().signal,async r=>{if(!cache.size)firstDecoded=counters.decodedAU;cache.set(r.picture.au,r);},async()=>{});
 assert.equal(cache.size,24);assert.ok(firstDecoded<counters.decodedAU);assert.equal(counters.fullOpen,1);assert.equal(counters.fastOpen,0);assert.equal(counters.fallback,0);assert.equal(counters.stagedBytesPeak,0);
 await analyzeStream(reader(data),target,()=>{throw Error('warm H264 GOP initialized decoder');},manifest.buildId,new AbortController().signal,async()=>{},async()=>{},undefined,async p=>cache.get(p.au)??null);
 const exactCounters=emptyCounters(),result=await analyzePicture(reader(data),{product:'blocks',sourceVersion:'h264',sourcePtsUs:packet.pts,normalizedMediaUs:packet.pts-firstPtsUs,picture},async()=>countCore(await create(),exactCounters),manifest.buildId,new AbortController().signal);
 assert.equal(result.product,'blocks');assert.equal(result.confidence,'exact');assert.equal(result.capabilities.qp,'ready');assert.equal(result.qp.bitDepth,8);assert.equal(result.qp.mean,cache.get(12)!.qp.mean);assert.deepEqual(result.references,cache.get(12)!.references);assert.equal(result.picture.au,12);assert.equal(exactCounters.fullOpen,1);assert.equal(exactCounters.fastOpen,0);assert.equal(exactCounters.fallback,0);assert.equal(exactCounters.stagedBytesPeak,0);
});

async function disposeThreadedCore(core: any) {
  core._vpa_close();
  const workers = [...new Set([
    ...(core.PThread.unusedWorkers ?? []), ...Object.values(core.PThread.pthreads ?? {}).map((entry: any) => entry.worker),
  ])];
  const stopped = Promise.all(workers.map((worker: any) => new Promise<void>(resolve => {
    if (worker.threadId === -1) resolve();
    else worker.once('exit', resolve);
  })));
  core.PThread.terminateAllThreads();
  await stopped;
}

test('H264 frame contexts preserve every source AU and block across thread budgets and cancellation', async () => {
  const data = await readFile('fixtures/analysis-execution/h264.mp4'), signal = new AbortController().signal;
  const input = await openAnalysisInput(reader(data), signal), firstPtsUs = Math.min(...input.packets.map(packet => packet.pts));
  const target = {mode: 'stream', product: 'blocks', sourceVersion: 'h264-thread-contexts', firstPtsUs,
    durationUs: input.sourceEndUs - firstPtsUs} as const;
  const count = input.packets.length;
  input.close();
  const expected: AnalysisOutput[] = [];
  await analyzeStream(reader(data), target, create, manifest.buildId, signal, async result => { expected.push(result); }, async () => {});
  const stem = path.resolve('public/vendor/voidplayer-analysis/voidplayer-analysis-mt');
  const factory = (await import(pathToFileURL(stem + '.js').href)).default, binary = await readFile(stem + '.wasm');
  const ordered = (outputs: AnalysisOutput[]) => outputs.sort((a, b) => a.picture.au - b.picture.au).map(canonical);
  for (const [threads, contexts] of [[1, 1], [2, 1], [2, 2], [4, 2], [4, 4]]) {
    const core = await createThreadedAnalysisCore(factory, binary, threads > 1 ? threads : 0);
    try {
      assert.equal(core._vpa_configure_threads(threads, contexts), 0);
      const outputs: AnalysisOutput[] = [];
      await analyzeStream(reader(data), target, core, manifest.buildId, signal, async result => { outputs.push(result); }, async () => {});
      assert.equal(outputs.length, count);
      assert.deepEqual(ordered(outputs), ordered(expected));
      assert.equal(core._vpa_record_bytes(), 0);
    } finally {
      await disposeThreadedCore(core);
    }
  }
  const core = await createThreadedAnalysisCore(factory, binary, 2), controller = new AbortController();
  try {
    assert.equal(core._vpa_configure_threads(2, 2), 0);
    let outputs = 0;
    await assert.rejects(analyzeStream(reader(data), target, core, manifest.buildId, controller.signal, async () => {
      if (++outputs === 2) controller.abort();
    }, async () => {}), {name: 'AbortError'});
    assert.equal(outputs, 2, 'cancellation cannot publish another queued frame');
    assert.equal(core._vpa_record_bytes(), 0, 'cancelled frame contexts release their records');
  } finally {
    await disposeThreadedCore(core);
  }
});
