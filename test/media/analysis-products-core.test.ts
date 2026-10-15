import {test} from 'node:test';
import assert from 'node:assert/strict';
import {open,readFile} from 'node:fs/promises';
import {analyzeStream} from '../../src/bitstream-analysis/runner.ts';
import {openAnalysisInput} from '../../src/bitstream-analysis/input.ts';
import {summaryOf,packLegacy,validateProduct,legacyOf} from '../../src/bitstream-analysis/products.ts';
import type {AnalysisOutput,AnalysisBlocks,AnalysisSummary} from '../../src/bitstream-analysis/products.ts';
import {DiagramStore} from '../../src/bitstream-analysis/diagrams.ts';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
const manifest=JSON.parse(await readFile('public/vendor/voidplayer-analysis/manifest.json','utf8'));
const factory=(await import(pathToFileURL(resolve('public/vendor/voidplayer-analysis/voidplayer-analysis.js')).href)).default;
async function reader(name:string){const file=await open(resolve('fixtures/video',name));const {size}=await file.stat();return {size,async read(offset:number,length:number){const bytes=new Uint8Array(length);assert.equal((await file.read(bytes,0,length,offset)).bytesRead,length);return bytes;},close(){void file.close();}};}
const canonical=(value:unknown)=>JSON.parse(JSON.stringify(value, (key,v)=>key==='elapsedMs'?undefined:v));
for(const [name,startUs,endUs,expected] of [['mhw_hevc_fullrange_bt709_3s.mp4',500000,700000,180],['h264_9s_1920x1080.mp4',500000,700000,30],['h266_10s_1920x1080.mp4',0,10000,49]] as const)
test(`products ${name}: exact fields, summary queries, warm zero decoder`,async()=>{
 const input=await openAnalysisInput(await reader(name),new AbortController().signal), firstPtsUs=Math.min(...input.packets.map(p=>p.pts)),durationUs=input.sourceEndUs-firstPtsUs;input.close();
 const target={mode:'stream' as const,sourceVersion:name,firstPtsUs,durationUs,window:{startUs,endUs,axis:'pts' as const}},oracle=new Map<number,AnalysisBlocks>(),original=new DiagramStore(),projected=new DiagramStore();
 await analyzeStream(await reader(name),target,factory,manifest.buildId,new AbortController().signal,async result=>{oracle.set(result.picture.au,packLegacy(result));original.put(result);},async()=>{});
 if(name.startsWith('h264_'))assert.deepEqual(oracle.values().next().value!.sourceLayout,{provenance:'configuration-sps-v1',configuration:0,codedWidth:1920,codedHeight:1088,visibleRect:{x:0,y:0,width:1920,height:1080}});
 let bytes=0,products=0;
 await analyzeStream(await reader(name),{...target,product:'summary'},factory,manifest.buildId,new AbortController().signal,async(result:AnalysisOutput)=>{
  assert.ok('product' in result && result.product==='summary');validateProduct(result);assert.deepEqual(canonical(result),canonical(summaryOf(oracle.get(result.picture.au)!)));projected.putSummary(result);bytes+=Buffer.byteLength(JSON.stringify(result));products++;
 },async()=>{});
 assert.equal(products,expected);if(expected===180)assert.ok(bytes<=512*1024);
 for(const axis of ['pts','dts'] as const)for(const width of [64,1024])for(const [a,b] of [[-100000,10000000],[500000,700000],[1500000,1700000]])assert.deepEqual(projected.queryChart(name,a,b,width,axis),original.queryChart(name,a,b,width,axis));
 for(const anchor of [null,0,1,10,48])assert.deepEqual(projected.query(name,anchor,500000),original.query(name,anchor,500000));
 const summaries=new Map<number,AnalysisSummary>();for(const au of oracle.keys()){const summary=projected.summaryAt(name,au);assert.ok(summary);summaries.set(au,summary);}
 let warm=0;await analyzeStream(await reader(name),{...target,product:'summary'},()=>{throw Error('warm request initialized decoder');},manifest.buildId,new AbortController().signal,async()=>{warm++;},async()=>{},undefined,async p=>summaries.get(p.au)??null);assert.equal(warm,expected);
 let packedBytes=0;
 await analyzeStream(await reader(name),{...target,product:'blocks'},factory,manifest.buildId,new AbortController().signal,async(result:AnalysisOutput)=>{assert.ok('product' in result && result.product==='blocks');validateProduct(result);assert.deepEqual(new Uint8Array(result.payload),new Uint8Array(oracle.get(result.picture.au)!.payload));assert.deepEqual(canonical(legacyOf(result)),canonical(legacyOf(oracle.get(result.picture.au)!)));packedBytes+=result.payload.byteLength+Buffer.byteLength(JSON.stringify({...result,payload:undefined}))+40;},async()=>{});
 if(expected===180)assert.ok(packedBytes<=50*1024*1024);
});
