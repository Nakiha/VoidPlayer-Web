// Local, opt-in experiment. Run in the experimental snapshot; no media upload.
import {createServer} from 'vite';
import {chromium,webkit} from 'playwright';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {platform,release,arch} from 'node:os';
import {resolve} from 'node:path';
const gpuMode=process.env.PROBE_GPU_MODE??'external', skipThroughput=process.env.PROBE_SKIP_THROUGHPUT==='1';
if(!['external','copy','strict','hybrid','planes','webkit-planes'].includes(gpuMode))throw new Error('Invalid GPU mode');
const maxColorError=process.env.PROBE_MAX_COLOR_ERROR===undefined?null:Number(process.env.PROBE_MAX_COLOR_ERROR);
if(maxColorError!==null&&(!Number.isFinite(maxColorError)||maxColorError<0))throw new Error('Invalid color error limit');
const browserName=process.env.PROBE_BROWSER??'chromium';
if(!['chromium','webkit'].includes(browserName))throw new Error('Invalid browser');
if (!process.argv.slice(2).length) throw new Error('Pass one or more FLV fixture paths');
const output=resolve(process.env.PROBE_OUT??'artifacts/color/webgpu');
await mkdir(output,{recursive:true});
const server=await createServer({configLoader:'runner',cacheDir:resolve('artifacts/color/webgpu-vite-cache'),server:{host:'127.0.0.1',port:0}});
let browser, deadline;
const probeDigest=createHash('sha256');
for(const name of ['diagnose-webgpu-color.mjs','../src/webgpu-color-surface.mjs','../src/webgpu-yuv-kernel.mjs'])probeDigest.update(await readFile(new URL(name,import.meta.url)));
const report={probeDigest:probeDigest.digest('hex'),environment:{platform:platform(),release:release(),arch:arch()},startedAt:new Date().toISOString(),browserName,gpuMode,skipThroughput,measurement:'SDR source-sized GPU capture; excludes physical display. Throughput probe is not session playback benchmark.'};
try {
 await server.listen();
 browser=await(browserName==='webkit'?webkit:chromium).launch({headless:false,...(browserName==='chromium'?{channel:'chrome'}:{})});
 deadline=setTimeout(()=>{report.timeout=true;void browser.close();},180000);
 report.browser=browser.version();
 const page=await browser.newPage({viewport:{width:1280,height:800}});
 page.setDefaultTimeout(180000);
 page.on('pageerror',e=>console.error(e.message));
 await page.route('**/webgpu-probe',r=>r.fulfill({contentType:'text/html',body:'<title>WebGPU color experiment</title><input type="file" multiple><main></main>'}));
 await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/webgpu-probe`);
 await page.locator('input').setInputFiles(process.argv.slice(2).map(p=>resolve(p)));
 report.result=await page.evaluate(async({gpuMode,skipThroughput})=>{
  const {createExternalSurface,wasmVideoFrame}=await import('/scripts/webgpu-color-surface.mjs');
  const {openPacketMedia}=await import('/src/packet-media.ts');
  const {resolveYuvColor,validateYuv,yuvToRgba,yuvSample}=await import('/src/yuv-color.ts');
  const {compareRgba}=await import('/src/color-evidence.ts');
  const {buildInfo}=await import('/src/build-info.ts');
  const {prepareYuvFrame}=await import('/src/yuv-frame.ts');
  const result={buildInfo,files:[],synthetic:[],readbacksDuringThroughput:0};
  const canvas=document.createElement('canvas');document.querySelector('main').append(canvas);
  const gpu=await createExternalSurface(canvas,undefined,gpuMode==='strict'?'external':gpuMode);result.adapter=gpu.adapter;
  const convert=f=>['hybrid','planes','webkit-planes'].includes(gpuMode)&&f.kind==='yuv'?{...f,displayWidth:f.description.width,displayHeight:f.description.height,colorSpace:{toJSON:()=>f.description.color},close(){}}:f.kind==='video-sample'?f.sample.toVideoFrame():wasmVideoFrame(f,resolveYuvColor,validateYuv);
  try {
   // Known black/white/neutral and chromatic values exercise constructor and GPU.
   for(const layoutName of (gpuMode==='strict'?[]:['I420','I422','I444','NV12']))for(const depth of (layoutName==='NV12'?[8]:[8,10,12]))for(const matrix of ['bt709','smpte170m','bt2020-ncl'])for(const fullRange of [false,true]){
    const scale=2**(depth-8),size=8,bytes=depth===8?1:2;
    const subsampleX=layoutName==='I444'?0:1,subsampleY=['I420','NV12'].includes(layoutName)?1:0,semiplanar=layoutName==='NV12';
    let length=0;const planes=Array.from({length:semiplanar?2:3},(_,i)=>{
      const width=size/(i?2**subsampleX:1),height=size/(i?2**subsampleY:1),stride=width*bytes*(i&&semiplanar?2:1);
      const p={offset:length,stride,width,height};length+=height*stride;return p;
    });
    const raw=new Uint8ClampedArray(length),view=new DataView(raw.buffer);
    for(let c=0;c<3;c++){
      const p=planes[semiplanar&&c?1:c];
      for(let y=0;y<p.height;y++)for(let x=0;x<p.width;x++){
        const block=Math.floor(x*(c?2**subsampleX:1)/2);
        const code=c===0?(block===0?(fullRange?0:16*scale):block===1?(fullRange?2**depth-1:235*scale):126*scale):(block<2?128*scale:(c===1?80:180)*scale);
        const pos=p.offset+y*p.stride+x*bytes*(semiplanar&&c?2:1)+(semiplanar&&c===2?bytes:0);
        if(bytes===1)raw[pos]=code;else view.setUint16(pos,code,true);
      }
    }
    const d={width:size,height:size,codedWidth:size,codedHeight:size,visibleRect:{x:0,y:0,width:size,height:size},byteLength:raw.length,
      color:{matrix,fullRange,transfer:'bt709',primaries:matrix==='bt2020-ncl'?'bt2020':'bt709'},
      yuv:{bitDepth:depth,bitShift:0,subsampleX,subsampleY,semiplanar,planes}};
    let frame;
    try{frame=convert({kind:'yuv',pixels:raw,description:d,sourcePtsUs:0});gpu.present(frame);const pixels=await gpu.capture();result.synthetic.push({layoutName,depth,matrix,fullRange,resource:frame.colorSpace.toJSON(),toStrictReference:compareRgba(yuvToRgba(d,raw),pixels),black:[...pixels.slice(0,3)],white:[...pixels.slice(8,11)]});}
    catch(e){result.synthetic.push({layoutName,depth,matrix,fullRange,error:String(e)});}finally{frame?.close();}
   }
   for(const file of document.querySelector('input').files){
    const container=String.fromCharCode(...new Uint8Array(await file.slice(0,3).arrayBuffer()))==='FLV'?'flv':'mp4';
    const item={name:file.name,pairs:[],throughput:[]};result.files.push(item);const sources={};
    try {
     for(const mode of ['native','wasm']){sources[mode]=await openPacketMedia(container,{file},file,{forceWasm:mode==='wasm',nativeColorMode:gpuMode==='strict'?undefined:'browser'});if(mode==='native'&&sources[mode].info.decoder!=='webcodecs')throw new Error('Native decoder unavailable');}
     for(const pts of (gpuMode==='strict'?[]:[0,1000000])){
      const pair={requestedPtsUs:pts},pixels={},strict={},viewport={};let nativePlanes;item.pairs.push(pair);
      for(const mode of ['native','wasm']){
       const f=await sources[mode].frameAt(pts);let resource,copiedDiagnostic;
       try{if(mode==='native')copiedDiagnostic=await prepareYuvFrame({...f,close(){}});resource=convert(f);gpu.present(resource);pixels[mode]=await gpu.capture();pair[mode]={sourcePtsUs:f.sourcePtsUs,width:resource.displayWidth,height:resource.displayHeight,kind:f.kind,copyMs:f.copyMs??0,description:f.description,resourceColor:resource.colorSpace.toJSON()};
        const canvasPixels=v=>{const c=new OffscreenCanvas(v.displayWidth,v.displayHeight);const ctx=c.getContext('2d',{colorSpace:'srgb'});ctx.drawImage(v,0,0);return ctx.getImageData(0,0,c.width,c.height).data;};
        // Native resources stay exclusively in the GPU path during this comparison.
        gpu.present(resource,640,360);viewport[mode]=await gpu.capture(true);
        if(mode==='native'){
          // Explicit diagnostic only: borrow the sample; the enclosing finally
          // owns f.close(). Exact copied planes retain resource tags unchanged.
          const copied=copiedDiagnostic;let rebuilt;
          try{
            if(copied.kind==='yuv'){
              strict[mode]=yuvToRgba(copied.description,copied.pixels);nativePlanes={description:copied.description,pixels:copied.pixels};
              rebuilt=wasmVideoFrame(copied,resolveYuvColor,validateYuv);gpu.present(rebuilt);
              pixels.rebuilt=await gpu.capture();
              pair.nativeOriginalToRebuilt=compareRgba(pixels.native,pixels.rebuilt);
              pair.rebuiltDescription=copied.description;
              pair.native.externalToStrict=compareRgba(pixels.native,strict[mode]);
              pair.native.samples=Array.from({length:17},(_,i)=>{const x=Math.min(copied.description.width-1,Math.floor(i*copied.description.width/17)),y=Math.floor(copied.description.height/2),j=(y*copied.description.width+x)*4;return{x,y,yuv:[0,1,2].map(c=>yuvSample(copied.pixels,copied.description.yuv,c,x,y)),native:[...pixels.native.slice(j,j+3)],strict:[...strict[mode].slice(j,j+3)]};});
              if(copied.description.color.transfer==='bt709'&&copied.description.color.primaries==='bt709'){
                const converted=new Uint8ClampedArray(strict[mode]);
                for(let j=0;j<converted.length;j++)if(j%4!==3){const v=converted[j]/255;const linear=v<0.081?v/4.5:((v+0.099)/1.099)**(1/0.45);converted[j]=Math.round(255*(linear<=0.0031308?12.92*linear:1.055*linear**(1/2.4)-0.055));}
                pair.native.to709DecodedSrgbReference=compareRgba(pixels.native,converted);
              }
              pair.rebuiltExternalToStrict=compareRgba(pixels.rebuilt,strict[mode]);
            }
          }finally{rebuilt?.close();copied.close();}
        }else{
          strict[mode]=yuvToRgba(f.description,f.pixels);pair.wasm.samples=pair.native.samples?.map(({x,y})=>({x,y,yuv:[0,1,2].map(c=>yuvSample(f.pixels,f.description.yuv,c,x,y))}));
          if(nativePlanes){
            const a=nativePlanes.description,b=f.description,la=a.yuv,lb=b.yuv;
            if(a.codedWidth===b.codedWidth&&a.codedHeight===b.codedHeight&&la.bitDepth===lb.bitDepth&&la.subsampleX===lb.subsampleX&&la.subsampleY===lb.subsampleY){
              let samples=0,different=0,max=0;
              for(let c=0;c<3;c++)for(let y=0;y<a.codedHeight;y+=c?2**la.subsampleY:1)for(let x=0;x<a.codedWidth;x+=c?2**la.subsampleX:1){
                const delta=Math.abs(yuvSample(nativePlanes.pixels,la,c,x,y)-yuvSample(f.pixels,lb,c,x,y));samples++;if(delta)different++;max=Math.max(max,delta);
              }
              pair.rawYuvCodes={samples,different,max};
            }else pair.rawYuvCodes={notCompared:'Geometry or bit depth differs'};
          }
          pair.wasm.externalToStrict=compareRgba(pixels.wasm,strict[mode]);
        }
       }
       finally{resource?.close();f.close();}
      }
      if(pair.native.sourcePtsUs===pair.wasm.sourcePtsUs&&pair.native.width===pair.wasm.width&&pair.native.height===pair.wasm.height)pair.nativeToWasm=compareRgba(pixels.native,pixels.wasm);else pair.notCompared='PTS or dimensions differ';
      if(!pair.notCompared&&viewport.native&&viewport.wasm)pair.nativeToWasmViewport=compareRgba(viewport.native,viewport.wasm);
      if(!pair.notCompared&&strict.native&&strict.wasm)pair.nativeToWasmStrict=compareRgba(strict.native,strict.wasm);
      if(!pair.notCompared&&pixels.rebuilt)pair.nativeRebuiltToWasm=compareRgba(pixels.rebuilt,pixels.wasm);
     }
     // Bounded queue; real sequential decode + upload + GPU completion. No capture.
     // This deliberately measures maximum throughput, not scheduler/scanout pacing.
     for(const modes of (skipThroughput?[]:[['native'],['wasm'],['native','wasm']]))for(let repeat=0;repeat<3;repeat++){
      const surfaces=await Promise.all(modes.map(async()=>{
        const c=document.createElement('canvas');const stage=document.createElement('div');stage.className='frame-stage';stage.append(c);document.querySelector('main').append(stage);
        if(gpuMode!=='strict')return{c:stage,s:await createExternalSurface(c,gpu.device,gpuMode)};
        const {paintFrame,setPresentationGeometry}=await import('/src/presenter.ts');
        return{c:stage,s:{errors:[],present(f,w,h){setPresentationGeometry(c,{width:w,height:h,imageWidth:w,imageHeight:h,zoom:1,offsetX:0,offsetY:0,dpr:1});paintFrame(c,f);},
          async drain(){const gl=stage.querySelector('.frame-presentation')?.getContext('webgl');if(!gl)throw new Error('Strict benchmark requires WebGL');gl.finish();},dispose(){setPresentationGeometry(c,null);}}};
      }));
      let count=0;const positions=modes.map(()=>0),start=performance.now();
      try{
       for(let n=0;n<60;n++)for(let i=0;i<modes.length;i++){
        const source=sources[modes[i]];const frames=n===0?[await source.frameAt(0)]:await source.framesAfter(positions[i],1);
        if(!frames.length)continue;
        const f=frames[0];if(gpuMode==='strict'&&modes[i]==='native'&&f.kind==='yuv')result.readbacksDuringThroughput++;if(n>0&&f.ptsUs<=positions[i]){f.close();throw new Error('Non-advancing benchmark PTS');}positions[i]=f.ptsUs;let resource;
        try{resource=gpuMode==='strict'?undefined:convert(f);surfaces[i].s.present(resource??f,640,360);count++;}finally{resource?.close();f.close();}
        if(n%3===2)await surfaces[i].s.drain();
       }
       await Promise.all(surfaces.map(x=>x.s.drain()));
       const elapsedMs=performance.now()-start;item.throughput.push({modes,repeat,count,elapsedMs,aggregateFps:count*1000/elapsedMs,lastPtsUs:positions,errors:surfaces.flatMap(x=>x.s.errors)});
      }finally{for(const {c,s}of surfaces){s.dispose();c.remove();}}
     }
    }catch(e){item.error=String(e);}finally{for(const s of Object.values(sources))s.dispose();}
   }
   await gpu.drain();result.errors=gpu.errors;return result;
  }finally{gpu.dispose();canvas.remove();}
 },{gpuMode,skipThroughput});
 const pairs=report.result.files.flatMap(f=>f.pairs);
 report.summary={comparedPairs:pairs.filter(p=>p.nativeToWasm).length,identicalPairs:pairs.filter(p=>p.nativeToWasm?.max===0).length,supportedFormatCases:report.result.synthetic.filter(s=>!s.error).length,rejectedFormatCases:report.result.synthetic.filter(s=>s.error).length,throughputRuns:report.result.files.flatMap(f=>f.throughput).length};
 report.summary.colorErrorLimit=maxColorError;
 if(pairs.some(p=>!p.nativeToWasm||!p.nativeToWasmViewport||p.error||(maxColorError!==null&&(p.nativeToWasm.max>maxColorError||p.nativeToWasmViewport.max>maxColorError))))process.exitCode=1;
 if(report.result?.errors?.length || report.result?.files?.some(f=>f.error) || report.result?.synthetic?.some(s=>s.error)) process.exitCode=1;
}catch(e){report.error=String(e);process.exitCode=1;}
finally{clearTimeout(deadline);await browser?.close();await server.close();await writeFile(resolve(output,'report.json'),JSON.stringify(report,null,2));}
console.log(JSON.stringify(report));
