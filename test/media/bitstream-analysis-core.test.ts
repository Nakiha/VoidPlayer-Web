import{test}from'node:test';import assert from'node:assert/strict';import{open,readFile}from'node:fs/promises';import{createHash}from'node:crypto';import{resolve}from'node:path';import{pathToFileURL}from'node:url';
import{analyzePicture}from'../../src/bitstream-analysis/runner.ts';import{openAnalysisInput}from'../../src/bitstream-analysis/input.ts';
const fixtures=JSON.parse(await readFile(new URL('../../docs/fixtures/bitstream-analysis-answers.json',import.meta.url),'utf8'));
async function reader(name:string){const file=await open(resolve('fixtures/video',name));const {size}=await file.stat();return {size,async read(offset:number,length:number){const bytes=new Uint8Array(length);const result=await file.read(bytes,0,length,offset);assert.equal(result.bytesRead,length);return bytes;},close(){void file.close();}};}
async function core(){const module=await import(pathToFileURL(resolve('public/vendor/voidplayer-analysis/voidplayer-analysis.js')).href);return module.default();}
for(const fixture of fixtures)test(`real ${fixture.codec} output matches independently frozen native records`,async()=>{
 assert.equal(createHash('sha256').update(await readFile(resolve('fixtures/video',fixture.file))).digest('hex'),fixture.sha256,'fixture identity');
 const input=await openAnalysisInput(await reader(fixture.file),new AbortController().signal);const first=input.packets.reduce((min,p)=>Math.min(min,p.pts),Infinity);input.close();
 const module=await core(),result=await analyzePicture(await reader(fixture.file),{sourceVersion:fixture.sha256,sourcePtsUs:first,normalizedMediaUs:0},module,'test',new AbortController().signal);
 assert.equal(result.confidence,'exact');assert.equal(result.picture.au,fixture.pictureAu);assert.ok(result.blocks.length>0);
 for(const block of fixture.firstBlocks)assert.deepEqual(result.blocks.find(b=>b.x===block.x&&b.y===block.y),block);
 assert.equal(module._vpa_record_bytes(),0,'close releases analysis records');
});
test('random rear H264 target uses a closed IDR and agrees with sequential analysis',async()=>{
 const name=fixtures[0].file,input=await openAnalysisInput(await reader(name),new AbortController().signal);const packet=input.packets[200],target={sourceVersion:'session-file',sourcePtsUs:packet.pts,normalizedMediaUs:packet.pts};input.close();
 const a=await analyzePicture(await reader(name),target,await core(),'test',new AbortController().signal),b=await analyzePicture(await reader(name),target,await core(),'test',new AbortController().signal,{sequential:true});
 assert.equal(a.confidence,'exact');assert.ok(a.metrics.startAu>0);assert.ok(a.metrics.packets<b.metrics.packets);assert.deepEqual(a.blocks,b.blocks);assert.deepEqual(a.picture,b.picture);
});
test('bounded range uses one decoder and drains each picture before accepting more input',async()=>{
 const {analyzeRange}=await import('../../src/bitstream-analysis/runner.ts');const results=[] as any[],module=await core();
 await analyzeRange(await reader(fixtures[0].file),{sourceVersion:'range-file',firstPtsUs:0,startUs:0,endUs:100000},module,'test',new AbortController().signal,async result=>{results.push(result);assert.ok(module._vpa_record_bytes()<32*1024*1024);await new Promise(r=>setTimeout(r,10));});
 assert.ok(results.length>=5);assert.equal(new Set(results.map(r=>r.picture.au)).size,results.length);assert.ok(results.every(r=>r.confidence==='exact'));assert.equal(module._vpa_record_bytes(),0);
 const index=await openAnalysisInput(await reader(fixtures[0].file),new AbortController().signal),p=index.packets[560];index.close();
 const rear=await analyzePicture(await reader(fixtures[0].file),{sourceVersion:'rear-file',sourcePtsUs:p.pts,normalizedMediaUs:p.pts},await core(),'test',new AbortController().signal);
 assert.equal(rear.confidence,'exact');assert.ok(rear.metrics.startAu>=540);assert.ok(rear.metrics.packets<64);
});
