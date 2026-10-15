import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {analyzePicture,analyzeStream} from '../../src/bitstream-analysis/runner.ts';
import {openAnalysisInput} from '../../src/bitstream-analysis/input.ts';
import {countCore,emptyCounters} from '../../src/bitstream-analysis/counters.ts';
import {RETRY_FULL} from '../../src/bitstream-analysis/execution-error.ts';
import type {AnalysisOutput} from '../../src/bitstream-analysis/products.ts';
const manifest=JSON.parse(await readFile('public/vendor/voidplayer-analysis/manifest.json','utf8'));
const create=(await import(pathToFileURL(path.resolve('public/vendor/voidplayer-analysis/voidplayer-analysis.js')).href)).default;
const probe=await create(),extension=typeof probe._vpa_execution_abi==='function'&&probe._vpa_execution_abi()===1;probe._vpa_close();
const reader=(data:Uint8Array)=>({size:data.length,async read(at:number,n:number){assert.ok(at>=0&&n>=0&&at+n<=data.length);return data.slice(at,at+n);},close(){}});
const canonical=(r:AnalysisOutput)=>{const {metrics,...rest}=r;return rest;};
for(const [name,reason,pathExpected] of [['normal',null,1],['late-hash',4,1],['late-grain',3,1],['late-pps',2,1],['main10',null,0],['open-gop',null,0]] as const)
test(`HEVC execution ${name}: winning records, no leaked retry prefix, same cached source identity`,{skip:!extension?'requires upstream execution ABI1; older pinned core remains full':false},async()=>{
 const data=await readFile(`fixtures/analysis-execution/${name}.mp4`),input=await openAnalysisInput(reader(data),new AbortController().signal),firstPtsUs=Math.min(...input.packets.map(p=>p.pts)),durationUs=input.sourceEndUs-firstPtsUs;
 const target={mode:'stream' as const,product:'summary' as const,sourceVersion:name,firstPtsUs,durationUs,window:{startUs:name==='open-gop'?1200000:100000,endUs:name==='open-gop'?1400000:300000,axis:'pts' as const}},cache=new Map<number,AnalysisOutput>();input.close();let expected:AnalysisOutput[]|undefined;
 for(const full of [true,false]){
  const counters=emptyCounters(),retry:{reason:number;visible:number}[]=[],outputs:AnalysisOutput[]=[];
  const factory=async()=>{const c=await create(),mode=c._vpa_execution_mode.bind(c);if(full)c._vpa_execution_mode=()=>mode(0);
   for(const name of ['_vpa_feed','_vpa_feed_known','_vpa_step']){const call=c[name].bind(c);c[name]=(...args:any[])=>{const ret=call(...args);if(ret===RETRY_FULL)retry.push({reason:c._vpa_execution_reason(),visible:outputs.length});return ret;};}return countCore(c,counters);
  };
  await analyzeStream(reader(data),target,factory,manifest.buildId,new AbortController().signal,async r=>{outputs.push(r);if(!full)cache.set(r.picture.au,structuredClone(r));},async()=>{});
  if(full)expected=outputs;else{
   assert.ok(isDeepStrictEqual(outputs.map(canonical),expected!.map(canonical)),'all semantic fields and source/GOP identities');
   assert.equal(counters.fallback,reason===null?0:1);assert.equal(counters.fastOpen,pathExpected);assert.ok(counters.stagedBytesPeak<=32*1024*1024);
   if(reason!==null){assert.deepEqual(retry,[{reason,visible:0}]);assert.equal(counters.open,2);}else assert.equal(counters.open,1);
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
test('precise frame keeps full reference preroll, commits one target and matches full output',{skip:!extension},async()=>{
 const data=await readFile('fixtures/analysis-execution/normal.mp4'),input=await openAnalysisInput(reader(data),new AbortController().signal),packet=input.packets[12],picture=input.picture(packet,'exact'),target={product:'blocks' as const,sourceVersion:'exact',sourcePtsUs:packet.pts,normalizedMediaUs:500000,picture};input.close();let expected:AnalysisOutput|undefined,feeds=0;
 for(const full of [true,false]){const counters=emptyCounters(),factory=async()=>{const c=await create(),mode=c._vpa_execution_mode.bind(c);if(full)c._vpa_execution_mode=()=>mode(0);return countCore(c,counters);};
  const result=await analyzePicture(reader(data),target,factory,manifest.buildId,new AbortController().signal);
  if(full){expected=result;feeds=counters.feed;}else{assert.ok(isDeepStrictEqual(canonical(result),canonical(expected!)));assert.equal(counters.feed,feeds);assert.ok(feeds>1);assert.equal(counters.fastOpen,1);assert.equal(counters.fallback,0);assert.equal(result.picture.au,12);}
 }
});
