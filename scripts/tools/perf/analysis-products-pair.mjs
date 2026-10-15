import {withBrowserFixture} from '../../testing/browser-fixture.mjs';
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const options=new Map();for(let i=2;i<process.argv.length;i+=2)options.set(process.argv[i],process.argv[i+1]);
const baselineRoot=options.get('--baseline'),candidateRoot=options.get('--candidate') ?? process.cwd();if(!baselineRoot)throw Error('Pass --baseline /path/to/clean-d8f69d1-worktree');
const roots={baseline:path.resolve(baselineRoot),implementation:path.resolve(candidateRoot)},out=path.resolve(options.get('--output') ?? '.run/analysis-products-pair'),rows=[];
await (await import('node:fs/promises')).mkdir(out,{recursive:true});
const iterations=Number(options.get('--pairs') ?? process.env.PAIR_COUNT ?? 5);
for(const input of (process.env.INPUTS?.split(',') ?? ['local','library']))for(let pair=0;pair<iterations;pair++)for(const variant of (pair%2===0?['baseline','implementation']:['implementation','baseline'])){
 if(process.env.VARIANTS && !process.env.VARIANTS.split(',').includes(variant))continue;
 const root=roots[variant],directory=path.join(out,`pair-${input}-${pair}-${variant}`);
 const startCpu=process.cpuUsage(),rssStart=process.memoryUsage().rss;
 await withBrowserFixture({caseName:`product-${input}-${pair}-${variant}`,engine:'chromium',directory,staticDir:path.join(root,'.run/perf-dist'),timeoutMs:180000,
 dependencies:{startService:async({temp,defer})=>{
  const [{createMediaServer},{MediaLibraryIndex}]=await Promise.all([import(pathToFileURL(path.join(root,'server/app.ts'))),import(pathToFileURL(path.join(root,'server/library.ts')))]);
  const library=new MediaLibraryIndex([path.join(root,'fixtures/video')],{database:path.join(temp,'library.sqlite'),watch:false});const server=createMediaServer({roots:[path.join(root,'fixtures/video')],library,staticDir:path.join(root,'.run/perf-dist'),onLog(){}});
  let closed=false;const close=async()=>{if(closed)return;closed=true;server.closeAllConnections();if(server.listening)await new Promise((r,j)=>server.close(e=>e?j(e):r()));await library.close();};defer('partial-server',close);library.start();await new Promise((r,j)=>{server.once('error',j);server.listen(0,'127.0.0.1',r)});return{server,close,url:`http://127.0.0.1:${server.address().port}/`};
 } }},async({page,ready,browser,url})=>{
  await page.addInitScript(()=>{window.__measurement=null;const Original=Worker;window.Worker=class extends Original{constructor(...args){super(...args);if(window.__measurement){window.__measurement.workers++;(window.__measurement.workerUrls??=[]).push(String(args[0]));}this.addEventListener('message',({data})=>{const m=window.__measurement;if(!m)return;if(data.event==='chunk'){m.chunks++;(m.chunkAus??=[]).push(data.result.picture.au);m.firstMs??=performance.now()-m.start;}if(data.event==='coverage'){m.coverage++;(m.coverageAus??=[]).push(data.picture.au);}});}terminate(){if(window.__measurement)window.__measurement.terminations++;return super.terminate();}};let previous=performance.now();setInterval(()=>{const now=performance.now(),m=window.__measurement;if(m && previous>=m.start)m.lags.push(Math.max(0,now-previous-16));previous=now;},16);window.__longObserver=new PerformanceObserver(list=>{const m=window.__measurement;if(m)for(const e of list.getEntries())if(e.startTime>=m.start){m.longTasks.push(e.duration);(m.longTaskEntries??=[]).push({start:e.startTime,end:e.startTime+e.duration,duration:e.duration});}});window.__longObserver.observe({entryTypes:['longtask']});});
  page.on('pageerror',error=>console.log('PAGEERROR',variant,error.message));
  const responses=[];page.on('response',response=>{if(response.url().includes('/bitstream-analysis/chunks/'))responses.push({url:response.url(),length:Number(response.headers()['content-length']),type:response.headers()['content-type']});});
  await ready();if(await page.locator('#identity-welcome').isVisible().catch(()=>false))await page.locator('#identity-welcome [data-guest]').click();
  const call=(name,params={})=>page.evaluate(async({name,params})=>window.voidPlayer.tools.find(t=>t.name===name).execute(params),{name,params});
  if(input==='local')await page.locator('#file-A').setInputFiles(path.join(root,'fixtures/video/mhw_hevc_fullrange_bt709_3s.mp4'));
  else{const listing=await call('list_library');const entry=listing.entries.find(e=>e.name==='mhw_hevc_fullrange_bt709_3s.mp4');if(!entry)throw Error('fixture unavailable');await call('load_library_item',{slot:'A',id:entry.id});}
  await page.waitForFunction(()=>window.voidPlayer.getState().tracks.some(t=>t.slot==='A'&&t.frame)&&!window.voidPlayer.getState().busy,null,{timeout:30000});
  for(const scenario of (process.env.LIFECYCLE?['pause','exact','exact-warm','warm','moved']:(process.env.EXACT?['cold','exact','exact-warm']:['cold','warm','moved']))){
   if(scenario.startsWith('exact'))await page.evaluate(()=>window.__perfSession.seek(500000));
   await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
   const offset=responses.length,scenarioCpu=process.cpuUsage(),scenarioRssStart=process.memoryUsage().rss;
   const result=await page.evaluate(async({variant,scenario,full})=>{
    const windowRange={startUs:scenario==='moved'?1500000:500000,endUs:scenario==='moved'?1700000:700000,axis:'pts'},m=window.__measurement={start:performance.now(),workers:0,terminations:0,chunks:0,coverage:0,firstMs:null,lags:[],longTasks:[]};
    const session=window.__perfSession,off=session.subscribe(()=>{if(session.getBitstreamAnalysisState('A').stream?.pictures>0)m.firstMs??=performance.now()-m.start;});
    try{
      if(scenario==='pause'){
        let pauseOff;const paused=new Promise(resolve=>{pauseOff=session.subscribe(()=>{const state=session.getBitstreamAnalysisState('A');if(state.stream?.pictures===30&&state.state==='pending'){pauseOff();m.pausedCounters=state.counters;m.pausedAt=performance.now()-m.start;session.pauseBitstreamAnalysis('A');resolve();}});});
        const first=session.requestBitstreamStream('A',undefined,windowRange,'explicit',variant==='implementation'&&!full?'summary':undefined).catch(e=>{m.firstError=e.message;});await paused;await first;m.pausedState=session.getBitstreamAnalysisState('A');m.resumeAt=performance.now()-m.start;m.progress=await session.resumeBitstreamAnalysis('A');
      }else if(scenario.startsWith('exact')){const result=await session.requestBitstreamAnalysis('A');m.progress={pictures:1,blocks:result.blocks.length};}
      else m.progress=await session.requestBitstreamStream('A',undefined,windowRange,'explicit',variant==='implementation'&&!full?'summary':undefined);
    }finally{off();}
    m.end=performance.now();m.totalMs=m.end-m.start;for(const e of window.__longObserver.takeRecords())if(e.startTime>=m.start&&e.startTime+e.duration<=m.end){m.longTasks.push(e.duration);(m.longTaskEntries??=[]).push({start:e.startTime,end:e.startTime+e.duration,duration:e.duration});}m.state=session.getBitstreamAnalysisState('A');m.heap=performance.memory?{used:performance.memory.usedJSHeapSize,total:performance.memory.totalJSHeapSize}:null;m.chart=session.queryBitstreamChart('A',0,3000000,800,'pts');delete m.chart.pictures;delete m.chart.buckets;window.__measurement=null;return m;
   },{variant,scenario,full:!!process.env.FULL});
   result.responses=responses.slice(offset);result.responseBytes=result.responses.reduce((n,r)=>n+r.length,0);const row={pair,input,variant,scenario,browser:browser.version(),url,indexCache:'fresh per-profile metadata load before timed window; analysis opens its own admitted index',analysisCache:scenario==='cold'?'new worker and empty session/server products':'retained prior window',osPageCache:'not cleared; paired AB/BA',nodeCpu:process.cpuUsage(scenarioCpu),nodeRssStart:scenarioRssStart,fixtureCpuCumulative:process.cpuUsage(startCpu),fixtureRssStart:rssStart,nodeRssEnd:process.memoryUsage().rss,...result};rows.push(row);console.log(JSON.stringify({pair,input,variant,scenario,ms:result.totalMs,first:result.firstMs,chunks:result.chunks,bytes:result.responseBytes,counters:result.state.counters}));await writeFile(path.join(out,process.env.FULL?'browser-legacy-sanity.json':process.env.LIFECYCLE?'browser-lifecycle-final.json':process.env.EXACT?'browser-exact-pairs.json':iterations===1?'browser-sanity-final.json':'browser-pairs.json'),JSON.stringify(rows,null,2));
  }
 });
}
