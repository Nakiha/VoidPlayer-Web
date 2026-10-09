import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectCachedTracks } from '../../src/cached-track-metadata.ts';
import { attachCachedTrackMetadata } from '../../src/cached-track-metadata-client.ts';
import { RangeReader } from '../../src/range-reader.ts';
import type { MediaSource } from '../../src/media.ts';
const box = (name: string, ...data: Uint8Array[]) => { const b = Buffer.concat([Buffer.alloc(8), ...data]); b.writeUInt32BE(b.length); b.write(name,4); return b; };
const handler = (name: string) => { const b = Buffer.alloc(12); b.write(name,8); return box('hdlr', b); };
function mp4(codec?: string, channels = 2) {
  const entry = Buffer.alloc(28); entry.writeUInt16BE(channels,16); entry.writeUInt32BE(48000 * 65536,24);
  const track = (kind: string, sample?: Buffer) => box('trak', box('mdia', handler(kind), ...(sample ? [box('minf',box('stbl',box('stsd',Buffer.from([0,0,0,0,0,0,0,1]),sample)))] : [])));
  return Buffer.concat([box('ftyp', Buffer.from('isom0000')), box('moov',track('vide'), ...(codec ? [track('soun',box(codec,entry))] : []))]);
}
const peek = (bytes: Uint8Array) => async (offset: number, length: number) => offset + length <= bytes.length ? bytes.slice(offset, offset + length) : undefined;
const inspect = (bytes: Uint8Array) => inspectCachedTracks(bytes.length,peek(bytes));
function element(hex: string, data: Uint8Array) { assert.ok(data.length < 127); return Buffer.concat([Buffer.from(hex,'hex'),Buffer.from([128 | data.length]),data]); }
function mkv(codec?: string) {
  const entry = (type: number, name?: string) => element('ae',Buffer.concat([element('83',Buffer.from([type])), ...(name ? [element('86',Buffer.from(name)),element('e1',Buffer.concat([element('9f',Buffer.from([6])),element('b5',Buffer.from([0x47,0x3b,0x80,0]))]))] : [])]));
  return Buffer.concat([element('1a45dfa3',element('4282',Buffer.from('matroska'))),element('18538067',element('1654ae6b',Buffer.concat([entry(1),...(codec ? [entry(2,codec)] : [])])))]);
}
function flv(audio: boolean, format = 10, config = [0x11,0xb0]) {
  const header = Buffer.from([70,76,86,1,audio ? 5 : 1,0,0,0,9,0,0,0,0]);
  const tag = Buffer.alloc(19); tag[0] = 8; tag[3] = 4; tag.set([(format << 4) | 15,0,...config],11); tag.writeUInt32BE(15,15);
  return Buffer.concat([header,...(audio ? [tag] : [])]);
}
function crc(bytes: Uint8Array) { let v = 0xffffffff; for (const b of bytes) { v ^= b << 24; for (let i=0;i<8;i++) v = v & 0x80000000 ? (v<<1)^0x04c11db7 : v<<1; } const b=Buffer.alloc(4);b.writeUInt32BE(v>>>0);return b; }
function ts(type?: number, privateDescriptor = false, editPmt?: (pmt: Buffer) => Buffer) {
  const pat=Buffer.from([0,0xb0,13,0,1,0xc1,0,0,0,1,0xe1,0]);
  const streams=Buffer.from([0x1b,0xe1,1,0xf0,0,...(type === undefined ? [] : [type,0xe1,2,0xf0,privateDescriptor ? 2 : 0,...(privateDescriptor ? [0x6a,0] : [])])]);
  let pmt: Buffer=Buffer.concat([Buffer.from([2,0xb0,13+streams.length,0,1,0xc1,0,0,0xe1,1,0xf0,0]),streams]);
  if(editPmt)pmt=editPmt(pmt);pmt[2]=pmt.length+1;
  const packet=(pid: number, section: Buffer)=>{const b=Buffer.alloc(188,255);b.set([0x47,0x40|(pid>>8),pid&255,0x10,0]);b.set(Buffer.concat([section,crc(section)]),5);return b;};
  return Buffer.concat([packet(0,pat),packet(256,pmt),packet(0,pat)]);
}

test('complete MP4 inventory distinguishes absent, supported candidate, unsupported codec and surround', async()=>{
  assert.equal((await inspect(mp4())).audio.presence,'absent');
  const surround=await inspect(mp4('ac-3',6)); assert.equal(surround.container,'MP4'); assert.deepEqual(surround.audio,{presence:'present',complete:true,tracks:[{codec:'AC-3',channels:6,sampleRate:48000}]});
  assert.equal((await inspect(mp4('zzzz'))).audio.tracks[0].codec,'zzzz');
  const bytes=mp4('mp4a'); const partial=await inspectCachedTracks(bytes.length,async(at,n)=>at>20?undefined:peek(bytes)(at,n));
  assert.equal(partial.audio.presence,'unknown'); assert.equal(partial.audio.complete,false);
});
test('Matroska Tracks preserves unsupported codecs and multi-channel facts; complete video-only is absent',async()=>{
  const audio=await inspect(mkv('A_AC3')); assert.equal(audio.container,'Matroska');assert.equal(audio.audio.presence,'present');assert.equal(audio.audio.tracks[0].channels,6);assert.equal(audio.audio.tracks[0].sampleRate,48000);
  assert.equal((await inspect(mkv())).audio.presence,'absent');
  assert.equal((await inspect(mkv('A_UNKNOWN'))).audio.tracks[0].codec,'UNKNOWN');
});
test('FLV declared presence is independent of playback filters, and incomplete config is unknown detail',async()=>{
  assert.equal((await inspect(flv(false))).audio.presence,'absent');
  const result=await inspect(flv(true));assert.deepEqual(result.audio.tracks,[{codec:'AAC-LC',sampleRate:48000,channels:6}]);
  assert.equal((await inspect(flv(true,2))).audio.presence,'present');
  const b=flv(true);const r=await inspectCachedTracks(b.length,async(at,n)=>at+n<=16?b.slice(at,at+n):undefined);assert.equal(r.audio.presence,'present');assert.deepEqual(r.audio.tracks,[{}]);
});
test('TS identifies PMT audio beyond ADTS playback and only confirms absence for complete unambiguous tables',async()=>{
  for(const [type,codec] of [[15,'AAC'],[0x81,'AC-3'],[17,'AAC LATM']] as const){const r=await inspect(ts(type));assert.equal(r.audio.presence,'present');assert.equal(r.audio.tracks[0].codec,codec);}
  assert.equal((await inspect(ts(6,true))).audio.tracks[0].codec,'AC-3');
  assert.equal((await inspect(ts())).audio.presence,'absent');assert.equal((await inspect(ts(6))).audio.presence,'unknown');
  const corrupt=ts();corrupt[195]^=1;assert.equal((await inspect(corrupt)).audio.presence,'unknown');
});
test('CRC-valid but truncated PMT structures cannot confirm absence',async()=>{
  const cases: [string,(pmt:Buffer)=>Buffer][]=[
    ['program_info_length beyond section',p=>{p[11]=6;return p;}],
    ['incomplete program descriptor',p=>{p[11]=1;return Buffer.concat([p.subarray(0,12),Buffer.from([0x52]),p.subarray(12)]);}],
    ['program descriptor payload overflow',p=>{p[11]=2;return Buffer.concat([p.subarray(0,12),Buffer.from([0x52,1]),p.subarray(12)]);}],
    ['incomplete video ES descriptor',p=>{p[16]=1;return Buffer.concat([p,Buffer.from([0x52])]);}],
    ['video ES descriptor payload overflow',p=>{p[16]=2;return Buffer.concat([p,Buffer.from([0x52,1])]);}],
    ...[1,2,3,4].map(n=>[`trailing ${n}-byte ES header`,(p:Buffer)=>Buffer.concat([p,Buffer.alloc(n)])] as [string,(p:Buffer)=>Buffer]),
  ];
  for(const [name,edit] of cases){const result=await inspect(ts(undefined,false,edit));assert.equal(result.container,'MPEG-TS',name);assert.deepEqual(result.audio,{presence:'unknown',complete:false,tracks:[]},name);}
  assert.equal((await inspect(ts(undefined,false,p=>{p[11]=2;return Buffer.concat([p.subarray(0,12),Buffer.from([0x52,0]),p.subarray(12)]);}))).audio.presence,'absent','complete descriptors still permit absence');
});
test('missing and oversized metadata never become absence; malicious box chains obey query budget',async()=>{
  assert.equal((await inspectCachedTracks(10000,async()=>undefined)).audio.presence,'unknown');
  const giant=Buffer.alloc(16);giant.writeUInt32BE(8);giant.write('free',4);giant.writeUInt32BE(5*1024*1024,8);giant.write('moov',12);let calls=0;
  const r=await inspectCachedTracks(6*1024*1024,async(at,n)=>{calls++;return at+n<=16?giant.slice(at,at+n):new Uint8Array(n);});assert.equal(r.audio.presence,'unknown');assert.ok(calls<10);
  let many=0;await inspectCachedTracks(100000,async(at,n)=>{many++; const b=Buffer.alloc(n);if(n>=8){b.writeUInt32BE(8);b.write('free',4);}return b;});assert.ok(many<=130);
});
test('cache-only metadata leaves both HTTP Range and local Blob read sequences unchanged',async()=>{
  const bytes=mp4('ac-3',6), original=globalThis.fetch;const requests:string[]=[];
  globalThis.fetch=async(_url,init)=>{const range=new Headers(init?.headers).get('range')!;requests.push(range);const [start,end]=range.slice(6).split('-').map(Number);return new Response(bytes.subarray(start,end+1),{status:206,headers:{'content-range':`bytes ${start}-${end}/${bytes.length}`}});};
  try {
    for(const local of [false,true]){
      let reads=0;const blob=new Blob([bytes]),slice=blob.slice.bind(blob);blob.slice=(...args)=>{reads++;return slice(...args);};
      const reader=new RangeReader(local?{file:blob}:{url:'https://example.test/media',size:bytes.length});
      await reader.read(0,16);const before=[...requests],count=reads;
      for(let i=0;i<5;i++)assert.equal((await inspectCachedTracks(bytes.length,async(at,n)=>reader.peek(at,n))).audio.presence,'present');
      assert.deepEqual(requests,before);assert.equal(reads,count);reader.close();
    }
  }finally{globalThis.fetch=original;}
});
test('inspection is opt-in, coalesced, and ignores late responses after close/disposal',async()=>{
  const bytes=mp4('ac-3',6);let peeks=0,release:()=>void=()=>{};
  const source={info:{size:bytes.length}} as MediaSource;
  const stop=attachCachedTrackMetadata(source,async(at,n)=>{peeks++;if(peeks===1)await new Promise<void>(r=>release=r);return peek(bytes)(at,n);});
  source.requestCachedMetadata!();await new Promise(r=>setTimeout(r,10));assert.equal(peeks,0);
  source.setMetadataInspectionEnabled!(true);source.requestCachedMetadata!();source.requestCachedMetadata!();await new Promise(r=>setTimeout(r,10));assert.equal(peeks,1);
  source.setMetadataInspectionEnabled!(false);release();await new Promise(r=>setTimeout(r,10));assert.equal(source.info.trackMetadata,undefined);
  stop();source.setMetadataInspectionEnabled!(true);source.requestCachedMetadata!();await new Promise(r=>setTimeout(r,10));assert.equal(peeks,1);
});

test('new normal-read cache evidence refreshes unknown metadata, then reopening reuses facts', async () => {
  const bytes = mp4('ac-3',6), source = { info: { size:bytes.length } } as MediaSource;
  let available = false, calls = 0, changes = 0;
  source.onInfoChange = () => { changes++; };
  const stop = attachCachedTrackMetadata(source,async(at,n)=>{calls++;return available ? peek(bytes)(at,n) : undefined;});
  const until = async (predicate:()=>boolean) => { const end=Date.now()+3000;while(!predicate()){assert.ok(Date.now()<end,'metadata update completed');await new Promise(r=>setTimeout(r,10));} };
  try {
    source.setMetadataInspectionEnabled!(true);source.requestCachedMetadata!();await until(()=>changes===1);
    assert.equal(source.info.trackMetadata?.audio.presence,'unknown');
    available=true;source.requestCachedMetadata!();await until(()=>changes===2);
    assert.equal(source.info.trackMetadata?.audio.presence,'present');const count=calls;
    source.setMetadataInspectionEnabled!(false);source.setMetadataInspectionEnabled!(true);source.requestCachedMetadata!();
    await new Promise(r=>setTimeout(r,20));assert.equal(calls,count,'resolved metadata needs no repeated parsing');
  } finally { stop(); }
});

test('a disposed source cannot publish a late metadata reply into a replacement generation', async () => {
  const bytes=mp4('ac-3',6), old={info:{id:'same-id',size:bytes.length}} as MediaSource, replacement={info:{id:'same-id',size:bytes.length}} as MediaSource;
  let release:()=>void=()=>{}, started=false, notifications=0;
  old.onInfoChange=()=>notifications++;
  const dispose=attachCachedTrackMetadata(old,async(at,n)=>{if(!started){started=true;await new Promise<void>(r=>release=r);}return peek(bytes)(at,n);});
  old.setMetadataInspectionEnabled!(true);old.requestCachedMetadata!();await new Promise(r=>setTimeout(r,10));assert.ok(started);
  dispose();release();await new Promise(r=>setTimeout(r,10));
  assert.equal(notifications,0);assert.equal(old.info.trackMetadata,undefined);assert.equal(replacement.info.trackMetadata,undefined);
});
