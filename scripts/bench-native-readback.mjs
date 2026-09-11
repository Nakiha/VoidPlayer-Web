// Bounded, serial native YUV readback experiment. No browser RGB conversion.
import {createServer} from 'vite';
import {chromium} from 'playwright';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
const file=resolve(process.argv[2]??'fixtures/video/mhw_hevc_fullrange_bt709_3s.mp4');
const server=await createServer({server:{host:'127.0.0.1',port:0}});await server.listen();
const reports=[];
try{for(const channel of ['chrome','msedge']){
 const browser=await chromium.launch({headless:false,...(channel==='chrome'&&process.env.CHROME_EXECUTABLE_PATH?{executablePath:process.env.CHROME_EXECUTABLE_PATH}:{channel})});
 try{
  const page=await browser.newPage();
  await page.route('**/readback-test',r=>r.fulfill({headers:{'cross-origin-opener-policy':'same-origin','cross-origin-embedder-policy':'require-corp'},contentType:'text/html',body:'<input type="file"><div class="frame-stage"><canvas></canvas></div>'}));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/readback-test`);await page.locator('input').setInputFiles(file);
  const results=await page.evaluate(async()=>{
   const {openMedia}=await import('/src/media.ts');
   const {initializeGpuPresentation,disposeGpuPresentation}=await import('/src/webgpu-presenter.ts');
   const {createExternalSurface}=await import('/src/webgpu-color-surface.mjs');
   await initializeGpuPresentation([document.querySelector('canvas')]); // retain native samples
   const source=await openMedia(document.querySelector('input').files[0],()=>{throw Error('Native decode required');});
   const canvas=document.createElement('canvas');canvas.width=640;canvas.height=360;document.body.append(canvas);
   const surface=await createExternalSurface(canvas,undefined,'planes'),rows=[];
   const workerURL=URL.createObjectURL(new Blob([`onmessage=async({data:{frame,buffer,shared}})=>{
     try{const rect={x:0,y:0,width:frame.codedWidth,height:frame.codedHeight};const size=frame.allocationSize({rect});
       buffer=buffer?.byteLength===size?buffer:shared?new SharedArrayBuffer(size):new ArrayBuffer(size);
       const start=performance.now();const layout=await frame.copyTo(new Uint8Array(buffer),{rect});const copyMs=performance.now()-start;
       postMessage({buffer,layout,copyMs},shared?[]:[buffer]);
     }catch(error){postMessage({error:String(error)});}finally{frame.close();}
   };`],{type:'text/javascript'}));
   try{for(let repeat=0;repeat<2;repeat++)for(const mode of (repeat?['worker-shared','worker-array','main-shared','main-array']:['main-array','main-shared','worker-array','worker-shared'])){
    const shared=mode.endsWith('shared'),remote=mode.startsWith('worker'),worker=remote?new Worker(workerURL):null;
    let buffer,count=0,total=0;const copies=[],roundTrips=[],uploads=[];let hash,format;
    try{
     for await(const decoded of source.framesFrom(0)){
      let frame;
      try{
       const start=performance.now();frame=decoded.sample.toVideoFrame();format=frame.format;
       if(format!=='NV12'&&format!=='I420')throw Error(`Unsupported readable layout ${format}`);
       let layout,copyMs;
       const copyStart=performance.now();
       if(worker){
        const reply=await new Promise((done,fail)=>{worker.onmessage=e=>e.data.error?fail(Error(e.data.error)):done(e.data);worker.onerror=fail;worker.postMessage({frame,buffer,shared},buffer&&!shared?[frame,buffer]:[frame]);});
        ({buffer,layout,copyMs}=reply);
       }else{
        const rect={x:0,y:0,width:frame.codedWidth,height:frame.codedHeight},size=frame.allocationSize({rect});
        if(buffer?.byteLength!==size)buffer=shared?new SharedArrayBuffer(size):new ArrayBuffer(size);
        const t=performance.now();layout=await frame.copyTo(new Uint8Array(buffer),{rect});copyMs=performance.now()-t;
       }
       roundTrips.push(performance.now()-copyStart);copies.push(copyMs);
       const d=decoded.description,data=new Uint8ClampedArray(buffer);
       const description={...d,byteLength:data.length,yuv:{bitDepth:8,bitShift:0,subsampleX:1,subsampleY:1,semiplanar:format==='NV12',chromaLocation:null,planes:layout.map((p,i)=>({...p,width:Math.ceil(d.codedWidth/(i?2:1)),height:Math.ceil(d.codedHeight/(i?2:1))}))}};
       const upload=performance.now();surface.present({kind:'yuv',description,pixels:data},d.width,d.height);uploads.push(performance.now()-upload);
       await Promise.resolve();await surface.device.queue.onSubmittedWorkDone();total+=performance.now()-start;
       if(count===0)hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',data.slice()))].map(v=>v.toString(16).padStart(2,'0')).join('');
       if(++count===30)break;
      }finally{frame?.close();decoded.close();}
     }
     const stats=a=>{const s=[...a].sort((a,b)=>a-b);return{p50:s[Math.floor(s.length*.5)],p95:s[Math.floor(s.length*.95)],mean:a.reduce((s,x)=>s+x,0)/a.length};};
     rows.push({mode,repeat,count,format,firstFrameSha256:hash,copyMs:stats(copies),roundTripMs:stats(roundTrips),uploadMs:stats(uploads),serialCopyAndGpuMsPerFrame:total/count});
    }catch(error){rows.push({mode,repeat,error:String(error)});}finally{worker?.terminate();}
   }}finally{URL.revokeObjectURL(workerURL);surface.dispose();source.dispose();disposeGpuPresentation();}
   return {crossOriginIsolated,rows};
  });
  reports.push({channel,version:browser.version(),results});console.log(JSON.stringify(reports.at(-1)));
 }finally{await browser.close();}
}}finally{await server.close();await mkdir('artifacts/color',{recursive:true});await writeFile('artifacts/color/native-readback.json',JSON.stringify(reports,null,2));}
if(reports.some(r=>r.results.rows.length!==8||r.results.rows.some(x=>x.error||x.count!==30)||new Set(r.results.rows.map(x=>x.firstFrameSha256)).size!==1))process.exitCode=1;
