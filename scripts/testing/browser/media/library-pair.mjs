import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {chromium,webkit} from 'playwright';
import {loadConfig} from '../../../../server/config.ts';
import {startService} from '../../../../server/runtime.ts';
const engine=process.argv[2];if(!['chromium','webkit'].includes(engine))throw new Error('Expected chromium or webkit');
const dir=await mkdtemp(join(tmpdir(),'vp-library-psnr-browser-'));let service,browser;
try{
 const media=join(dir,'media');await mkdir(media);
 const samples=JSON.parse(await readFile(new URL('../../../../test/helpers/quality-http-samples.json',import.meta.url),'utf8')).samples.filter(s=>s.tagged&&(s.codec==='h264'||s.depth===10));
 for(const sample of samples)for(const role of ['reference','distorted'])await writeFile(join(media,`${role}-${sample.depth}.flv`),Buffer.from(sample.flv,'base64'));
 await writeFile(join(media,'cursor.mp4'),Buffer.from(await readFile(new URL('../../../../test/http-smoke.mp4.base64',import.meta.url),'utf8'),'base64'));
 const config=await loadConfig(['--folder',media,'--data-dir',join(dir,'data'),'--static',resolve('dist')],'production');config.port=0;config.logsDir=null;
 service=await startService(config);await service.library.refresh();const base=`http://127.0.0.1:${service.server.address().port}`;
 browser=await(engine==='webkit'?webkit:chromium).launch({headless:true});const page=await browser.newPage({viewport:{width:1280,height:800}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto(base);await page.locator('#identity-welcome [data-guest]').click();
 const entries=await page.evaluate(async()=>{
  for(let i=0;i<100;i++){
   const entries=(await fetch('/api/library').then(r=>r.json())).entries;
   if(entries.length===5&&entries.every(e=>e.state==='ready'))return entries;await new Promise(resolve=>setTimeout(resolve,100));
  }throw Error('Library did not settle');
 });
 const cursor=entries.find(e=>e.name==='cursor.mp4');
 await page.evaluate(async id=>{const tool=name=>window.voidPlayer.tools.find(tool=>tool.name===name);await tool('load_library_item').execute({slot:'A',id});await tool('seek_review').execute({ptsUs:200000});},cursor.id);
 await page.waitForFunction(()=>window.voidPlayer.getState().positionUs===200000&&!window.voidPlayer.getState().busy);
 const before=await page.evaluate(()=>window.voidPlayer.exportWorkspace());
 const rows=[];
 for(const sample of samples){
  const targets=[];
  for(const [au,role] of ['reference','distorted'].entries()){
   const entry=entries.find(e=>e.name===`${role}-${sample.depth}.flv`);
   targets.push(await page.evaluate(async({entry,au})=>{
    const built=await fetch(`/api/media/${entry.id}/frame-index?v=${entry.version}&build=1`);if(!built.ok)throw Error(await built.text());const index=await built.json();
    const response=await fetch(`/api/media/${entry.id}/psnr-source?v=${entry.version}`);const source=await response.json();if(!response.ok)throw Error(JSON.stringify(source));
    return {...source.binding,picture:{sourceVersion:`${entry.id}@${entry.version}`,stream:'video',configuration:0,au,picture:0,layer:0,field:'frame'},sourcePtsUs:index.index.packets[au][2]};
   },{entry,au}));
  }
  const value=await page.evaluate(async targets=>{
   const response=await fetch('/api/quality/psnr-pair',{method:'POST',headers:{'content-type':'application/json','x-voidplayer-action':'quality'},body:JSON.stringify({pairing:'caller-specified',reference:targets[0],distorted:targets[1],roi:{x:2,y:4,width:24,height:20}})});
   const value=await response.json();if(!response.ok)throw Error(JSON.stringify(value));return value;
  },targets);
  assert.equal(value.execution.host,'node-worker');assert.equal(value.result.metric.bitDepth,sample.depth);assert.ok(value.result.metric.aggregate.sse>0);
  assert.equal(value.result.provenance.reference.mediaId,targets[0].mediaId);assert.equal(value.result.provenance.distorted.mediaId,targets[1].mediaId);
  const durable=await page.evaluate(async({targets,depth})=>{
   const response=await fetch('/api/quality/jobs',{method:'POST',headers:{'content-type':'application/json','x-voidplayer-action':'quality-job','idempotency-key':`gui-isolation-${depth}`},
    body:JSON.stringify({schema:'voidplayer-psnr-frame-job',version:1,client:{id:'gui-isolation',kind:'browser'},request:{pairing:'caller-specified',reference:targets[0],distorted:targets[1],roi:{x:2,y:4,width:24,height:20}}})});
   const accepted=await response.json();if(response.status!==202)throw Error(JSON.stringify(accepted));
   for(let i=0;i<100;i++){
    const job=await fetch(`/api/quality/jobs/${accepted.job.id}`).then(r=>r.json());
    if(job.state==='completed')return {job,result:await fetch(job.result.url).then(r=>r.json())};
    if(['failed','cancelled','interrupted'].includes(job.state))throw Error(JSON.stringify(job));await new Promise(resolve=>setTimeout(resolve,50));
   }throw Error('Durable GUI-isolation job did not complete');
  },{targets,depth:sample.depth});
  assert.deepEqual(durable.result.value.result.metric,value.result.metric);assert.equal(durable.job.attempt.number,1);
  const after=await page.evaluate(()=>window.voidPlayer.exportWorkspace());assert.equal(after.positionUs,before.positionUs);assert.deepEqual(after.tracks,before.tracks);assert.deepEqual(after.viewport,before.viewport);assert.deepEqual(after.layout,before.layout);
  rows.push({depth:sample.depth,sse:value.result.metric.aggregate.sse,sourcePtsUs:value.result.provenance.reference.decoded.sourcePtsUs,cursorUs:after.positionUs,loadedTracks:after.tracks,durableJobId:durable.job.id});
 }
 assert.deepEqual(errors,[]);const evidence=resolve(process.env.VOIDPLAYER_TEST_ARTIFACTS??`.run/library-pair-browser-${engine}`);await mkdir(evidence,{recursive:true});await page.screenshot({path:join(evidence,'cursor-unchanged.png')});await writeFile(join(evidence,'result.json'),JSON.stringify({engine,rows},null,2)+'\n');
 console.log(`PASS ${engine}: actual one-shot/durable library HTTP PSNR 8/10-bit while a different GUI source retains tracks, cursor, viewport and layout`);
}finally{await browser?.close();await service?.close();await rm(dir,{recursive:true,force:true});}
