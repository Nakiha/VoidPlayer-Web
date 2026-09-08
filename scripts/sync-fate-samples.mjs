import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const samples=[...JSON.parse(await readFile(new URL('./fate-samples.json',import.meta.url))),
  ...JSON.parse(await readFile(new URL('./fate-timestamp-samples.json',import.meta.url)))];
await mkdir('fixtures/fate',{recursive:true});
for(const sample of samples){
  const path=new URL('../fixtures/fate/'+sample.file,import.meta.url);
  const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
  const existing=await readFile(path).catch(()=>null);
  if(existing && hash(existing)===sample.sha256)continue;
  const response=await fetch(sample.url,{signal:AbortSignal.timeout(60000)});
  if(!response.ok)throw new Error(`${sample.file}: HTTP ${response.status}`);
  const chunks=[];let size=0;
  for await(const chunk of response.body){size+=chunk.byteLength;if(size>sample.size)throw new Error(`${sample.file}: download exceeds pinned size`);chunks.push(chunk);}
  const bytes=Buffer.concat(chunks);
  if(bytes.length!==sample.size || hash(bytes)!==sample.sha256)throw new Error(`${sample.file}: checksum mismatch`);
  await writeFile(path,bytes);
  console.log(`downloaded ${sample.file} (${size} bytes)`);
}
