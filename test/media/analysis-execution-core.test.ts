import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {analyzePicture,analyzeRange,analyzeStream} from '../../shared/analysis/bitstream/runner.ts';
import {openAnalysisInput} from '../../shared/analysis/bitstream/input.ts';
import {countCore,emptyCounters} from '../../shared/analysis/bitstream/counters.ts';
import {RETRY_FULL} from '../../shared/analysis/bitstream/execution-error.ts';
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
for(const [name,reason,fastOpen] of [['normal',null,1],['late-hash',4,1],['late-grain',3,1],['late-pps',2,1],['main10',null,1],['main10-late-hash',4,1],['main10-late-grain',3,1],['main10-late-pps',2,1],['open-gop',null,0]] as const)
test(`HEVC precise blocks ${name}: same reference preroll and winning target`,{skip:!extension?'requires upstream execution ABI1; older pinned core remains full':false},async()=>{
 const data=await readFile(`fixtures/analysis-execution/${name}.mp4`),input=await openAnalysisInput(reader(data),new AbortController().signal),packet=input.packets[name==='open-gop'?36:12],picture=input.picture(packet,'exact-'+name),target={product:'blocks' as const,sourceVersion:'exact-'+name,sourcePtsUs:packet.pts,normalizedMediaUs:packet.pts-Math.min(...input.packets.map(p=>p.pts)),picture};input.close();let expected:AnalysisOutput|undefined,feeds=0;
 for(const full of [true,false]){const counters=emptyCounters(),retries:number[]=[],factory=async()=>{const c=await create(),mode=c._vpa_execution_mode.bind(c);if(full)c._vpa_execution_mode=()=>mode(0);
  for(const method of ['_vpa_feed','_vpa_feed_known','_vpa_step']){const call=c[method].bind(c);c[method]=(...args:any[])=>{const value=call(...args);if(value===RETRY_FULL)retries.push(c._vpa_execution_reason());return value;};}return countCore(c,counters);};
  const result=await analyzePicture(reader(data),target,factory,manifest.buildId,new AbortController().signal);
  if(name.startsWith('main10'))assertMain10(result);
  if(full){expected=result;feeds=counters.feed;}else{assert.ok(isDeepStrictEqual(canonical(result),canonical(expected!)),'complete target semantics including blocks, references and source identity');
   assert.equal(counters.fastOpen,fastOpen);assert.equal(counters.fallback,reason===null?0:1);assert.equal(counters.open,reason===null?1:2);assert.equal(counters.products,0,'publication belongs to the caller');assert.ok(counters.stagedBytesPeak<=32*1024*1024);assert.equal(result.picture.au,packet.au);
   if(reason===null){assert.equal(counters.feed,feeds);assert.ok(feeds>1);assert.deepEqual(retries,[]);}else{assert.ok(counters.feed>feeds);assert.deepEqual(retries,[reason]);}
  }
 }
});
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

test('H264 retains incremental GOP summaries, exact QP/refs and cache-only reuse',async()=>{
 const data=await readFile('fixtures/analysis-execution/h264.mp4'),input=await openAnalysisInput(reader(data),new AbortController().signal),firstPtsUs=Math.min(...input.packets.map(p=>p.pts)),durationUs=input.sourceEndUs-firstPtsUs,packet=input.packets[12],picture=input.picture(packet,'h264');input.close();
 const target={mode:'stream' as const,product:'summary' as const,sourceVersion:'h264',firstPtsUs,durationUs,window:{startUs:100000,endUs:300000,axis:'pts' as const}},cache=new Map<number,AnalysisOutput>(),counters=emptyCounters();let firstDecoded=0;
 await analyzeStream(reader(data),target,async()=>countCore(await create(),counters),manifest.buildId,new AbortController().signal,async r=>{if(!cache.size)firstDecoded=counters.decodedAU;cache.set(r.picture.au,r);},async()=>{});
 assert.equal(cache.size,24);assert.ok(firstDecoded<counters.decodedAU);assert.equal(counters.fullOpen,1);assert.equal(counters.fastOpen,0);assert.equal(counters.fallback,0);assert.equal(counters.stagedBytesPeak,0);
 await analyzeStream(reader(data),target,()=>{throw Error('warm H264 GOP initialized decoder');},manifest.buildId,new AbortController().signal,async()=>{},async()=>{},undefined,async p=>cache.get(p.au)??null);
 const exactCounters=emptyCounters(),result=await analyzePicture(reader(data),{product:'blocks',sourceVersion:'h264',sourcePtsUs:packet.pts,normalizedMediaUs:packet.pts-firstPtsUs,picture},async()=>countCore(await create(),exactCounters),manifest.buildId,new AbortController().signal);
 assert.equal(result.product,'blocks');assert.equal(result.confidence,'exact');assert.equal(result.capabilities.qp,'ready');assert.equal(result.qp.bitDepth,8);assert.equal(result.qp.mean,cache.get(12)!.qp.mean);assert.deepEqual(result.references,cache.get(12)!.references);assert.equal(result.picture.au,12);assert.equal(exactCounters.fullOpen,1);assert.equal(exactCounters.fastOpen,0);assert.equal(exactCounters.fallback,0);assert.equal(exactCounters.stagedBytesPeak,0);
});
