// Sustained bounded producer/copy/upload pipeline. Browser process CPU includes
// renderer, workers and GPU/utility processes; summed working sets are not PSS.
import assert from 'node:assert/strict';
import {createServer} from 'vite';
import {chromium} from 'playwright';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {spawn} from 'node:child_process';
const out=resolve('artifacts/color/yuv-pipeline');await mkdir(out,{recursive:true});
const server=await createServer({server:{host:'127.0.0.1',port:0}});await server.listen();
const reports=[];
async function sampleMemory(ids,key){
 const stop=resolve(out,`${key}-${Date.now()}.stop`),samples=[];
 const ps=`$idsToMeasure=@(${ids.join(',')});while(!(Test-Path -LiteralPath '${stop.replaceAll("'","''")}')){$items=@(Get-Process -Id $idsToMeasure -ErrorAction SilentlyContinue);$sum=($items|Measure-Object WorkingSet64 -Sum).Sum;Write-Output $sum;Start-Sleep -Milliseconds 200}`;
 const child=spawn('powershell',['-NoProfile','-NonInteractive','-Command',ps],{windowsHide:true,stdio:['ignore','pipe','pipe']});
 let pending='',ready;const started=new Promise(r=>ready=r);let errors='';child.stderr.on('data',d=>errors+=d);
 child.stdout.on('data',d=>{pending+=d;const lines=pending.split(/\r?\n/);pending=lines.pop();for(const line of lines)if(line.trim()){samples.push(Number(line));ready();}});
 const ended=new Promise(r=>child.once('exit',r));child.once('exit',()=>ready());await started;
 return async()=>{await writeFile(stop,'stop');await ended;return{samples:samples.length,startBytes:samples[0],peakBytes:Math.max(...samples),endBytes:samples.at(-1),errors};};
}
try{for(const channel of ['chrome','msedge'])for(let repeat=0;repeat<2;repeat++){
 const browser=await chromium.launch({headless:false,...(channel==='chrome'&&process.env.CHROME_EXECUTABLE_PATH?{executablePath:process.env.CHROME_EXECUTABLE_PATH}:{channel})});
 try{
  const page=await browser.newPage(),cdp=await browser.newBrowserCDPSession();
  await page.route('**/pipeline-test',r=>r.fulfill({headers:{'cross-origin-opener-policy':'same-origin','cross-origin-embedder-policy':'require-corp'},contentType:'text/html',body:'<input type="file"><div class="frame-stage"><canvas id="retain"></canvas></div><canvas id="output"></canvas>'}));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/pipeline-test`);await page.locator('input').setInputFiles(resolve(process.argv[2]??'fixtures/video/mhw_hevc_fullrange_bt709_3s.mp4'));
  await page.evaluate(async()=>{
   const {initializeGpuPresentation}=await import('/src/webgpu-presenter.ts');await initializeGpuPresentation([document.querySelector('#retain')]);
   const {createExternalSurface}=await import('/src/webgpu-color-surface.mjs');
   const surface=await createExternalSurface(document.querySelector('#output'),undefined,'planes');
   surface.setGeometry({width:960,height:540,imageWidth:960,imageHeight:540,zoom:1,offsetX:0,offsetY:0,dpr:1});
   const workerURL=URL.createObjectURL(new Blob([`onmessage=async({data:{frame,buffer}})=>{try{
     const rect={x:0,y:0,width:frame.codedWidth,height:frame.codedHeight};const size=frame.allocationSize({rect});if(buffer?.byteLength!==size)buffer=new ArrayBuffer(size);
     const start=performance.now(),promise=frame.copyTo(new Uint8Array(buffer),{rect}),syncMs=performance.now()-start;const layout=await promise;
     postMessage({buffer,layout,copyMs:performance.now()-start,syncMs},[buffer]);
   }catch(error){postMessage({error:String(error)});}finally{frame.close();}};`],{type:'text/javascript'}));
   window.preparePipeline=async({backend,depth})=>{
    const file=document.querySelector('input').files[0];
    const source=backend==='wasm'?await(await import('/src/packet-media.ts')).openPacketMedia('mp4',{file},file,{forceWasm:true}):await(await import('/src/media.ts')).openMedia(file,()=>{throw Error('Native decoder required');});
    const warm=await source.frameAt(0);warm.close();
    const slots=Array.from({length:depth},(_,id)=>({id,worker:backend==='worker'?new Worker(workerURL):null,buffer:undefined}));
    window.pipelineCase={source,slots,backend,depth};return{info:source.info,isolated:crossOriginIsolated,hardwareConcurrency:navigator.hardwareConcurrency};
   };
   window.runPipeline=async()=>{
    const {source,slots,backend,depth}=window.pipelineCase,{yuvSample}=await import('/src/yuv-color.ts');
    const free=[...slots],queue=[],fences=[],pts=[],fingerprints=[],copy=[],sync=[],submit=[];
    let ended=false,failure,wakeConsumer,wakeProducer,peakOwned=0,owned=0,copyActive=0,peakCopyActive=0,peakGpuPending=0;
    const start=performance.now();
    async function convert(decoded,slot){
     if(backend==='wasm')return{decoded,data:decoded.pixels,description:decoded.description,pts:decoded.sourcePtsUs};
     const frame=decoded.sample.toVideoFrame(),format=frame.format,d=decoded.description,pts=decoded.sourcePtsUs;decoded.close();
     copyActive++;peakCopyActive=Math.max(peakCopyActive,copyActive);
     try{
      if(!['NV12','I420'].includes(format))throw Error(`Unsupported native format ${format}`);
      let layout;
      if(slot.worker){const reply=await new Promise((done,fail)=>{slot.worker.onmessage=e=>e.data.error?fail(Error(e.data.error)):done(e.data);slot.worker.onerror=fail;slot.worker.postMessage({frame,buffer:slot.buffer},slot.buffer?[frame,slot.buffer]:[frame]);});slot.buffer=reply.buffer;layout=reply.layout;copy.push(reply.copyMs);sync.push(reply.syncMs);}
      else{const rect={x:0,y:0,width:frame.codedWidth,height:frame.codedHeight},size=frame.allocationSize({rect});if(slot.buffer?.byteLength!==size)slot.buffer=new ArrayBuffer(size);
       const t=performance.now(),promise=frame.copyTo(new Uint8Array(slot.buffer),{rect});sync.push(performance.now()-t);layout=await promise;copy.push(performance.now()-t);}
      const data=new Uint8ClampedArray(slot.buffer),description={...d,byteLength:data.length,yuv:{bitDepth:8,bitShift:0,subsampleX:1,subsampleY:1,semiplanar:format==='NV12',chromaLocation:null,planes:layout.map((p,i)=>({...p,width:Math.ceil(d.codedWidth/(i?2:1)),height:Math.ceil(d.codedHeight/(i?2:1))}))}};
      return{data,description,pts};
     }finally{frame.close();copyActive--;}
    }
    const producer=(async()=>{try{
     const iterator=source.framesFrom(0);
     try{while(true){
      while(!free.length)await new Promise(r=>wakeProducer=r);
      const slot=free.shift(),next=await iterator.next();if(next.done){free.push(slot);break;}
      owned++;peakOwned=Math.max(peakOwned,owned);
      const promise=convert(next.value,slot);promise.catch(()=>{});queue.push({slot,promise});wakeConsumer?.();wakeConsumer=undefined;
     }}finally{await iterator.return();}
    }catch(error){failure=error;}finally{ended=true;wakeConsumer?.();}})();
    try{while(!ended||queue.length){
     if(!queue.length){await new Promise(r=>wakeConsumer=r);continue;}
     const {slot,promise}=queue.shift();const frame=await promise;
     try{
      pts.push(frame.pts);let fingerprint=2166136261;
      for(let y=0;y<16;y++)for(let x=0;x<16;x++)for(let c=0;c<3;c++){const v=yuvSample(frame.data,frame.description.yuv,c,Math.floor((x+.5)*frame.description.width/16),Math.floor((y+.5)*frame.description.height/16));fingerprint=Math.imul(fingerprint^v,16777619)>>>0;}
      fingerprints.push(fingerprint);
      const t=performance.now();surface.present({kind:'yuv',description:frame.description,pixels:frame.data},frame.description.width,frame.description.height);submit.push(performance.now()-t);
      // writeBuffer captures bytes now; this CPU slot can be reused after submit.
      await Promise.resolve();fences.push(surface.device.queue.onSubmittedWorkDone());peakGpuPending=Math.max(peakGpuPending,fences.length);
     }finally{frame.decoded?.close();owned--;free.push(slot);wakeProducer?.();wakeProducer=undefined;}
     if(fences.length>=depth)await fences.shift();
    }
    await producer;if(failure)throw failure;await Promise.all(fences);
    const wallMs=performance.now()-start,stats=a=>{const s=[...a].sort((a,b)=>a-b);return a.length?{mean:a.reduce((s,x)=>s+x,0)/a.length,p50:s[Math.floor(s.length*.5)],p95:s[Math.floor(s.length*.95)]}:null;};
    return{backend,depth,frames:pts.length,wallMs,fps:pts.length*1000/wallMs,pts,fingerprints,copyMs:stats(copy),copySyncMs:stats(sync),submitMs:stats(submit),peakOwnedFrames:peakOwned,peakCopyActive,peakGpuPending,ownedYuvBudgetBytes:depth*source.info.width*source.info.height*1.5};
    }finally{surface.clear();}
   };
   window.closePipeline=()=>{for(const slot of window.pipelineCase.slots)slot.worker?.terminate();window.pipelineCase.source.dispose();window.pipelineCase=null;};
  });
  const cases=['wasm','main','worker'].flatMap(backend=>[1,2,4,8].map(depth=>({backend,depth})));if(repeat)cases.reverse();
  for(const config of cases){
   const metadata=await page.evaluate(c=>window.preparePipeline(c),config);
   const info=await cdp.send('SystemInfo.getProcessInfo'),stopMemory=await sampleMemory(info.processInfo.map(p=>p.id),`${channel}-${repeat}-${config.backend}-${config.depth}`);
   const before=await cdp.send('SystemInfo.getProcessInfo');let row;
   try{row=await page.evaluate(()=>window.runPipeline());}
   finally{
    const after=await cdp.send('SystemInfo.getProcessInfo'),memory=await stopMemory();
    const cpuSeconds=after.processInfo.reduce((total,p)=>total+p.cpuTime-(before.processInfo.find(q=>q.id===p.id)?.cpuTime??0),0);
    if(row){row={channel,version:browser.version(),repeat,...row,metadata,cpuSeconds,cpuMsPerFrame:cpuSeconds*1000/row.frames,equivalentBusyCores:cpuSeconds/(row.wallMs/1000),workingSet:memory};reports.push(row);console.log(JSON.stringify({channel,repeat,backend:row.backend,depth:row.depth,fps:row.fps,cpuMsPerFrame:row.cpuMsPerFrame,peakMB:memory.peakBytes/1048576}));}
    await page.evaluate(()=>window.closePipeline());await writeFile(resolve(out,'report.json'),JSON.stringify(reports,null,2));
   }
  }
 }finally{await browser.close();}
}}finally{await server.close();}
const reference=reports[0];assert.ok(reference?.frames>100);
for(const r of reports){assert.deepEqual(r.pts,reference.pts,'All frames must be presented in identical order');assert.deepEqual(r.fingerprints,reference.fingerprints,'Sampled YUV values must match every frame');assert.ok(r.peakOwnedFrames<=r.depth&&r.peakGpuPending<=r.depth);}
console.log('PASS complete ordered frames, sampled YUV parity and bounded pipeline ownership');
