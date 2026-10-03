import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,cp,readdir} from 'node:fs/promises';
import path from 'node:path';import {gzipSync} from 'node:zlib';import os from 'node:os';
import {withBrowserFixture} from '../../testing/browser-fixture.mjs';
import {createMediaServer} from '../../../server/app.ts';import {MediaLibraryIndex} from '../../../server/library.ts';
const feature=path.resolve(import.meta.dirname,'../../..'),baseline=process.env.I18N_BASELINE_ROOT;
if(!baseline)throw new Error('I18N_BASELINE_ROOT must point to the separately built baseline checkout');
const engine=process.argv[2]??'chromium', headless=process.env.I18N_HEADFUL!=='1',mediaMode=process.env.I18N_MEDIA_MODE??'mixed';const results=[];
const order=process.env.I18N_ORDER??'baseline-first',profileCpu=process.env.I18N_CPU_PROFILE==='1',reportSuffix=process.env.I18N_REPORT_SUFFIX??'';
const durationMs=Number(process.env.I18N_DURATION_MS??4000),repeats=Number(process.env.I18N_REPEATS??3);
if(!['baseline-first','feature-first'].includes(order)||!/^[a-z0-9-]*$/.test(reportSuffix))throw new Error('Invalid performance order/report suffix');
if(!['mixed','webcodecs','ci-1080p-solo','ci-1080p-dual'].includes(mediaMode))throw new Error('Invalid I18N_MEDIA_MODE');
if(!Number.isInteger(durationMs)||durationMs<1000||durationMs>30000||!Number.isInteger(repeats)||repeats<1||repeats>20)throw new Error('Invalid benchmark duration/repeat count');
const synthetic=mediaMode.startsWith('ci-1080p-');
const budgets={startupGzipIncreaseBytes:32768,startupExtraRequests:3,englishStartupGzipIncreaseBytes:49152,englishStartupExtraRequests:4,startupMedianIncreaseMs:100,startupMedianMultiplier:1.3,coldLocaleMs:250,cachedLocaleMs:100,existingPlaybackThresholds:'unchanged benchmark_review defaults'};
async function distributionEvidence(root) {
 const assets=await readdir(path.join(root,'dist/assets'));
 let sourceDigest=null;
 for(const file of assets.filter(file=>file.endsWith('.js'))){const code=await readFile(path.join(root,'dist/assets',file),'utf8');const match=code.match(/sourceDigest:\s*[`"']([a-f0-9]{64})/);if(match){sourceDigest=match[1];break;}}
 assert.ok(sourceDigest,'production build must carry source evidence');return {root,sourceDigest};
}
async function measure(name,root){
 await withBrowserFixture({caseName:`i18n-perf-${name}`,engine,launchOptions:{headless},pageOptions:{viewport:{width:1280,height:800},locale:'zh-CN',reducedMotion:'reduce'},dependencies:{startService:async({temp,defer})=>{
   const distribution=path.join(temp,'dist');await cp(path.join(root,'dist'),distribution,{recursive:true});
   const roots=[path.join(feature,synthetic?'.run/playback-media':'fixtures/video')];const library=new MediaLibraryIndex(roots,{database:path.join(temp,'library.sqlite'),watch:false});const server=createMediaServer({roots,library,staticDir:distribution,onLog(){}});let closed=false;
   const close=async()=>{if(closed)return;closed=true;server.closeAllConnections();if(server.listening)await new Promise(resolve=>server.close(resolve));await library.close();};defer('partial-server',close);library.start();await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});return {server,url:`http://127.0.0.1:${server.address().port}/`,close};
 }}},async({page,context,browser,artifact,url,temp})=>{
  const starts=[],playback=[],switches=[];
  const cdp=engine==='chromium'?await context.newCDPSession(page):null;if(cdp)await cdp.send('Performance.enable');
  for(const browserLocale of ['zh-CN','en-US'])for(let repeat=0;repeat<3;repeat++){
   const coldContext=await browser.newContext({viewport:{width:1280,height:800},locale:browserLocale,reducedMotion:'reduce'});const p=await coldContext.newPage();
   for(const cache of ['cold','warm']){
    const start=performance.now();if(cache==='cold')await p.goto(url);else await p.reload();await p.waitForFunction(()=>window.voidPlayer?.tools);const readyMs=performance.now()-start;await p.waitForTimeout(300);
    const resources=await p.evaluate(()=>performance.getEntriesByType('resource').filter(r=>new URL(r.name).pathname.startsWith('/assets/')||new URL(r.name).pathname.startsWith('/themes/')||new URL(r.name).pathname==='/theme-init.js').map(r=>({path:new URL(r.name).pathname,transferSize:r.transferSize,duration:r.duration})));
    let raw=0,gzip=0;for(const res of resources){const bytes=await readFile(path.join(temp,'dist',res.path));raw+=bytes.length;gzip+=gzipSync(bytes).length;}
    starts.push({browserLocale,repeat,cache,readyMs,requests:resources.length,rawBytes:raw,gzipBytes:gzip,transferredBytes:resources.reduce((s,r)=>s+r.transferSize,0),resources});
   }await coldContext.close();
  }
  await page.goto(url);await page.waitForFunction(()=>window.voidPlayer?.tools);await page.bringToFront();
  await page.evaluate(async mediaMode=>{const tools=window.voidPlayer.tools,lib=await tools.find(t=>t.name==='list_library').execute({});const files=mediaMode.startsWith('ci-1080p-')?[['A','http-1080p-a.mp4'],...(mediaMode==='ci-1080p-dual'?[['B','http-1080p-b.mp4']]:[])]:[['A','h264_9s_1920x1080.mp4'],['B',mediaMode==='webcodecs'?'ci_h264_smoke.mp4':'h265_10s_1920x1080.mp4']];for(const [slot,file]of files){const entry=lib.entries.find(e=>e.name===file);if(!entry)throw new Error('Missing benchmark media '+file);if(mediaMode.startsWith('ci-1080p-')&&entry.size<=90000000)throw new Error('Synthetic input must use the real ~100 MB fixture');await tools.find(t=>t.name==='load_library_item').execute({slot,id:entry.id});}},mediaMode);
  // Both distributions enter/leave the same settings pane before playback.
  await page.locator('#settings-open').click();
  await page.locator('#settings-tab-appearance').click();
  // The merged baseline also has locale controls: warm both distributions identically.
  if(await page.locator('#language-choice').count()){
    await page.evaluate(()=>{
      document.addEventListener('click',e=>{if(e.target.closest('#language-choice-menu [data-value]')){window.__localeStart=performance.now();window.__localeCommit=undefined;}},true);
      new MutationObserver(()=>{if(window.__localeStart!==undefined)window.__localeCommit=performance.now()-window.__localeStart;}).observe(document.documentElement,{attributes:true,attributeFilter:['lang']});
    });
    for(const locale of ['en','zh-CN','en','zh-CN']){const before=await page.evaluate(()=>performance.now());await page.locator('#language-choice').click();await page.locator(`#language-choice-menu [data-value="${locale}"]`).click();await page.waitForFunction(locale=>document.documentElement.lang===locale,locale);const ms=await page.evaluate(before=>performance.now()-before,before);switches.push({locale,cache:switches.length?'warm':'cold',clickToReadyMs:ms,commitMs:await page.evaluate(()=>window.__localeCommit)});}

  }
  await page.locator('#settings-close').click();await page.waitForFunction(()=>!document.querySelector('#settings').open);
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const preparation=await page.evaluate(()=>({dialogOpen:document.querySelector('#settings').open,activeId:document.activeElement?.id,tooltipVisible:document.querySelector('#control-tooltip').matches(':popover-open'),locale:document.documentElement.lang,canvas:document.querySelector('#canvas-A').getBoundingClientRect().toJSON(),secureContext:isSecureContext,crossOriginIsolated,videoDecoder:typeof VideoDecoder,visibility:document.visibilityState,focused:document.hasFocus()}));
  if(profileCpu&&cdp){await cdp.send('Profiler.enable');await cdp.send('Profiler.start');}
  for(let repeat=0;repeat<repeats;repeat++){
    const before=cdp?(await cdp.send('Performance.getMetrics')).metrics:null;
    const report=await page.evaluate(async durationMs=>await window.voidPlayer.tools.find(t=>t.name==='benchmark_review').execute({durationMs}),durationMs);
    const after=cdp?(await cdp.send('Performance.getMetrics')).metrics:null;
    const taskDurationMs=before?(after.find(m=>m.name==='TaskDuration').value-before.find(m=>m.name==='TaskDuration').value)*1000:null;
    const cpuMetrics=before?Object.fromEntries(['TaskDuration','ScriptDuration','LayoutDuration','RecalcStyleDuration','LayoutCount','RecalcStyleCount'].map(name=>[name,(after.find(m=>m.name===name).value-before.find(m=>m.name===name).value)*(name.endsWith('Duration')?1000:1)])):null;
    playback.push({...report,repeat,taskDurationMs,cpuMetrics});
  }
  if(profileCpu&&cdp){const cpu=await cdp.send('Profiler.stop');await writeFile(artifact(name+'-cpu.json'),JSON.stringify(cpu));}
  const result={distribution:await distributionEvidence(root),preparation,name,engine,browserVersion:browser.version(),starts,switches,playback};results.push(result);await writeFile(artifact(name+'-report.json'),JSON.stringify(result,null,2));
 });
}
for(const name of order==='baseline-first'?['baseline','feature']:['feature','baseline'])await measure(name,name==='baseline'?path.resolve(baseline):feature);
const median=values=>[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];const b=results.find(r=>r.name==='baseline'),f=results.find(r=>r.name==='feature');
// UI automation timing includes two clicks and scheduler waits; report it separately from catalog commit timing.
await mkdir(path.join(feature,'.run/i18n-performance'),{recursive:true});const report={order,profileCpu,preparation:'same appearance settings open, en/zh/en/zh locale switches, close and two animation frames in both distributions',headless,mediaMode,durationMs,repeats,transport:'HTTP loopback secure context; no trust-store mutation or certificate bypass',device:{platform:process.platform,arch:process.arch,cpu:os.cpus()[0].model,node:process.version},baseline:baseline,budgets,notes:['gzip sizes are offline gzip estimates; the local static server sends uncompressed content','UI click-to-ready timings include Playwright scheduling; commit timing spans click handler to lang mutation delivery after synchronous relabeling','same-engine same-media paired runs; do not infer hardware decoder usage'],results};
const reportFile=path.join(feature,`.run/i18n-performance/${engine}${headless?'':'-headed'}${mediaMode==='mixed'?'':'-'+mediaMode}${reportSuffix}.json`);
await writeFile(reportFile,JSON.stringify(report,null,2));for(const browserLocale of ['zh-CN','en-US'])for(const cache of ['cold','warm']){
 const bs=b.starts.filter(s=>s.cache===cache&&s.browserLocale===browserLocale),fs=f.starts.filter(s=>s.cache===cache&&s.browserLocale===browserLocale);assert.ok(median(fs.map(x=>x.gzipBytes))-median(bs.map(x=>x.gzipBytes))<=(browserLocale==='en-US'?budgets.englishStartupGzipIncreaseBytes:budgets.startupGzipIncreaseBytes));assert.ok(median(fs.map(x=>x.requests))-median(bs.map(x=>x.requests))<=(browserLocale==='en-US'?budgets.englishStartupExtraRequests:budgets.startupExtraRequests));
 assert.ok(median(fs.map(x=>x.readyMs))<=median(bs.map(x=>x.readyMs))*budgets.startupMedianMultiplier+budgets.startupMedianIncreaseMs);
}
for(const result of results)for(const report of result.playback)assert.equal(report.passed,true,`${result.name}/${engine}/${report.repeat}: original playback thresholds`);
for(const sample of f.switches)assert.ok(sample.commitMs <= (sample.cache==='cold'?budgets.coldLocaleMs:budgets.cachedLocaleMs),JSON.stringify(sample));

console.log(`PASS ${engine}: paired startup budgets and ${2*repeats} unchanged playback benchmark runs; report ${reportFile}`);
