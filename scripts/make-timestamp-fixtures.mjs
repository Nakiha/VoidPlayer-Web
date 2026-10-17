// Reproducible clock faults derived from a pinned FATE stream. These are NOT
// official FATE files. Coded pictures are unchanged; only TS/PES clocks change.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const source='mpegts--h264small.ts',dir=new URL('../fixtures/fate/',import.meta.url);
const manifest=JSON.parse(await readFile(new URL('./fate-timestamp-samples.json',import.meta.url)));
const original=await readFile(new URL(source,dir)),sha=b=>createHash('sha256').update(b).digest('hex');
if(sha(original)!==manifest.find(s=>s.file===source).sha256)throw Error('FATE input checksum mismatch');
const wrap=2**33,mod=n=>((n%wrap)+wrap)%wrap;
const pts=(b,k)=>((b[k]>>1)&7)*2**30+b[k+1]*2**22+(b[k+2]>>1)*2**15+b[k+3]*128+(b[k+4]>>1);
function putPts(b,k,t){t=mod(t);b[k]=(b[k]&0xf0)|(Math.floor(t/2**30)<<1)|1;b[k+1]=Math.floor(t/2**22)&255;b[k+2]=((Math.floor(t/2**15)&127)<<1)|1;b[k+3]=Math.floor(t/128)&255;b[k+4]=((t%128)<<1)|1;}
function packets(b,visit){for(let at=0;at<b.length;at+=188){if(b[at]!==0x47||at+188>b.length)throw Error('not 188-byte TS');let k=at+4,afc=(b[at+3]>>4)&3,pcr;
  if(afc&2){const n=b[k];if(n>=7&&(b[k+1]&0x10))pcr=k+2;k+=1+n;}
  let pes;if((afc&1)&&(b[at+1]&0x40)&&k+14<=at+188&&b[k]===0&&b[k+1]===0&&b[k+2]===1&&b[k+3]>=0xe0&&b[k+3]<=0xef&&(b[k+7]&0x80))pes=k;
  visit({at,pcr,pes});
}}
const clocks=[];packets(original,({at,pes})=>{if(pes!==undefined)clocks.push({at,time:pts(original,pes+9)});});
if(clocks.length<10)throw Error('insufficient clock samples');
const pivot=clocks[Math.floor(clocks.length/2)],first=clocks[0].time;
await mkdir(new URL('timestamps/',dir),{recursive:true});
const cases=[];
for(const [name,offset] of [
  ['wrap33',()=>wrap-first-90000],
  ['forward-gap',at=>at>=pivot.at?30*90000:0],
  ['clock-reset',at=>at>=pivot.at?-pivot.time:0],
]){
  const bytes=Buffer.from(original);
  packets(bytes,({at,pcr,pes})=>{const delta=offset(at);
    if(pcr!==undefined){const k=pcr,t=bytes[k]*2**25+bytes[k+1]*2**17+bytes[k+2]*512+bytes[k+3]*2+(bytes[k+4]>>7),v=mod(t+delta);bytes[k]=Math.floor(v/2**25);bytes[k+1]=Math.floor(v/2**17)&255;bytes[k+2]=Math.floor(v/512)&255;bytes[k+3]=Math.floor(v/2)&255;bytes[k+4]=(bytes[k+4]&127)|((v%2)<<7);}
    if(pes!==undefined){putPts(bytes,pes+9,pts(bytes,pes+9)+delta);if(bytes[pes+7]&0x40)putPts(bytes,pes+14,pts(bytes,pes+14)+delta);}
  });
  const file='timestamps/'+name+'.ts';await writeFile(new URL(file,dir),bytes);cases.push({file,sha256:sha(bytes),source,sourceSha256:sha(original),mutation:name});
}
const doubled=Buffer.concat([original,original]),file='timestamps/repeated-epoch.ts';await writeFile(new URL(file,dir),doubled);cases.push({file,sha256:sha(doubled),source,sourceSha256:sha(original),mutation:'same TS segment repeated; duplicate timestamp epochs'});
await writeFile(new URL('timestamps/manifest.json',dir),JSON.stringify(cases,null,2)+'\n');
console.log(cases.map(c=>({file:c.file,sha256:c.sha256})));
