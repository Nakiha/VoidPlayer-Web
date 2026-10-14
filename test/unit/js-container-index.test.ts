import test from 'node:test';
import assert from 'node:assert/strict';
import {localJsSourceVersion,parseJsPacketIndex} from '../../src/js-packet-index-cache.ts';
import {jsDecodeIndex} from '../../src/js-decode-index.ts';
import {MATROSKA_PACKET_BUILD} from '../../src/matroska-packet-index.ts';
import {readContainerHeader,validateContainerHeader} from '../../src/bitstream-analysis/diagrams.ts';
import {inspectPacketPicture} from '../../src/packet-picture.ts';

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
