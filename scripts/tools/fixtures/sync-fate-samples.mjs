import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {downloadPinnedSample} from '../../testing/pinned-download.ts';
const samples=[...JSON.parse(await readFile(new URL('../../fate-samples.json',import.meta.url))),
  ...JSON.parse(await readFile(new URL('../../fate-timestamp-samples.json',import.meta.url)))];
await mkdir('fixtures/fate',{recursive:true});
for(const sample of samples){
  const path=new URL('../../../fixtures/fate/'+sample.file,import.meta.url);
  const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
  const existing=await readFile(path).catch(()=>null);
  if(existing && hash(existing)===sample.sha256)continue;
  const bytes=await downloadPinnedSample(sample);
  await writeFile(path,bytes);
  console.log(`downloaded ${sample.file} (${bytes.length} bytes)`);
}
