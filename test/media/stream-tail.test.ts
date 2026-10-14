import {openPacketMedia} from '../../src/packet-media.ts';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openFFmpegMedia} from '../../src/ffmpeg-media.ts';
import {openFlvMedia} from '../../src/flv-media.ts';

// Keep encoded pictures unchanged while exercising both Matroska codec mappings.
// Rebuild element lengths and omit offset-based seek tables after rewriting tracks.
function ffv1Representation(bytes:Buffer,legacy:boolean):Buffer<ArrayBuffer>{
 const integer=(data:Buffer,at:number,id=false)=>{let width=1,mask=128;while(!(data[at]&mask)){width++;mask>>=1;assert.ok(width<=8);}let value=id?data[at]:data[at]&(mask-1),unknown=!id&&(data[at]&(mask-1))===mask-1;for(let i=1;i<width;i++){value=value*256+data[at+i];unknown=unknown&&data[at+i]===255;}return {width,value,unknown};};
 const elements=(data:Buffer)=>{const result:{id:number;tag:Buffer;data:Buffer}[]=[];for(let at=0;at<data.length;){const id=integer(data,at,true),size=integer(data,at+id.width),start=at+id.width+size.width,end=size.unknown?data.length:start+size.value;assert.ok(end<=data.length);result.push({id:id.value,tag:data.subarray(at,at+id.width),data:data.subarray(start,end)});at=end;}return result;};
 const wrap=(tag:Buffer,data:Buffer)=>{let width=1;while(data.length>=2**(7*width)-1)width++;const size=Buffer.alloc(width);let value=data.length;for(let i=width-1;i>=0;i--){size[i]=value%256;value=Math.floor(value/256);}size[0]|=1<<(8-width);return Buffer.concat([tag,size,data]);};
 const rewrite=(data:Buffer,parent=0):Buffer=>{
  let items=elements(data).filter(item=>![0x114d9b74,0x1c53bb6b,0xbf].includes(item.id));
  if(parent===0xae&&items.some(item=>item.id===0x86&&['V_FFV1','V_MS/VFW/FOURCC'].includes(item.data.toString()))){
   const codec=items.find(item=>item.id===0x86)!,priv=items.find(item=>item.id===0x63a2),video=elements(items.find(item=>item.id===0xe0)!.data),uint=(id:number)=>{let n=0;for(const b of video.find(item=>item.id===id)!.data)n=n*256+b;return n;};
   let extra=priv?.data??Buffer.alloc(0);if(codec.data.toString()==='V_MS/VFW/FOURCC'){assert.equal(extra.toString('ascii',16,20),'FFV1');const size=extra.readUInt32LE();extra=extra.subarray(40,size>40?size:extra.length);}
   codec.data=Buffer.from(legacy?'V_MS/VFW/FOURCC':'V_FFV1');
   if(legacy){const header=Buffer.alloc(40);header.writeUInt32LE(40+extra.length);header.writeInt32LE(uint(0xb0),4);header.writeInt32LE(uint(0xba),8);header.writeUInt16LE(1,12);header.writeUInt16LE(24,14);header.write('FFV1',16);extra=Buffer.concat([header,extra,...(extra.length%2?[Buffer.alloc(1)]:[])]);}
   items=items.filter(item=>item.id!==0x63a2);items.push({id:0x63a2,tag:Buffer.from('63a2','hex'),data:extra});
  }
  return Buffer.concat(items.map(item=>wrap(item.tag,[0x18538067,0x1654ae6b,0xae].includes(item.id)?rewrite(item.data,item.id):item.data)));
 };
 return Buffer.from(rewrite(bytes));
}

const core=new URL('../../public/vendor/voidplayer-core/',import.meta.url);
for(const [kind,encoder] of [['ts','mpeg2video'],['ts','libx264'],['ts','libx265'],['flv','libx264']] as const)test(`${kind}/${encoder} damaged tails retain real decoded frames, playback and backward seek`,{timeout:60000},async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'vp-tail-'));
  try {
    const file=path.join(dir,`video.${kind}`);
    execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=160x96:rate=25','-t','2','-c:v',encoder,'-threads','1',...(encoder==='libx265'?['-x265-params','pools=none:frame-threads=1:log-level=error']:[]),'-g','12','-bf','2','-y',file]);
    const bytes=await readFile(file),deps={glueURL:new URL('voidplayer-core.js',core).href,wasmBinary:await readFile(new URL('voidplayer-core.wasm',core))};
    let gapInput:Buffer<ArrayBuffer>|undefined;
    if(kind==='flv'){
      const tags:number[]=[];for(let offset=bytes.readUInt32BE(5)+4;offset<bytes.length;offset+=15+bytes.readUIntBE(offset+1,3))tags.push(offset);
      const at=tags.at(-7)!;gapInput=Buffer.concat([bytes.subarray(0,at),Buffer.alloc(149,0xa5),bytes.subarray(at)]);
    }
    let cleanFrames:string[]|undefined;
    const largeTail = Buffer.concat([bytes, Buffer.alloc(190 * 1024, 0xa5)]);
    const inputs=kind==='ts'?[bytes,bytes.subarray(0,bytes.length-1),bytes.subarray(0,bytes.length-187),Buffer.concat([bytes,Buffer.alloc(37,0xa5)]),largeTail]
      :[bytes,bytes.subarray(0,bytes.length-1),Buffer.concat([bytes,Buffer.alloc(37,0xa5)]),gapInput!];
    let firstPixels:Uint8ClampedArray|undefined;
    for(const input of inputs){
      const f=new File([input],`video.${kind}`);
      const source=kind==='ts'?await openPacketMedia('ts',{file:f},f,{...deps,forceWasm:true,sourceVersion:'tail-'+input.length}):await openFlvMedia({file:f},f,{...deps,forceWasm:true});
      try{
        const first=await source.frameAt(0);
        try{firstPixels??=first.pixels!.slice();assert.deepEqual(first.pixels,firstPixels);}finally{first.close();}
        await source.ensureIndexed?.();
        let count=0,last=-1;const frames:string[]=[];
        for await(const frame of source.framesFrom(0)){try{assert.ok(frame.ptsUs>=last);last=frame.ptsUs;count++;frames.push(`${frame.ptsUs}:${createHash("sha256").update(frame.pixels!).digest("hex")}`);}finally{frame.close();}}
        if(input===bytes)cleanFrames=frames;
        if(input===gapInput) {
          assert.equal(source.info.indexIntegrity, 'recovered');
          assert.ok(frames.every(frame => cleanFrames!.includes(frame)), 'resynchronization retains only original, independently recoverable pictures');
          assert.equal(frames.at(-1), cleanFrames!.at(-1), 'the next IDR and tail remain playable');
        }
        if(input===largeTail) {
          assert.equal(source.info.indexState, 'complete');
          assert.equal(source.info.indexIntegrity, 'prefix');
          assert.match(source.info.indexWarning!, /有效前段/);
          assert.ok(source.info.indexTruncatedAt! < bytes.length);
          assert.ok(count > 0 && count < 50);
          assert.ok(frames.every(frame => cleanFrames!.includes(frame)), 'every retained reordered frame matches the undamaged decode');
          const lastFrame = await source.frameAt(source.info.durationUs - 1);
          try { assert.equal(`${lastFrame.ptsUs}:${createHash('sha256').update(lastFrame.pixels!).digest('hex')}`, frames.at(-1)); }
          finally { lastFrame.close(); }
          const analysis = await source.queryAnalysis!({ requestId: 1, startUs: 0, endUs: source.info.durationUs, axis: 'pts', pixelWidth: 100, bitrateWindowUs: 1000000 });
          assert.equal(analysis.coverageUs, null);
          assert.match(analysis.capability.note!, /有效前段/);
        } else assert.ok(count>=45,`retained ${count}/50 frames`);
        const sought=await source.frameAt(0);try{assert.deepEqual(sought.pixels,firstPixels);}finally{sought.close();}
        if(kind==='flv'&&input!==bytes)assert.match(source.info.indexWarning!,input===gapInput?/重同步/:/尾部/);
      }finally{source.dispose();}
    }
  }finally{await rm(dir,{recursive:true,force:true});}
});

for (const [kind, encoder, legacy] of [['mkv', 'ffv1', false], ['mkv', 'ffv1', true], ['webm', 'libvpx-vp9', false], ['avi', 'mpeg4', false], ['mpg', 'mpeg2video', false]] as const)
test(`${kind}${legacy?' VFW FFV1':''} shares corruption policy without losing readable frames to an appended tail`, { timeout: 60000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'vp-container-tail-'));
  const deps = { glueURL: new URL('voidplayer-core.js', core).href, wasmBinary: await readFile(new URL('voidplayer-core.wasm', core)) };
  try {
    const file = path.join(dir, `video.${kind}`);
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x96:rate=25', '-t', '2',
      '-c:v', encoder, '-threads', '1', '-g', '12', '-y', file]);
    const generated=await readFile(file),bytes=kind==='mkv'?ffv1Representation(generated,legacy):generated;
    const load=(data:Uint8Array<ArrayBuffer>,name:string)=>{const file=new File([data],name);return kind==='mkv'||kind==='webm'?openPacketMedia('matroska',{file},file,{...deps,forceWasm:true,sourceVersion:name}):openFFmpegMedia(file,deps);};
    const original = await load(bytes,`original.${kind}`);
    const expected = new Map<string, string>();
    try {
      for await (const frame of original.framesFrom(0)) {
        try { expected.set(String(frame.sourcePtsUs), createHash('sha256').update(frame.pixels!).digest('hex')); }
        finally { frame.close(); }
      }
    } finally { original.dispose(); }
    const source = await load(Buffer.concat([bytes,Buffer.alloc(190*1024,0xa5)]),`tail.${kind}`);
    try {
      await source.ensureIndexed?.();
      assert.equal(source.info.indexState, 'complete');
      let count = 0;
      for await (const frame of source.framesFrom(0)) {
        try { assert.equal(createHash('sha256').update(frame.pixels!).digest('hex'), expected.get(String(frame.sourcePtsUs))); count++; }
        finally { frame.close(); }
      }
      assert.ok(count > 0 && count <= expected.size);
      for (const time of [source.info.durationUs - 1, 0]) {
        const frame = await source.frameAt(time);
        try { assert.equal(createHash('sha256').update(frame.pixels!).digest('hex'), expected.get(String(frame.sourcePtsUs))); }
        finally { frame.close(); }
      }
    } finally { source.dispose(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
