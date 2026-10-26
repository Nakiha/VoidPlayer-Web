import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {createHash} from 'node:crypto';
import {probeMedia} from '../../shared/media/probe.ts';
import {scanFlv} from '../../shared/media/containers/flv-demux.ts';
import {evaluateDiscovery,DISCOVERY_LIMITS} from '../../shared/media/discovery.ts';
const fixtures=JSON.parse(await readFile(new URL('../helpers/library-discovery-samples.json',import.meta.url),'utf8'));
test('bounded technical parser agrees with fixed FFprobe source metadata for real FLV/MP4/Matroska/TS 8/10-bit and multitrack files',async()=>{
 for(const sample of fixtures.samples){const bytes=Buffer.from(sample.bytes,'base64');assert.equal(createHash('sha256').update(bytes).digest('hex'),sample.sha256);
  const result=await probeMedia({id:'a'.repeat(24),version:'b'.repeat(24)},bytes.length,async(offset,length)=>bytes.subarray(offset,offset+length),()=>{});
  const video=result.streams.find(s=>s.type==='video')!,oracle=sample.oracle.streams.find((s:any)=>s.type==='video');assert.ok(video,sample.name);
  assert.equal(video.fields.codec.value,oracle.codec,sample.name);assert.equal(video.fields.width.value,oracle.width,sample.name);assert.equal(video.fields.height.value,oracle.height,sample.name);
  assert.equal(video.fields.bitDepth.value,sample.depth,sample.name);assert.equal(video.fields.pixelFormat.value,sample.depth===8?'yuv420p':'yuv420p10',sample.name);
  assert.equal(video.clock.relationToQualityAu,'not-established');assert.equal(video.clock.origin,null);assert.equal(result.coverage.decodedPictures,false);
  assert.ok(result.coverage.bytesRead<=4*1024*1024);assert.ok(result.coverage.readCalls<=512);
  const [num,den]=oracle.timeBase.split('/').map(Number);assert.deepEqual(video.clock.timeBase,{numerator:num,denominator:den},sample.name);
  if(sample.name.endsWith('.flv')){assert.equal(result.streamInventoryComplete,false);assert.equal(result.coverage.scope,'bounded-container-prefix');}
  else if(sample.tagged){assert.equal(video.fields.colorTransfer.value,oracle.colorTransfer,sample.name);assert.equal(video.fields.colorPrimaries.value,oracle.colorPrimaries,sample.name);assert.equal(video.fields.colorMatrix.value,oracle.colorMatrix,sample.name);}
  else{assert.equal(oracle.colorTransfer,null);assert.equal(video.fields.colorTransfer.value,null,'no guessed color for untagged MP4');assert.equal(video.fields.colorTransfer.status,'unknown');}
  if(sample.multitrack){assert.equal(result.streamInventoryComplete,true,sample.name);assert.equal(result.inventory?.declaredTrackCount,3);assert.equal(result.streams.length,sample.oracle.streams.length);assert.deepEqual(result.streams.map(s=>s.type).sort(),['audio','subtitle','video']);}
 }
});
test('FLV prefix observes real audio without searching all tags, and leaves absent or late video unknown',async()=>{
 const source={id:'a'.repeat(24),version:'b'.repeat(24)};
 const observe=async(bytes:Buffer)=>{let calls=0,maxEnd=0;const result=await probeMedia(source,bytes.length,async(offset,length)=>{calls++;maxEnd=Math.max(maxEnd,offset+length);return bytes.subarray(offset,offset+length);},()=>{});
  assert.ok(calls<=28);assert.ok(maxEnd<=DISCOVERY_LIMITS.flvPrefixBytes);assert.equal(result.streamInventoryComplete,false);assert.ok(result.coverage.prefix!.tagHeadersInspected<=8);return{result,maxEnd,calls};};
 for(const sample of fixtures.audioSamples){const bytes=Buffer.from(sample.bytes,'base64');assert.equal(createHash('sha256').update(bytes).digest('hex'),sample.sha256);const{result,maxEnd,calls}=await observe(bytes);
  const audio=result.streams.find(s=>s.type==='audio')!;assert.equal(audio.fields.codec.value,sample.codec);assert.equal(audio.fields.sampleRate.value,sample.oracle[0].sampleRate);assert.equal(audio.fields.channels.value,sample.oracle[0].channels);
  assert.equal(result.streams.some(s=>s.type==='video'),false);assert.equal(evaluateDiscovery(result.streams,false,{codec:'h264'}).state,'unknown');assert.equal(result.coverage.prefix!.tagHeadersInspected,8);assert.ok(maxEnd<bytes.length,'pure audio tag walk stops before EOF');console.log({audio:sample.name,size:bytes.length,calls,maxEnd});
 }
 const original=Buffer.from(fixtures.samples.find((s:any)=>s.name==='h264-8-tagged.flv').bytes,'base64');
 const tag=Buffer.alloc(16);tag[0]=18;tag[3]=1;tag.writeUInt32BE(12,12);const prefix=Buffer.concat([original.subarray(0,13),...Array.from({length:32},()=>tag)]);
 const absent=await observe(prefix);assert.equal(absent.result.streams.length,0);assert.ok(absent.maxEnd<prefix.length);assert.equal(evaluateDiscovery(absent.result.streams,false,{codec:'h264'}).state,'unknown');
 const late=Buffer.concat([prefix,original.subarray(13)]),seen=await observe(late);assert.equal(seen.result.streams.length,0);assert.ok(seen.maxEnd<prefix.length,'prefix probe never reaches the actual later video');
 const decodedHeader=await scanFlv({size:late.length,read:async(o,n)=>late.subarray(o,o+n)});assert.equal(decodedHeader.index.codec,'h264');assert.ok(decodedHeader.index.packets.length>0,'control confirms the later video actually exists');
});
test('probe source-read budget rejects unbounded header walks and unsupported/malformed inputs without a guessed result',async()=>{
 const source={id:'a'.repeat(24),version:'b'.repeat(24)};
 await assert.rejects(probeMedia(source,16,async()=>new Uint8Array(16),()=>{}));
 // Valid-looking repeated free boxes exhaust the parser read-call budget,
 // without allocating a giant file or asking the parser to decode anything.
 const prefix=Buffer.from('000000186674797069736f6d0000000069736f6d69736f32','hex');
 const size=prefix.length+8*10000;await assert.rejects(probeMedia(source,size,async(offset,length)=>{
  const value=new Uint8Array(length);for(let i=0;i<length;i++){const at=offset+i;value[i]=at<prefix.length?prefix[at]:[0,0,0,8,102,114,101,101][(at-prefix.length)%8];}return value;
 },()=>{}),/budget/);
 let calls=0;await assert.rejects(probeMedia(source,100,async(_o,length)=>{calls++;return new Uint8Array(Math.max(0,length-1));},()=>{}),/source-changed/);assert.equal(calls,1);
});
