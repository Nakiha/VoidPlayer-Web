// Explicit fixture import from the fixed core's synthetic native-byte oracle.
// Never fetches sources or replaces expected data during tests.
import assert from 'node:assert/strict';import {readFile,writeFile} from 'node:fs/promises';import {createHash} from 'node:crypto';
const input=process.argv[2];assert.ok(input,'pass fixed core fixtures/packet-identity/samples.json');
const sourceBytes=await readFile(input),fixture=JSON.parse(sourceBytes),lock=JSON.parse(await readFile(new URL('../../release-core.json',import.meta.url),'utf8'));
assert.equal(fixture.oracleRevision,lock.ffmpegRevision);assert.equal(fixture.schema,'voidplayer-packet-identity-fixtures');assert.equal(fixture.version,1);
const sha=b=>createHash('sha256').update(b).digest('hex');
const tag=(body,dts)=>{const h=Buffer.alloc(11);h[0]=9;h.writeUIntBE(body.length,1,3);h.writeUIntBE(dts&0xffffff,4,3);h[7]=dts>>>24;const tail=Buffer.alloc(4);tail.writeUInt32BE(body.length+11);return Buffer.concat([h,body,tail]);};
const samples=[];
for(const s of fixture.samples.filter(s=>s.bframes===2)){
 const header=(type,key,pts,dts)=>{const cts=Buffer.alloc(3);cts.writeUIntBE((pts-dts)&0xffffff,0,3);return s.codec==='hevc'?Buffer.concat([Buffer.from([(key?0x90:0xa0)|type]),Buffer.from('hvc1'),...(type===1?[cts]:[])]):Buffer.concat([Buffer.from([key?0x17:0x27,type]),cts]);};
 const tags=[tag(Buffer.concat([header(0,true,0,0),Buffer.from(s.configuration,'base64')]),0)];
 for(const p of s.packets){assert.ok(Number.isSafeInteger(p.pts/1000)&&Number.isSafeInteger(p.dts/1000));tags.push(tag(Buffer.concat([header(1,p.key,p.pts/1000,p.dts/1000),Buffer.from(p.bytes,'base64')]),p.dts/1000));}
 const flv=Buffer.concat([Buffer.from('464c5601010000000900000000','hex'),...tags]),all=Buffer.from(s.native,'base64'),frame=1536*(s.depth===8?1:2),selectedAus=[2,5];assert.equal(sha(all),s.nativeSha256);
 const native=Buffer.concat(selectedAus.map(au=>{const i=s.displayAuOrder.indexOf(au);assert.ok(i>=0);return all.subarray(i*frame,(i+1)*frame);}));
 samples.push({codec:s.codec,depth:s.depth,tagged:true,frames:s.packets.length,bframes:s.bframes,selectedAus,selectedPts:selectedAus.map(au=>s.packets[au].pts),displayAuOrder:s.displayAuOrder,flv:flv.toString('base64'),flvSha256:sha(flv),native:native.toString('base64'),nativeSha256:sha(native),allNative:s.native,allNativeSha256:s.nativeSha256});
}
await writeFile(new URL('../../../test/helpers/quality-reordered-samples.json',import.meta.url),JSON.stringify({schema:'voidplayer-reordered-native-fixtures',version:1,oracleRevision:fixture.oracleRevision,source:{repository:lock.repository,revision:lock.revision,path:'fixtures/packet-identity/samples.json',sha256:sha(sourceBytes)},generator:'node scripts/tools/fixtures/quality-reordered.mjs <fixed-core-fixture>',samples},null,2)+'\n');
