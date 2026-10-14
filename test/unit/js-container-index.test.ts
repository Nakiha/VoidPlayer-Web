import test from 'node:test';
import assert from 'node:assert/strict';
import {localJsSourceVersion,parseJsPacketIndex} from '../../src/js-packet-index-cache.ts';
import {jsDecodeIndex} from '../../src/js-decode-index.ts';
import {MATROSKA_PACKET_BUILD} from '../../src/matroska-packet-index.ts';
import {readContainerHeader,validateContainerHeader} from '../../src/bitstream-analysis/diagrams.ts';
import {inspectPacketPicture} from '../../src/packet-picture.ts';
import {matroskaClocks} from '../../src/matroska-clocks.ts';
import {TsCombinationNotMigrated} from '../../src/ts-packet-source.ts';

const ebml=(id:string,...parts:Uint8Array[])=>{const data=Buffer.concat(parts);assert.ok(data.length<127);return Buffer.concat([Buffer.from(id,'hex'),Buffer.from([0x80|data.length]),data]);};
const block=(flags=0,track=1)=>Buffer.from([0x80|track,0,0,flags,0x82,0]);
const clocksFor=(...blocks:Uint8Array[])=>{
 const bytes=ebml('18538067',ebml('1654ae6b',ebml('ae',ebml('d7',Buffer.from([1])),ebml('83',Buffer.from([1])))),ebml('1f43b675',ebml('e7',Buffer.from([0])),...blocks));
 return matroskaClocks({size:bytes.length,async read(at,n){return bytes.subarray(at,at+n);},close(){}},1,new AbortController().signal);
};
for(const group of [false,true])test(`Matroska ${group?'BlockGroup':'SimpleBlock'} invisible video cannot become a presented picture`,async()=>{
 await assert.rejects(clocksFor(group?ebml('a0',ebml('a1',block(8))):ebml('a3',block(8))),TsCombinationNotMigrated);
});
for(const [name,member] of [
 ['discard-padding',ebml('75a2',Buffer.from([1]))],
 ['virtual-reference',ebml('fd',Buffer.from([1]))],
 ['virtual-block',ebml('a2',block())],
 ['time-slices',ebml('8e',ebml('e8',ebml('cd',Buffer.from([2]))))],
] as const)test(`Matroska selected-video BlockGroup ${name} requires explicit admission`,async()=>{
 await assert.rejects(clocksFor(ebml('a0',member,ebml('a1',block()))),TsCombinationNotMigrated);
});
test('Matroska ordinary references/discardable pictures remain valid, and audio transforms do not reject video',async()=>{
 const clocks=await clocksFor(ebml('a0',ebml('a1',block()),ebml('fb',Buffer.from([0xff])),ebml('9b',Buffer.from([33])),ebml('75a2',Buffer.from([0]))),ebml('a3',block(0x81)),ebml('a0',ebml('a1',block(0,2)),ebml('75a2',Buffer.from([1]))));
 assert.equal(clocks.size,2);
});
test('Matroska visible reference Block accepts UNU bit0=1 while high reserved bits remain invalid',async()=>{
 const clocks=await clocksFor(ebml('a0',ebml('a1',block(1)),ebml('fb',Buffer.from([0xff]))));assert.equal(clocks.size,1);
 await assert.rejects(clocksFor(ebml('a0',ebml('a1',block(0x10)),ebml('fb',Buffer.from([0xff])))),/reserved video block flags/);
});

test('local JS identity covers every byte, is independent of read cursors and bounds each allocation',async()=>{
 const bytes=new Uint8Array(2*1024*1024+19),reads:number[]=[];
 const version=()=>localJsSourceVersion({size:bytes.length,async read(at,n){reads.push(n);return bytes.slice(at,at+n);}},new AbortController().signal);
 const first=await version();assert.equal(await version(),first);bytes[1024*1024+123]=1;assert.notEqual(await version(),first,'middle changes cannot reuse a source identity based only on metadata or edge samples');
 assert.ok(reads.every(n=>n<=1024*1024));assert.equal(reads.length,9);
});
test('source identity cancellation does not await a held read or create exact metadata',async()=>{
 const controller=new AbortController();let resolve!:(b:Uint8Array)=>void;
 const pending=localJsSourceVersion({size:128,read:()=>new Promise(r=>resolve=r)},controller.signal);controller.abort();
 await assert.rejects(pending,{name:'AbortError'});resolve(new Uint8Array(128));
});
test('a structurally valid serialized Matroska index cannot mint decode identities by claiming completeness',()=>{
 const doc={schema:1,kind:'js-matroska-packets',build:MATROSKA_PACKET_BUILD,sourceVersion:'source',size:1024,streamKey:'video:0',pid:1,codec:'vp8',configuration:[],completeness:{state:'complete',packets:2},packets:[0,1].map(au=>({au,locator:200+au,configuration:0,blockOffset:300+au*100,timestamp:au/10,ptsUs:au*100000,durationUs:100000,size:20,key:au===0,timing:{pts:au*100,dts:null,timebase:[1000000,1000000000],origin:'matroska-block'}}))};
 const parsed=parseJsPacketIndex(doc,'source',1024);assert.ok(parsed);assert.throws(()=>jsDecodeIndex(parsed),/Unverified complete/);
 const fake=structuredClone(doc);fake.packets.pop();fake.completeness.packets=1;const partial=parseJsPacketIndex(fake,'source',1024);assert.ok(partial);assert.throws(()=>jsDecodeIndex(partial),/Unverified complete/,'self-consistent truncation still has no scan authority');
 const wrong=structuredClone(doc);wrong.packets[0].timing.dts=0 as unknown as null;assert.equal(parseJsPacketIndex(wrong,'source',1024),undefined,'Matroska cannot invent a raw DTS field');
 assert.equal(parseJsPacketIndex({...doc,build:'old-js-build'},'source',1024),undefined);assert.equal(parseJsPacketIndex(doc,'other-source',1024),undefined);
 assert.equal(parseJsPacketIndex({...doc,build:'mediabunny-1.55.7-matroska-packets-v2'},'source',1024),undefined,'pre-Invisible-admission cache must rebuild');
});
test('HEVC Annex-B configuration stays Annex-B in diagram/cache validation',()=>{
 const configuration=Uint8Array.from([0,0,0,1,64,1,0,0,0,1,66,1,0,0,0,1,68,1]);
 const header=readContainerHeader('hevc',configuration);assert.equal(header.box,'annexb');assert.deepEqual(header.nalus.map(n=>n.type),[32,33,34]);validateContainerHeader('hevc',header);
 assert.throws(()=>readContainerHeader('hevc',Uint8Array.of(2,0,0)),/hvcC/);
});
test('VP8/VP9 admission rejects hidden, show-existing and multiple-output superframes',()=>{
 assert.equal(inspectPacketPicture('vp8',new Uint8Array(),Uint8Array.of(0,0,0)).singlePicture,false);
 assert.equal(inspectPacketPicture('vp9',new Uint8Array(),Uint8Array.of(0x88,0)).singlePicture,false);
 assert.equal(inspectPacketPicture('vp9',new Uint8Array(),Uint8Array.of(0x84,0)).singlePicture,false);
 const superframe=Uint8Array.of(0x82,0,0,0xc1,1,2,0xc1);assert.equal(inspectPacketPicture('vp9',new Uint8Array(),superframe).reason,'unsupported-vp9-superframe');
});
