import {chromium,webkit} from 'playwright';import {mkdtemp,mkdir,writeFile,copyFile,rm,readFile,readdir} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';import {createHash} from 'node:crypto';import assert from 'node:assert/strict';
import {loadConfig} from '../../../server/config.ts';import {startService} from '../../../server/runtime.ts';import {waitForAnnotationMedia} from '../../testing/agent-annotations-ready.mjs';
const root=path.resolve(import.meta.dirname,'../../..'),[baselineDist,fixturePath,output=path.join(root,'.run/native-cost')]=process.argv.slice(2);
assert.ok(baselineDist&&fixturePath,'Pass baseline dist, 1280x720/120-frame H264 B2 fixture, and optional report directory');await mkdir(output,{recursive:true});
const temp=await mkdtemp(path.join(tmpdir(),'vp-native-cost-')),servers=[],results=[];let browser;
const median=a=>[...a].sort((x,y)=>x-y)[Math.floor(a.length/2)];
// Linux process-family CPU ticks, including waited children; same host/runtime
// and browser decoder on each side. RSS is deliberately labelled summed RSS.
async function usage(){const all=[];for(const id of await readdir('/proc'))if(/^\d+$/.test(id)){try{const s=await readFile(`/proc/${id}/stat`,'utf8'),a=s.slice(s.lastIndexOf(')')+2).split(' ');all.push({id:Number(id),ppid:Number(a[1]),ticks:[11,12,13,14].reduce((n,k)=>n+Number(a[k]),0)});}catch{}}const ids=new Set([process.pid]);for(let changed=true;changed;){changed=false;for(const p of all)if(ids.has(p.ppid)&&!ids.has(p.id)){ids.add(p.id);changed=true;}}return all.filter(p=>ids.has(p.id)).reduce((n,p)=>n+p.ticks,0);}
try{
 for(const [variant,staticDir]of [['baseline',path.resolve(baselineDist)],['feature',path.join(root,'dist')]]){
  const dir=path.join(temp,variant),media=path.join(dir,'media');await mkdir(media,{recursive:true});await copyFile(path.resolve(fixturePath),path.join(media,'cost.flv'));
  await writeFile(path.join(dir,'voidplayer.config.json'),JSON.stringify({mediaRoots:[media],dataDir:'data',staticDir,logsDir:null,indexWatch:false}));const config=await loadConfig([],'production',dir);config.port=0;const service=await startService(config);servers.push({variant,service});await service.library.refresh();
  const [e]=await waitForAnnotationMedia(service.library,['cost.flv']),base=`http://127.0.0.1:${service.server.address().port}`;assert.equal((await fetch(`${base}/api/media/${e.id}/frame-index?v=${e.version}&build=1`)).status,200);
  const response=await fetch(base+'/api/identity',{method:'POST',headers:{origin:base,'content-type':'application/json','x-voidplayer-action':'identity'},body:JSON.stringify({name:'Cost gate'})}),actor=(await response.json()).actor,cookie=response.headers.get('set-cookie').split(';')[0];
  const source={id:'cost-source',name:'cost.flv',size:e.size,lastModified:e.lastModified,codec:'h264',decoder:'webcodecs',width:1280,height:720,durationUs:4000000,firstPtsUs:67000,source:{kind:'library',id:e.id,url:`${base}/api/media/${e.id}?v=${e.version}`}};
  const doc={schema:'voidplayer-workspace',version:1,name:'Same decoder cost',generatedAt:new Date().toISOString(),serverUrl:base,positionUs:0,tracks:[{slot:'A',mediaId:source.id,offsetUs:0}],media:[source],marks:[],viewport:{},layout:{panels:{inspector:false,subtracks:true,sources:false},selected:'A',dockHeight:250,marksExpanded:true}};
  const shared=await fetch(base+'/api/workspaces/share',{method:'POST',headers:{cookie,origin:base,'content-type':'application/json','x-voidplayer-action':'workspace'},body:JSON.stringify({name:'Cost gate',document:doc})});assert.equal(shared.status,201);const workspace=await shared.json();Object.assign(servers.at(-1),{base,actor,url:`${base}/?workspace=${workspace.id}`});
 }
 for(const [engine,type]of Object.entries({chromium,webkit})){
  browser=await type.launch(engine==='webkit'?(process.env.VOIDPLAYER_WEBKIT_EXECUTABLE?{executablePath:process.env.VOIDPLAYER_WEBKIT_EXECUTABLE}:{}):{});
  // One warm-up pair, then four alternating AB/BA pairs. Threshold declared
  // before sampling: median speed must retain >=90%; CPU ticks <=110%.
  for(let pair=-1;pair<4;pair++)for(const index of pair%2===0?[0,1]:[1,0]){
   const target=servers[index],context=await browser.newContext({viewport:{width:1400,height:1000}});await context.addCookies([{name:'voidplayer-user',value:target.actor.id,url:target.base}]);const page=await context.newPage();page.setDefaultTimeout(30000);let qualityReads=0;page.on('request',r=>{if(/psnr-|quality\/(jobs|pair)/.test(r.url()))qualityReads++;});
   await page.goto(target.url);await page.waitForFunction(()=>{const s=window.voidPlayer?.getState();if(s?.tracks.some(t=>t.failure))throw Error(JSON.stringify(s.tracks));return s&&!s.busy&&s.tracks[0]?.frame;});await page.bringToFront();assert.equal(await page.evaluate(()=>window.voidPlayer.getState().tracks[0].decoder),'webcodecs');
   const before=await usage(),report=await page.evaluate(()=>window.voidPlayer.tools.find(t=>t.name==='benchmark_review').execute({durationMs:2400})),ticks=(await usage())-before;assert.equal(qualityReads,0);assert.equal(report.tracks[0].decoder,'webcodecs');assert.equal(report.error,null);assert.equal(report.staleAfterPause,false);
   results.push({engine,variant:target.variant,pair,cpuTicks:ticks,qualityReads,report});console.log('COST',engine,target.variant,pair,JSON.stringify({ticks,speed:report.measurements.speed,failures:report.failures}));await context.close();await writeFile(path.join(output,'cost-raw.json'),JSON.stringify(results,null,2));
  }await browser.close();browser=undefined;
 }
 const summary={baseline:'7c399ad05ad381c9df9e9713be98d5292ed9fd65',sourceSha256:createHash('sha256').update(await readFile(path.resolve(fixturePath))).digest('hex'),thresholds:{speedRatioMin:.9,cpuTicksRatioMax:1.1},engines:[]};
 for(const engine of ['chromium','webkit']){const a=results.filter(r=>r.engine===engine&&r.variant==='baseline'&&r.pair>=0),b=results.filter(r=>r.engine===engine&&r.variant==='feature'&&r.pair>=0),speedRatio=median(b.map(r=>r.report.measurements.speed))/median(a.map(r=>r.report.measurements.speed)),cpuRatio=median(b.map(r=>r.cpuTicks))/median(a.map(r=>r.cpuTicks));summary.engines.push({engine,speedRatio,cpuRatio,passed:speedRatio>=.9&&cpuRatio<=1.1,baselineAbsoluteFailures:a.map(r=>r.report.failures),featureAbsoluteFailures:b.map(r=>r.report.failures)});}
 await writeFile(path.join(output,'cost-summary.json'),JSON.stringify(summary,null,2));console.log('COST-SUMMARY',JSON.stringify(summary));assert.ok(summary.engines.every(e=>e.passed),'Declared small-source cost gate failed');
}finally{await browser?.close();for(const s of servers)await s.service.close();await rm(temp,{recursive:true,force:true});}
