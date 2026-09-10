// Production resource contracts vs independently decoded FFmpeg planes. No WASM core
// is required: this tests presentation parity, not the WASM ABI/decoder itself.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {platform,release,arch} from 'node:os';
import {createServer} from 'vite';
import {chromium} from 'playwright';
import {createHash} from 'node:crypto';

const channels=[],args=process.argv.slice(2);let localFile,pipeline='auto';
for(let i=0;i<args.length;i++){if(args[i]==='--file'){assert.ok(args[i+1],'--file needs a local path');localFile=resolve(args[++i]);}else if(args[i]==='--pipeline'){pipeline=args[++i];assert.ok(['auto','unified'].includes(pipeline));}else channels.push(args[i]);}
if(!channels.length)channels.push('chrome','msedge');
if(channels.some(c=>!['chrome','msedge'].includes(c)))throw new Error('Expected chrome and/or msedge');
if(platform()!=='win32')throw new Error('Run Windows acceptance on Windows');
const out=resolve((localFile?'artifacts/color/windows-file':'artifacts/color/windows')+(pipeline==='unified'?'-unified':''));await mkdir(out,{recursive:true});
const w=192,h=144,limit=2;
const cases=localFile?[]:[
 {name:'h264-709-limited',encoder:'libx264',depth:8,matrix:'bt709',primaries:'bt709',fullRange:false},
 {name:'h264-709-full',encoder:'libx264',depth:8,matrix:'bt709',primaries:'bt709',fullRange:true},
 {name:'h264-601',encoder:'libx264',depth:8,matrix:'smpte170m',primaries:'smpte170m',fullRange:false},
 {name:'h264-2020-sdr',encoder:'libx264',depth:8,matrix:'bt2020nc',primaries:'bt2020',fullRange:false},
 {name:'hevc-709-8bit',encoder:'libx265',depth:8,matrix:'bt709',primaries:'bt709',fullRange:false},
 {name:'hevc-709-10bit',encoder:'libx265',depth:10,matrix:'bt709',primaries:'bt709',fullRange:false},
];
const ffmpeg=args=>execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-y',...args],{timeout:60000,stdio:['ignore','pipe','pipe']});
for(const c of cases){
 const bytes=c.depth===8?1:2,scale=2**(c.depth-8),raw=Buffer.alloc(w*h*3/2*bytes);
 // Neutral endpoints, midtones, saturated and intermediate chroma, including
 // clipped colors. 4x3 blocks, aligned to 4:2:0 boundaries.
 const patches=[[16,128,128],[235,128,128],[64,128,128],[160,128,128],
  [100,80,180],[140,180,80],[120,70,90],[150,170,160],
  [100,110,150],[180,140,100],[80,160,140],[200,100,120]];
 let offset=0;
 for(let plane=0;plane<3;plane++){
  const pw=plane?w/2:w,ph=plane?h/2:h;
  for(let y=0;y<ph;y++)for(let x=0;x<pw;x++){
   let code=patches[Math.min(2,Math.floor(y*3/ph))*4+Math.floor(x*4/pw)][plane];
   if(c.fullRange&&plane===0)code=Math.round((code-16)*255/219);
   if(bytes===1)raw[offset++]=code;else{raw.writeUInt16LE(code*scale,offset);offset+=2;}
  }
 }
 const input=resolve(out,`${c.name}.input.yuv`),video=resolve(out,`${c.name}.mp4`),reference=resolve(out,`${c.name}.decoded.yuv`);
 await writeFile(input,raw);
 const pix=c.depth===8?'yuv420p':'yuv420p10le';
 ffmpeg(['-f','rawvideo','-pixel_format',pix,'-video_size',`${w}x${h}`,'-framerate','2','-i',input,
  '-vf','loop=loop=3:size=1:start=0','-frames:v','4','-c:v',c.encoder,'-preset','fast',
  ...(c.encoder==='libx264'?['-qp','1','-g','4','-bf','0']:['-x265-params','qp=1:keyint=4:bframes=0:log-level=error']),
  '-color_range',c.fullRange?'pc':'tv','-colorspace',c.matrix,'-color_primaries',c.primaries,'-color_trc','bt709','-tag:v',c.encoder==='libx264'?'avc1':'hvc1',video]);
 ffmpeg(['-i',video,'-frames:v','4','-f','rawvideo','-pix_fmt',pix,reference]);
 c.video=video;c.reference=reference;c.width=w;c.height=h;c.times=[0,1000000,0];c.indices=[0,2,0];
 c.probe=JSON.parse(execFileSync('ffprobe',['-v','error','-select_streams','v:0','-show_streams','-of','json',video],{encoding:'utf8'})).streams[0];
 const decoded=await readFile(reference);assert.equal(decoded.length,w*h*3/2*bytes*4);
 c.referenceSha256=createHash('sha256').update(decoded).digest('hex');
}
if(localFile){
 const probe=JSON.parse(execFileSync('ffprobe',['-v','error','-select_streams','v:0','-read_intervals','%+3','-show_streams','-show_frames','-of','json',localFile],{encoding:'utf8',timeout:60000,maxBuffer:8*1024*1024}));
 const stream=probe.streams[0];assert.ok(['yuv420p','yuvj420p','yuv420p10le'].includes(stream.pix_fmt),'Only planar 420 8/10-bit SDR input supported');
 assert.ok(stream.width*stream.height<=16777216&&stream.width%2===0&&stream.height%2===0,'Reference requires even dimensions within 16M pixels');
 assert.ok(!['smpte2084','arib-std-b67'].includes(stream.color_transfer),'SDR only');
 const selected=[0,1,2].map(time=>Math.max(0,probe.frames.findLastIndex(f=>Number(f.best_effort_timestamp_time)<=time)));
 assert.ok(selected.every(i=>i>=0));assert.equal(new Set(selected).size,3,'Need distinct frames at 0/1/2 seconds');
 const frame=probe.frames[selected[0]],depth=stream.pix_fmt.endsWith('10le')?10:8,reference=resolve(out,'local.decoded.yuv');
 for(const index of selected)for(const key of ['width','height','pix_fmt','color_space','color_range','color_transfer','color_primaries'])assert.equal(probe.frames[index][key],frame[key],`Reference ${key} changed`);
 assert.ok(!['smpte2084','arib-std-b67'].includes(frame.color_transfer),'SDR frames only');
 ffmpeg(['-i',localFile,'-vf',`select=${selected.map(i=>`eq(n\\,${i})`).join('+')}`,'-fps_mode','passthrough','-frames:v','3','-pix_fmt',depth===10?'yuv420p10le':'yuv420p','-f','rawvideo',reference]);
 const raw=await readFile(reference);assert.equal(raw.length,stream.width*stream.height*3/2*(depth===10?2:1)*3);
 cases.push({name:'user-local',video:localFile,reference,width:stream.width,height:stream.height,depth,
  matrix:frame.color_space??stream.color_space??null,primaries:frame.color_primaries??stream.color_primaries??null,
  transfer:frame.color_transfer??stream.color_transfer??null,fullRange:(frame.color_range??stream.color_range)==='pc',
  times:selected.map(i=>Math.round(Number(probe.frames[i].best_effort_timestamp_time)*1e6)),indices:[0,1,2],
  probe:stream,referenceFrames:selected.map(i=>probe.frames[i]),referenceSha256:createHash('sha256').update(raw).digest('hex')});
}
const evidence={pipeline,startedAt:new Date().toISOString(),environment:{platform:platform(),release:release(),arch:arch()},
 revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
 ffmpeg:execFileSync('ffmpeg',['-version'],{encoding:'utf8'}).split('\n')[0],
 measurement:'Production auto-profile source capture, native decoder vs FFmpeg CLI raw planes; no WASM ABI, physical display or independently proven hardware decode coverage',
 interiorMaxErrorLimit:limit,results:[]};
const server=await createServer({server:{host:'127.0.0.1',port:0}});let browser;
let failed=false;
try{
 await server.listen();
 for(const channel of channels){
  const entry={channel,cases:[]};evidence.results.push(entry);let deadline;
  try{
   browser=await chromium.launch({channel,headless:false,...(channel==='chrome'&&process.env.CHROME_EXECUTABLE_PATH?{executablePath:process.env.CHROME_EXECUTABLE_PATH}:{})});entry.version=browser.version();
   const runningBrowser=browser;deadline=setTimeout(()=>{entry.timeout=true;void runningBrowser.close();},180000);
   entry.executableOverride=channel==='chrome'?process.env.CHROME_EXECUTABLE_PATH??null:null;
   const page=await browser.newPage();page.setDefaultTimeout(60000);
   let tracing;
   if(process.env.COLOR_TRACE==='1'){
    tracing=await page.context().newCDPSession(page);entry.externalTextureTrace=[];
    tracing.on('Tracing.dataCollected',({value})=>entry.externalTextureTrace.push(...value.filter(e=>e.name==='CreateExternalTexture')));
    await tracing.send('Tracing.start',{categories:'disabled-by-default-webgpu',transferMode:'ReportEvents'});
   }
   entry.pageErrors=[];page.on('pageerror',e=>entry.pageErrors.push(String(e)));
   await page.route(/\/windows-color(?:\?.*)?$/,r=>r.fulfill({contentType:'text/html',body:'<input type="file"><div class="frame-stage"><canvas id="native"></canvas></div><div class="frame-stage"><canvas id="planes"></canvas></div>'}));
   await page.route('**/color-reference/*',async r=>{const c=cases.find(c=>r.request().url().endsWith('/'+c.name));if(!c)return r.abort();await r.fulfill({contentType:'application/octet-stream',body:await readFile(c.reference)});});
   await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/windows-color${pipeline==='unified'?'?colorPipeline=unified':''}`);
   entry.environment=await page.evaluate(async()=>{
    const {initializeGpuPresentation,keepNativeGpuResource}=await import('/src/webgpu-presenter.ts');
    await initializeGpuPresentation([...document.querySelectorAll('canvas')]);
    const adapter=await navigator.gpu?.requestAdapter(),i=adapter?.info;
    const {buildInfo}=await import('/src/build-info.ts');
    return{buildInfo,active:document.querySelectorAll('.frame-presentation').length===2,retainsNative:keepNativeGpuResource(),userAgent:navigator.userAgent,adapter:i?{vendor:i.vendor,architecture:i.architecture,device:i.device,description:i.description,isFallbackAdapter:i.isFallbackAdapter}:null};
   });
   assert.equal(entry.environment.active,true,'Automatic production probe must enable WebGPU');
   assert.ok(entry.environment.adapter&&!entry.environment.adapter.isFallbackAdapter,'Hardware GPU adapter required');
   for(const c of cases){
    try{
    await page.locator('input').setInputFiles(c.video);
    const result=await page.evaluate(async({c,w,h,pipeline,sourceProbe})=>{
     const {openMedia}=await import('/src/media.ts');
     const {paintFrame,captureFrame,setPresentationGeometry}=await import('/src/presenter.ts');
     const {compareRgba}=await import('/src/color-evidence.ts');
     const {yuvSample}=await import('/src/yuv-color.ts');
     const file=document.querySelector('input').files[0];
     const reference=new Uint8Array(await(await fetch(`/color-reference/${c.name}`)).arrayBuffer());
     const source=await openMedia(file,async()=>{const {readLogs}=await import('/src/log.ts');throw new Error(`Native decoder unavailable: ${JSON.stringify((await readLogs({limit:10})).events)}`);});
     const canvases=[document.querySelector('#native'),document.querySelector('#planes')];
     const result={name:c.name,info:source.info,ffprobe:c.probe,referenceFrames:c.referenceFrames,referenceSha256:c.referenceSha256,pairs:[]};
     const geometry={width:w,height:h,imageWidth:w,imageHeight:h,zoom:1,offsetX:0,offsetY:0,dpr:1};
     const pixels=canvas=>{const v=captureFrame(canvas);return v.getContext('2d').getImageData(0,0,v.width,v.height).data;};
     const interior=data=>{if(c.name==='user-local')return data;const a=[];for(let y=0;y<h;y++)for(let x=0;x<w;x++){
      const bx=x%(w/4),by=y%(h/3);if(bx<8||bx>w/4-9||by<8||by>h/3-9)continue;
      a.push(...data.slice((y*w+x)*4,(y*w+x)*4+4));
     }return new Uint8ClampedArray(a);};
     try{
      for(const [index,pts] of c.times.entries()){
       let frame;
       try{
        frame=await source.frameAt(pts);
        if(!['video-sample','yuv'].includes(frame.kind))throw new Error(`Expected native decoded resource, got ${frame.kind}`);
        if(frame.sourcePtsUs!==pts)throw new Error(`Different PTS: ${frame.sourcePtsUs} vs ${pts}`);
        if(frame.width!==w||frame.height!==h)throw new Error('Native/reference dimensions differ');
        const bytes=c.depth===8?1:2,length=w*h*3/2*bytes;
        const raw=new Uint8ClampedArray(reference.slice(c.indices[index]*length,(c.indices[index]+1)*length));
        const color={matrix:c.matrix==='bt2020nc'?'bt2020-ncl':c.matrix,primaries:c.primaries,transfer:c.transfer===undefined?'bt709':c.transfer,fullRange:c.fullRange};
        const description={revision:1,width:w,height:h,codedWidth:w,codedHeight:h,visibleRect:{x:0,y:0,width:w,height:h},displayWidth:w,displayHeight:h,stride:null,byteLength:raw.length,format:'YUV',color,sourceColor:color,
         yuv:{bitDepth:c.depth,bitShift:0,subsampleX:1,subsampleY:1,semiplanar:false,planes:[{offset:0,stride:w*bytes,width:w,height:h},{offset:w*h*bytes,stride:w/2*bytes,width:w/2,height:h/2},{offset:w*h*5/4*bytes,stride:w/2*bytes,width:w/2,height:h/2}]}};
        for(const canvas of canvases)setPresentationGeometry(canvas,geometry);
        paintFrame(canvases[0],frame);paintFrame(canvases[1],{kind:'yuv',description,pixels:raw,width:w,height:h});
        const a=pixels(canvases[0]),b=pixels(canvases[1]);
        // Opt-in source investigation: fixed, named equations, never fitted
        // parameters and never used to alter the actual native/reference pair.
        let sourceHypotheses;
        if(sourceProbe){
         const gamma22ToSrgb=data=>{const out=new Uint8ClampedArray(data);for(let i=0;i<out.length;i++){if(i%4===3)continue;const v=(data[i]/255)**2.2;out[i]=Math.round(255*(v<=.0031308?12.92*v:1.055*v**(1/2.4)-.055));}return out;};
         const diagnosticDescription={...description,color:{...description.color,matrix:'smpte170m'}};
         paintFrame(canvases[1],{kind:'yuv',description:diagnosticDescription,pixels:raw,width:w,height:h});
         const matrix601=pixels(canvases[1]);
         sourceHypotheses={referenceGamma22:compareRgba(a,gamma22ToSrgb(b)),matrix601:compareRgba(a,matrix601),matrix601Interior:compareRgba(interior(a),interior(matrix601)),matrix601Gamma22:compareRgba(a,gamma22ToSrgb(matrix601))};
         paintFrame(canvases[1],{kind:'yuv',description,pixels:raw,width:w,height:h});
        }
        const samplePoints=Array.from({length:12},(_,i)=>({x:Math.floor((i%4+.5)*w/4),y:Math.floor((Math.floor(i/4)+.5)*h/3)}));
        let nativeCanvasBytes;
        if(frame.sample){const nativeCanvas=new OffscreenCanvas(w,h);frame.sample.draw(nativeCanvas.getContext('2d'),0,0,w,h);nativeCanvasBytes=nativeCanvas.getContext('2d').getImageData(0,0,w,h).data;}
        const resource=frame.sample?.toVideoFrame();let copied={notCompared:'Opaque native resource'};
        try{
         if(frame.kind==='yuv'||(['NV12','I420'].includes(resource?.format)&&c.depth===8)){
          const data=frame.pixels??new Uint8ClampedArray(resource.allocationSize());
          const nativeLayout=frame.description.yuv??{bitDepth:8,bitShift:0,subsampleX:1,subsampleY:1,semiplanar:resource.format==='NV12',planes:await resource.copyTo(data)};
          let different=0,max=0,samples=0;
          for(let channel=0;channel<3;channel++)for(let y=0;y<h;y+=channel?2:1)for(let x=0;x<w;x+=channel?2:1){
           const delta=Math.abs(yuvSample(data,nativeLayout,channel,x,y)-yuvSample(raw,description.yuv,channel,x,y));
           samples++;different+=+(delta!==0);max=Math.max(max,delta);
          }
          copied={format:frame.description.format,color:frame.description.color,rawCodes:{samples,different,max},
           centers:samplePoints.map(({x,y})=>({native:[0,1,2].map(i=>yuvSample(data,nativeLayout,i,x,y)),reference:[0,1,2].map(i=>yuvSample(raw,description.yuv,i,x,y))}))};
         }
        }catch(e){copied={error:String(e)};}finally{resource?.close();}
        result.pairs.push({pts,sourcePtsUs:frame.sourcePtsUs,copyMs:frame.copyMs,description:frame.description,executors:canvases.map(v=>v.dataset.colorExecutor),contracts:canvases.map(v=>v.dataset.colorContract),full:compareRgba(a,b),interior:compareRgba(interior(a),interior(b)),
         nativeExternalToCanvas:nativeCanvasBytes?compareRgba(a,nativeCanvasBytes):null,copied,sourceHypotheses,
         centers:samplePoints.map(({x,y})=>({x,y,native:[...a.slice((y*w+x)*4,(y*w+x)*4+3)],planes:[...b.slice((y*w+x)*4,(y*w+x)*4+3)]}))});
       }finally{frame?.close();for(const canvas of canvases)setPresentationGeometry(canvas,null);}
      }
     }finally{source.dispose();}
     return result;
    },{c,w:c.width,h:c.height,pipeline,sourceProbe:process.env.COLOR_TRACE==='1'});
    entry.cases.push(result);
    result.passed=result.pairs.length===3&&result.pairs.every(pair=>(pipeline==='unified'?pair.full.max:pair.interior.max)<=limit&&pair.executors.join(',')===(pipeline==='unified'?'webgpu-yuv,webgpu-yuv':'webgpu-external,webgpu-yuv'));
    if(!result.passed)failed=true;
    console.log(`${channel} ${c.name}: interior max ${Math.max(...result.pairs.map(p=>p.interior.max))}, full max ${Math.max(...result.pairs.map(p=>p.full.max))}`);
    }catch(e){entry.cases.push({name:c.name,error:String(e),passed:false});failed=true;console.error(`${channel} ${c.name}: ${e}`);}
   }
   entry.logs=await page.evaluate(async()=>{const {disposePresentation}=await import('/src/presenter.ts');disposePresentation();const {readLogs}=await import('/src/log.ts');return await readLogs({limit:100});});
   if(tracing){const done=new Promise(resolve=>tracing.once('Tracing.tracingComplete',resolve));await tracing.send('Tracing.end');await done;}
   if(entry.pageErrors.length)failed=true;
  }catch(e){entry.error=String(e);failed=true;console.error(`${channel}: ${e}`);}
  finally{clearTimeout(deadline);await browser?.close();browser=undefined;}
 }
}catch(error){failed=true;evidence.error=String(error);throw error;}
finally{await browser?.close();await server.close();evidence.passed=!failed;await writeFile(resolve(out,'report.json'),JSON.stringify(evidence,null,2));}
console.log(`Local evidence: ${resolve(out,'report.json')}`);
if(failed)process.exitCode=1;
