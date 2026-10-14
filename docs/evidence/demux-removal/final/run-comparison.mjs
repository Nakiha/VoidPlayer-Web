// Standalone evidence collector. Each invocation owns its server/browser/DB.
import path from 'node:path';
import os from 'node:os';
import {mkdtemp,readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {spawn,execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const [repoArg,engine,label,mode='io',outArg]=process.argv.slice(2);
const repo=path.resolve(repoArg),out=path.resolve(outArg);process.chdir(repo);
await mkdir(out,{recursive:true});
const {MediaLibraryIndex}=await import(pathToFileURL(path.join(repo,'server/library.ts')));
const {createMediaServer}=await import(pathToFileURL(path.join(repo,'server/app.ts')));
const playwright=await import(pathToFileURL(path.join(repo,'node_modules/playwright/index.mjs')));
const sampleRoot=path.resolve(process.env.VP_EVIDENCE_FIXTURES_ROOT??path.join(repo,'fixtures'));
const roots=['video','js-container','demux-removal'].map(p=>path.join(sampleRoot,p));
process.env.VOIDPLAYER_WASM_CORE_DIR=path.join(repo,'public/vendor/voidplayer-core');
process.env.VOIDPLAYER_ANALYSIS_CORE_DIR=path.join(repo,'public/vendor/voidplayer-analysis');
const identity=JSON.parse(await readFile(path.join(repo,'dist/build-info.json'),'utf8'));
const report={label,engine,mode,fixtureFilter:process.env.VP_EVIDENCE_FILE??null,instrumented:mode==='io',startedAt:new Date().toISOString(),head:execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),build:identity,method:{headless:true,osDiskCacheFlushed:false,sameFixturePaths:true,colorMode:mode==='io'?'reference/software depth2':'original defaults',serverRss:'10ms samples of this Node process including its Worker threads; not client or combined application peak',mainHeap:'Chromium performance.memory only; Worker/WASM/GPU excluded',wasmLinearMemory:'Supplemental IO runs wrap the actual ccall boundary and capture HEAPU8.byteLength after calls. This is reserved linear capacity, not live malloc bytes or RSS. Core IDs/Worker lifecycle and accepted compressed packet counts are recorded; container-internal packet advancement remains unavailable.',unknownMemoryFields:null},rows:[]};
const save=()=>{for(const row of report.rows)for(const phase of row.phases??[]){phase.completedMediaBodyBytes=phase.mediaRequests?.reduce((n,r)=>n+(r.bodyBytes??0),0)??0;phase.completedIndexBodyBytes=phase.indexRequests?.reduce((n,r)=>n+(r.bodyBytes??0),0)??0;phase.incompleteResponseBodies=[...(phase.mediaRequests??[]),...(phase.indexRequests??[])].filter(r=>!r.completed).length;}return writeFile(path.join(out,`${label}-${engine}-${mode}.json`),JSON.stringify(report,null,2)+'\n');};
async function fixtureServer(){
 const tmp=await mkdtemp(path.join(os.tmpdir(),'vp-demux-evidence-'));
 const library=new MediaLibraryIndex(roots,{database:path.join(tmp,'library.sqlite'),watch:false});
 await library.refresh();
 const builds=[],pending=new Set(),seen=new Set();let phase='setup';
 const startBuild=library.indexJobs.startBuild.bind(library.indexJobs);
 library.indexJobs.startBuild=(...args)=>{const h=startBuild(...args);if(!seen.has(h.buildId)){seen.add(h.buildId);const startedPhase=phase,started=performance.now();const p=h.promise.then(result=>builds.push({buildId:h.buildId,phase:startedPhase,wallMs:performance.now()-started,identity:args[0].identity,...result}),error=>builds.push({phase:startedPhase,error:String(error)})).finally(()=>pending.delete(p));pending.add(p);}return h;};
 const server=createMediaServer({roots,library,staticDir:path.join(repo,'dist'),onLog(){}});const requests=[];
 server.on('request',(req,res)=>{const pathname=(req.url??'').split('?')[0];if(!/^\/api\/media\/[^/?]+(?:\/frame-index)?$/.test(pathname)||!['GET','HEAD'].includes(req.method))return;const startedPhase=phase,row={kind:pathname.endsWith('/frame-index')?'index':'media',method:req.method,phase:startedPhase,range:req.headers.range??null,completed:false,bodyBytes:null,status:null};requests.push(row);res.on('finish',()=>{row.completed=true;row.status=res.statusCode;const n=Number(res.getHeader('content-length'));row.bodyBytes=req.method==='HEAD'?0:Number.isFinite(n)?n:null;});res.on('close',()=>{if(!res.writableFinished)row.status=res.statusCode;});});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 return{library,server,requests,builds,pending,setPhase:v=>phase=v,base:`http://127.0.0.1:${server.address().port}`,async close(){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await library.close();await rm(tmp,{recursive:true,force:true});}};
}
async function heap(page){return page.evaluate(()=>performance.memory?{usedJSHeapSize:performance.memory.usedJSHeapSize,totalJSHeapSize:performance.memory.totalJSHeapSize,jsHeapSizeLimit:performance.memory.jsHeapSizeLimit}:null).catch(()=>null);}
let browser;
try{
 if(mode==='bench'){
  const service=await fixtureServer();
  try{const env={...process.env,BASE_URL:service.base,BENCH_REPORT:path.join(out,`${label}-${engine}-original-bench.json`)};for(const key of Object.keys(env))if(key.startsWith('BENCH_')&&key!=='BENCH_REPORT')delete env[key];
   const child=spawn(process.execPath,['scripts/bench-playback.mjs',engine,'--headless'],{cwd:repo,env,stdio:['ignore','pipe','pipe']});
   child.stdout.on('data',x=>process.stdout.write(x));child.stderr.on('data',x=>process.stderr.write(x));
   report.exit=await new Promise(resolve=>{child.once('error',error=>resolve({error:String(error)}));child.once('close',(code,signal)=>resolve({code,signal}));});
   report.rows=JSON.parse(await readFile(env.BENCH_REPORT,'utf8'));report.serverBuilds=service.builds;
  }finally{await service.close();}
 }else{
  browser=await playwright[engine].launch({headless:true,...(engine==='chromium'?{args:['--enable-precise-memory-info']}: {})});
  const fixtures=[['js-container','h264.ts'],['js-container','hevc.ts'],['js-container','hevc10.mkv'],['video','ffv1_yuv444p10le.mkv'],['video','mpeg2_10s_1280x720.ts'],['video','av1_10s_1920x1080.webm'],['demux-removal','h264-audio.ts'],['demux-removal','prores.mov']];
  for(const [dir,name] of fixtures.filter(([,name])=>!process.env.VP_EVIDENCE_FILE||name===process.env.VP_EVIDENCE_FILE)){
   const file=path.join(sampleRoot,dir,name),bytes=await readFile(file),row={name,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),phases:[]};report.rows.push(row);
   const service=await fixtureServer(),context=await browser.newContext({viewport:{width:1280,height:800},locale:'zh-CN'}),page=await context.newPage();page.setDefaultTimeout(90000);
   const errors=[];page.on('pageerror',e=>errors.push(String(e)));
   if(mode==='io'){await page.addInitScript(()=>{
    window.__vpEvidenceCores={};window.__vpEvidencePhasePeak=0;let nextWorker=0;const Base=Worker;
    window.Worker=class extends Base{
     constructor(url,options){super(url,options);this.evidenceId=++nextWorker;this.addEventListener('message',event=>{if(event.data?.type!=='vp-evidence-core')return;const value=event.data.value;window.__vpEvidenceCores[value.id]={...value,worker:this.evidenceId,active:true};const capacity=Object.values(window.__vpEvidenceCores).filter(c=>c.active).reduce((n,c)=>n+c.linearCapacityBytes,0);window.__vpEvidencePhasePeak=Math.max(window.__vpEvidencePhasePeak,capacity);});}
     terminate(){for(const core of Object.values(window.__vpEvidenceCores))if(core.worker===this.evidenceId)core.active=false;return super.terminate();}
    };
   });
   // Supplemental IO/memory runs instrument the existing JS ccall boundary;
   // original benchmark invocations above remain entirely unchanged.
   await page.route('**/vendor/voidplayer-core/*.js*',async route=>{
    const response=await route.fetch(),body=await response.text();let matched=false;
    const wrapped=body.replace(/export\s+default\s+([\w$]+)\s*;/,(_,name)=>{matched=true;return `const evidenceOriginal=${name};export default async options=>{const core=await evidenceOriginal(options),id=crypto.randomUUID(),calls={},callWallMs={};let packets=0,family=null;const publish=()=>self.postMessage({type:'vp-evidence-core',value:{id,linearCapacityBytes:core.HEAPU8.byteLength,packetsAccepted:packets,family,calls:{...calls},callWallMs:{...callWallMs}}});const ccall=core.ccall;core.ccall=function(name,result,types,args){const started=performance.now(),value=ccall.call(core,name,result,types,args);callWallMs[name]=(callWallMs[name]??0)+performance.now()-started;calls[name]=(calls[name]??0)+1;if(['vp_packet_open','vp_packet_open_config'].includes(name))family='packet';if(['vp_open','vp_open_blob','vp_open_range'].includes(name))family='container';if(name==='vp_packet_send'&&args?.[4]===0&&value===0)packets++;publish();return value;};publish();return core;};`;});
    if(!matched)throw Error('Core export not instrumented');await route.fulfill({response,body:wrapped});
   });
   }
   const coreSnapshot=()=>page.evaluate(()=>({cores:structuredClone(window.__vpEvidenceCores??{}),maxObservedActiveLinearCapacityBytes:window.__vpEvidencePhasePeak??null}));
   const call=(name,args={})=>page.evaluate(({name,args})=>window.voidPlayer.tools.find(t=>t.name===name).execute(args),{name,args});
   const state=()=>call('get_review_session');
   async function measure(name,operation){service.setPhase(name);await page.evaluate(()=>{window.__vpEvidencePhasePeak=Object.values(window.__vpEvidenceCores??{}).filter(c=>c.active).reduce((n,c)=>n+c.linearCapacityBytes,0);});const coreBefore=await coreSnapshot();const before=process.memoryUsage().rss;let max=before;const sample=setInterval(()=>{max=Math.max(max,process.memoryUsage().rss);},10);const start=performance.now();const record={phase:name,mainHeapBefore:await heap(page),serverRssBeforeBytes:before,workerMemoryBytes:null,wasmMemoryBytes:null,gpuMemoryBytes:null,totalApplicationPeakBytes:null};row.phases.push(record);try{record.result=await operation();record.wallMs=performance.now()-start;}catch(error){record.error=String(error);record.wallMs=performance.now()-start;throw error;}finally{clearInterval(sample);record.serverMaxObservedRssBytes=Math.max(max,process.memoryUsage().rss);record.serverRssAfterBytes=process.memoryUsage().rss;record.mainHeapAfter=await heap(page);record.wasmCoreBefore=coreBefore;record.wasmCoreAfter=await coreSnapshot();record.wasmLinearCapacityMaxObservedBytes=mode==='io'?record.wasmCoreAfter.maxObservedActiveLinearCapacityBytes:null;record.mediaRequests=service.requests.filter(x=>x.phase===name&&x.kind==='media');record.indexRequests=service.requests.filter(x=>x.phase===name&&x.kind==='index');record.packetInputsAcceptedDelta=Object.values(record.wasmCoreAfter.cores).reduce((n,c)=>n+c.packetsAccepted-(coreBefore.cores[c.id]?.packetsAccepted??0),0);record.decoderPacketsAdvanced=mode!=='io'?null:Object.values(record.wasmCoreAfter.cores).some(c=>c.family==='container'&&(c.active||!coreBefore.cores[c.id]))?null:record.packetInputsAcceptedDelta;record.completedMediaBodyBytes=record.mediaRequests.reduce((sum,x)=>sum+(x.bodyBytes??0),0);record.incompleteResponseBodies=record.mediaRequests.filter(x=>!x.completed).length;await save();}}
   try{
    await page.addInitScript(()=>{localStorage.setItem('voidplayer.color-mode','reference');localStorage.setItem('voidplayer.reference-decode',JSON.stringify({decoder:'software',depth:2}));});
    await page.goto(service.base);await page.waitForFunction(()=>window.voidPlayer?.tools);
    const entry=(await call('list_library',{search:name})).entries.find(x=>x.name===name);if(!entry)throw Error('Missing '+name);
    row.libraryIdentity={id:entry.id,version:entry.version};
    for(const repeat of ['cold','warm1','warm2']){
     await measure(`${repeat}:open`,async()=>{return page.evaluate(async id=>{const call=(name,args={})=>window.voidPlayer.tools.find(t=>t.name===name).execute(args),start=performance.now();const result=await call('load_library_item',{id,slot:'A'}),loadAndPresentMs=performance.now()-start;if(result?.error)throw Error(result.error);return{loadAndPresentMs,tool:result,track:(await call('get_review_session')).tracks[0],presented:await call('get_presented_frame',{slot:'A'})};},entry.id);});
     await measure(`${repeat}:index-settle`,async()=>{await page.waitForFunction(()=>window.voidPlayer.getState().tracks[0]?.indexState!=='building',null,{timeout:90000});await Promise.allSettled([...service.pending]);const track=(await state()).tracks[0];if(track.indexState==='error'||track.failure)throw Error(track.indexError??JSON.stringify(track.failure));return track;});
     const track=(await state()).tracks[0];if(!track?.frame)throw Error('No first frame');
     for(const fraction of [.6,.93])await measure(`${repeat}:seek${fraction}`,async()=>{const ptsUs=Math.floor(track.durationUs*fraction);return page.evaluate(async ptsUs=>{const call=(name,args={})=>window.voidPlayer.tools.find(t=>t.name===name).execute(args),start=performance.now();await call('seek_review',{ptsUs});const seekAndPresentMs=performance.now()-start;return{requestedUs:ptsUs,seekAndPresentMs,track:(await call('get_review_session')).tracks[0],presented:await call('get_presented_frame',{slot:'A'})};},ptsUs);});
     if(/^(h264|hevc)/.test(name))await measure(`${repeat}:analysis-cancel`,async()=>{const started=await page.evaluate(async()=>{window.__demuxAnalysisSettled=false;window.__demuxAnalysisPromise=window.voidPlayer.tools.find(t=>t.name==='request_bitstream_stream').execute({slot:'A'}).catch(error=>({error:String(error)})).finally(()=>window.__demuxAnalysisSettled=true);await new Promise(r=>setTimeout(r,0));return!window.__demuxAnalysisSettled;});const t=performance.now();await call('cancel_bitstream_analysis',{slot:'A'});await page.evaluate(()=>window.__demuxAnalysisPromise);return{actuallyPending:started,cancelAndSettleMs:performance.now()-t,state:await call('get_bitstream_analysis_state',{slot:'A'})};});
     await measure(`${repeat}:close`,async()=>{await call('remove_review_track',{slot:'A'});return{tracks:(await state()).tracks.length};});
    }
   }catch(error){row.error=String(error);console.error('IO ERROR',label,engine,name,row.error);}
   finally{row.serverBuilds=service.builds;row.errors=errors;await context.close();await service.close();await save();console.log('IO DONE',label,engine,name,row.error??'ok');}
  }
 }
}catch(error){report.error=String(error);throw error;}finally{await browser?.close();report.finishedAt=new Date().toISOString();await save();}
