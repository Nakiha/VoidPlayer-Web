import assert from 'node:assert/strict';
import fs from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {TsPacketSource} from '../../../src/ts-packet-source.ts';
import type {TsPacketIndex} from '../../../src/ts-packet-index.ts';
export async function loadTsCore(playback=false) {
 const file=resolve(playback?'public/vendor/voidplayer-core/voidplayer-core.js':'public/vendor/voidplayer-analysis/voidplayer-analysis.js');
 return (await import(pathToFileURL(file).href)).default({wasmBinary:fs.readFileSync(file.replace(/\.js$/,'.wasm'))});
}
export async function tsFixture(name='h264-static.ts') {
 const bytes=fs.readFileSync('fixtures/ts-analysis/'+name),version='static-ts-fixture';
 const source=new TsPacketSource({size:bytes.length,async read(at,n){return bytes.subarray(at,at+n);},close(){}},version,new AbortController().signal);
 let index:TsPacketIndex;try{index=await source.open();}finally{source.close();}assert.equal(index.packets.length,600);
 const probe=JSON.parse(execFileSync('ffprobe',['-v','error','-select_streams','v:0','-show_entries','packet=pts_time,dts_time','-of','json','fixtures/ts-analysis/'+name],{encoding:'utf8',maxBuffer:16*1024*1024}));
 assert.deepEqual(index.packets.map(p=>p.ptsUs),probe.packets.map((p:any)=>Math.round(Number(p.pts_time)*1e6)),'native packet-clock oracle');
 const reader=(document:unknown=index)=>{
  let closed=false,actualBytes=0,reads=0,closes=0;
  return {size:bytes.length,jsIndex:async()=>document as TsPacketIndex,
   read:async(at:number,n:number)=>{assert.ok(!closed);actualBytes+=n;reads++;return bytes.subarray(at,at+n);},
   close(){closed=true;closes++;},get closed(){return closed;},get closes(){return closes;},get actualBytes(){return actualBytes;},get reads(){return reads;}};
 };
 return {bytes,index,reader,pts:(au:number)=>index.packets[au].ptsUs,close(){}};
}
