// Explicit fixture import from the fixed core's synthetic native-byte oracle.
// Never fetches sources or replaces expected data during tests.
import assert from 'node:assert/strict';import {readFile,writeFile} from 'node:fs/promises';import {createHash} from 'node:crypto';import {execFileSync} from 'node:child_process';import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import path from 'node:path';
const input=process.argv[2];assert.ok(input,'pass fixed core fixtures/packet-identity/samples.json');
const sourceBytes=await readFile(input),fixture=JSON.parse(sourceBytes),lock=JSON.parse(await readFile(new URL('../../release-core.json',import.meta.url),'utf8'));
assert.equal(fixture.oracleRevision,lock.ffmpegRevision);assert.equal(fixture.schema,'voidplayer-packet-identity-fixtures');assert.equal(fixture.version,1);
const sha=b=>createHash('sha256').update(b).digest('hex');
const tag=(body,dts)=>{const h=Buffer.alloc(11);h[0]=9;h.writeUIntBE(body.length,1,3);h.writeUIntBE(dts&0xffffff,4,3);h[7]=dts>>>24;const tail=Buffer.alloc(4);tail.writeUInt32BE(body.length+11);return Buffer.concat([h,body,tail]);};
const samples=[],delayedSamples=[];
const [nativeFfmpeg,nativeFfprobe]=process.argv.slice(3);assert.ok(nativeFfmpeg&&nativeFfprobe,'pass fixed native ffmpeg and ffprobe for zero-CTS oracle');
for(const tool of [nativeFfmpeg,nativeFfprobe])assert.ok(execFileSync(tool,['-version'],{encoding:'utf8'}).split('\n')[0].includes(lock.ffmpegRevision.slice(0,10)));
const temp=mkdtempSync(path.join(tmpdir(),'vp-zero-cts-'));
try{
for(const s of fixture.samples.filter(s=>s.bframes===2)){
 const header=(type,key,pts,dts)=>{const cts=Buffer.alloc(3);cts.writeUIntBE((pts-dts)&0xffffff,0,3);return s.codec==='hevc'?Buffer.concat([Buffer.from([(key?0x90:0xa0)|type]),Buffer.from('hvc1'),...(type===1?[cts]:[])]):Buffer.concat([Buffer.from([key?0x17:0x27,type]),cts]);};
 const tags=[tag(Buffer.concat([header(0,true,0,0),Buffer.from(s.configuration,'base64')]),0)];
 for(const p of s.packets){assert.ok(Number.isSafeInteger(p.pts/1000)&&Number.isSafeInteger(p.dts/1000));tags.push(tag(Buffer.concat([header(1,p.key,p.pts/1000,p.dts/1000),Buffer.from(p.bytes,'base64')]),p.dts/1000));}
 const flv=Buffer.concat([Buffer.from('464c5601010000000900000000','hex'),...tags]),all=Buffer.from(s.native,'base64'),frame=1536*(s.depth===8?1:2),selectedAus=[2,5];assert.equal(sha(all),s.nativeSha256);
 const native=Buffer.concat(selectedAus.map(au=>{const i=s.displayAuOrder.indexOf(au);assert.ok(i>=0);return all.subarray(i*frame,(i+1)*frame);}));
 samples.push({codec:s.codec,depth:s.depth,tagged:true,frames:s.packets.length,bframes:s.bframes,selectedAus,selectedPts:selectedAus.map(au=>s.packets[au].pts),displayAuOrder:s.displayAuOrder,flv:flv.toString('base64'),flvSha256:sha(flv),native:native.toString('base64'),nativeSha256:sha(native),allNative:s.native,allNativeSha256:s.nativeSha256});
 if(s.packets.length===16){
  const delayedTags=[tag(Buffer.concat([header(0,true,0,0),Buffer.from(s.configuration,'base64')]),0)],positions=[];
  for(const [i,p]of s.packets.slice(0,2).entries()){positions.push(13+delayedTags.reduce((n,b)=>n+b.length,0));const clock=2000+i*100;delayedTags.push(tag(Buffer.concat([header(1,p.key,clock,clock),Buffer.from(p.bytes,'base64')]),clock));}
  const delayed=Buffer.concat([Buffer.from('464c5601010000000900000000','hex'),...delayedTags]),file=path.join(temp,'delayed.flv');writeFileSync(file,delayed);
  const decoded=JSON.parse(execFileSync(nativeFfprobe,['-v','error','-select_streams','v:0','-show_frames','-show_entries','frame=pkt_pos','-of','json',file],{encoding:'utf8'})).frames;
  const order=decoded.map(f=>positions.indexOf(Number(f.pkt_pos)));assert.deepEqual(order,[0,1]);
  const raw=execFileSync(nativeFfmpeg,['-v','error','-i',file,'-map','0:v:0','-pix_fmt',s.depth===8?'yuv420p':'yuv420p10le','-fps_mode','passthrough','-f','rawvideo','-']);assert.equal(raw.length,2*frame);
  for(const [i,au]of order.entries()){const at=s.displayAuOrder.indexOf(au);assert.deepEqual(raw.subarray(i*frame,(i+1)*frame),all.subarray(at*frame,(at+1)*frame));}
  delayedSamples.push({codec:s.codec,depth:s.depth,tagged:true,frames:2,zeroCts:true,selectedAus:[0,1],selectedPts:[2000000,2100000],displayAuOrder:order,flv:delayed.toString('base64'),flvSha256:sha(delayed),native:raw.toString('base64'),nativeSha256:sha(raw),allNative:raw.toString('base64'),allNativeSha256:sha(raw)});
 }

}
}finally{rmSync(temp,{recursive:true,force:true});}
await writeFile(new URL('../../../test/helpers/quality-reordered-samples.json',import.meta.url),JSON.stringify({schema:'voidplayer-reordered-native-fixtures',version:1,oracleRevision:fixture.oracleRevision,source:{repository:lock.repository,revision:lock.revision,path:'fixtures/packet-identity/samples.json',sha256:sha(sourceBytes)},generator:'node scripts/tools/fixtures/quality-reordered.mjs <fixed-core-fixture>',samples,delayedSamples},null,2)+'\n');
