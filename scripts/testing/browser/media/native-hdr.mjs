import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';
import { withBrowserFixture } from '../../browser-fixture.mjs';
import { repositoryRoot } from '../../manifest.mjs';

const args=process.argv.slice(2), channel=args.find(a=>['chrome','msedge'].includes(a));
const experimental=args.includes('--experimental-hdr'),requireNative=args.includes('--require-native'),qa=args.includes('--qa');
const width=384,height=144;
await mkdir(path.join(repositoryRoot,'.run'),{recursive:true});
const root=await mkdtemp(path.join(repositoryRoot,'.run/native-hdr-fixtures-'));
let vite;
try {
  const fixtures=[];
  for(const [transfer,tag] of [['pq',16],['hlg',18]]){
    const levels=transfer==='pq'?[0,.5080784215,.580688881,.751827096,.902572393,1]:[0,.25,.5,.75,.9,1];
    const colors=[...levels.map(v=>[v,v,v]),[.75,.45,.2],[.2,.75,.4],[.3,.2,.75],[.8,.7,.15],[.8,.2,.75],[.2,.75,.8]];
    const pixels=new Uint16Array(width*height*3/2),luma=color=>.2627*color[0]+.6780*color[1]+.0593*color[2];
    for(let y=0;y<height;y++)for(let x=0;x<width;x++)pixels[y*width+x]=Math.round(64+876*luma(colors[Math.floor(x*colors.length/width)]));
    for(let y=0;y<height/2;y++)for(let x=0;x<width/2;x++){
      const color=colors[Math.floor(x*2*colors.length/width)],Y=luma(color),index=y*width/2+x;
      pixels[width*height+index]=Math.round(512+896*(color[2]-Y)/(2*(1-.0593)));
      pixels[width*height*5/4+index]=Math.round(512+896*(color[0]-Y)/(2*(1-.2627)));
    }
    const input=path.join(root,`${transfer}.yuv`),annex=path.join(root,`${transfer}.hevc`);
    await writeFile(input,new Uint8Array(pixels.buffer));
    const codec=['-c:v','libx265','-x265-params',`pools=1:frame-threads=1:log-level=error:qp=0:keyint=30:colorprim=9:transfer=${tag}:colormatrix=9:range=limited`];
    const raw=['-y','-hide_banner','-loglevel','error','-f','rawvideo','-pixel_format','yuv420p10le','-video_size',`${width}x${height}`,'-framerate','30','-i',input];
    execFileSync('ffmpeg',[...raw,'-frames:v','1',...codec,'-f','hevc',annex],{stdio:'pipe',timeout:30000});
    execFileSync('ffmpeg',['-y','-hide_banner','-loglevel','error','-stream_loop','-1',...raw.slice(4),'-t','4',...codec,'-tag:v','hvc1',path.join(root,`${transfer}.mp4`)],{stdio:'pipe',timeout:30000});
    fixtures.push({transfer,levels,pixels:[...pixels],annex:[...await readFile(annex)]});
  }
  execFileSync('ffmpeg',['-y','-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=384x144:rate=30','-t','4','-c:v','libx264','-pix_fmt','yuv420p',path.join(root,'sdr.mp4')],{stdio:'pipe',timeout:30000});
  vite=await createServer({server:{host:'127.0.0.1',port:0}});await vite.listen();
  await withBrowserFixture({caseName:experimental?'native-hdr-enabled':'native-hdr-default',engine:'chromium',roots:qa?[root,path.join(repositoryRoot,'fixtures/video')]:[root],
    launchOptions:{headless:false,ignoreDefaultArgs:['--force-color-profile=srgb'],...(channel?{channel}:{}),
      ...(experimental?{args:['--enable-blink-features=CanvasGlobalHDRHeadroom']}: {})}},async({page,ready,artifact})=>{
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/native-hdr-test',r=>r.fulfill({contentType:'text/html',body:'<article class="frame-stage"><canvas id="source"></canvas></article>'}));
    await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}/native-hdr-test`);
    const result=await page.evaluate(async({fixtures,width,height})=>{
      const {setColorMode}=await import('/src/color-mode.ts');setColorMode('browser');
      const {setColorOutput,defaultColorOutput}=await import('/src/color-output.ts');setColorOutput({...defaultColorOutput(),target:'hdr'});
      const {createExternalSurface}=await import('/src/webgpu-color-surface.mjs');
      const {VideoSample}=await import('/node_modules/mediabunny/dist/modules/src/index.js');
      const {sampleDescription}=await import('/src/frame-description.ts');
      const {initializeGpuPresentation,gpuGeometry,disposeGpuPresentation}=await import('/src/webgpu-presenter.ts');
      const {paintFrame}=await import('/src/presenter.ts');
      const source=document.querySelector('#source'),surface=await createExternalSurface(document.createElement('canvas'));
      await initializeGpuPresentation([source]);
      const rows=[],measure=async(frame,label)=>{
        const sample=new VideoSample(frame.clone()),decoded={kind:'video-sample',sample,description:sampleDescription(sample),width:frame.displayWidth,height:frame.displayHeight};
        try {
          paintFrame(source,decoded);
          if(!surface.nativeHdrAvailable){
            let rejected=false;try{surface.present(frame);}catch{rejected=true;}
            return {label,format:frame.format,rejected,presentation:decoded.presentation};
          }
          surface.present(frame);frame.close(); // Retained clone must survive caller closure.
          const pixels=await surface.captureHdrPixels(),w=sample.displayWidth,h=sample.displayHeight;
          const points=Array.from({length:12},(_,i)=>[...pixels.slice((Math.floor(h/2)*w+Math.floor(w*(i+.5)/12))*4,(Math.floor(h/2)*w+Math.floor(w*(i+.5)/12))*4+3)]);
          // Independently ask the browser for HDR conversion, then check that
          // our GPU sampling does not decode transfer functions a second time.
          const canvas=new OffscreenCanvas(w,h),ctx=canvas.getContext('2d',{colorSpace:'display-p3',colorType:'float16'});
          ctx.globalHDRHeadroom=Infinity;const borrowed=sample.toVideoFrame();try{ctx.drawImage(borrowed,0,0);}finally{borrowed.close();}
          const reference=ctx.getImageData(0,0,w,h,{colorSpace:'display-p3',pixelFormat:'rgba-float16'}).data;
          let maxDelta=0,maxRgb=0;for(let i=0;i<pixels.length;i++)if(i%4!==3){maxDelta=Math.max(maxDelta,Math.abs(pixels[i]-Math.max(0,reference[i])));maxRgb=Math.max(maxRgb,pixels[i]);}
          const first=Array.from(await surface.capture());
          const preview=new OffscreenCanvas(w,h),previewCtx=preview.getContext('2d',{colorSpace:'srgb'}),original=sample.toVideoFrame();
          try{previewCtx.drawImage(original,0,0);}finally{original.close();}
          const previewPixels=previewCtx.getImageData(0,0,w,h).data;let captureDelta=0;
          for(let i=0;i<first.length;i++)captureDelta=Math.max(captureDelta,Math.abs(first[i]-previewPixels[i]));
          surface.setGeometry({width:w*2,height:h*2,imageWidth:w,imageHeight:h,zoom:2,offsetX:0,offsetY:0,dpr:1},90);
          const rotated=await surface.captureHdrPixels();let rotationDelta=0;
          for(let y=0;y<h;y++)for(let x=0;x<w;x++)for(let c=0;c<4;c++)rotationDelta=Math.max(rotationDelta,Math.abs(pixels[(y*w+x)*4+c]-rotated[(x*h+h-1-y)*4+c]));
          surface.setGeometry(null,0);const retained=await surface.captureHdrPixels();
          let retainedDelta=0;for(let i=0;i<pixels.length;i++)retainedDelta=Math.max(retainedDelta,Math.abs(pixels[i]-retained[i]));
          const capture=Array.from(await surface.capture()),captureMax=capture.reduce((max,v)=>Math.max(max,v),0);
          return {label,format:sample.format,color:decoded.description.color,presentation:decoded.presentation,points,maxRgb,maxDelta,retainedDelta,captureMax,captureDelta,captureStable:JSON.stringify(first)===JSON.stringify(capture),rotationDelta,rotatedPixels:rotated.length};
        } finally {sample.close();}
      };
      try {
        for(const fixture of fixtures){
          let frame=new VideoFrame(new Uint16Array(fixture.pixels),{format:'I420P10',codedWidth:width,codedHeight:height,timestamp:0,colorSpace:{primaries:'bt2020',matrix:'bt2020-ncl',transfer:fixture.transfer,fullRange:false}});
          try{rows.push(await measure(frame,`${fixture.transfer}:memory`));}finally{frame.close();}
          const config={codec:'hev1.2.4.L30.B0',hardwareAcceleration:'prefer-hardware'},support=await VideoDecoder.isConfigSupported(config);
          if(!support.supported){rows.push({label:`${fixture.transfer}:decoded`,supported:false});continue;}
          let error;const decoder=new VideoDecoder({output:f=>{frame?.close();frame=f;},error:e=>{error=String(e);}});frame=null;
          try{decoder.configure(config);decoder.decode(new EncodedVideoChunk({type:'key',timestamp:0,data:new Uint8Array(fixture.annex)}));await decoder.flush();if(error||!frame)throw Error(error??'No decoded frame');rows.push(await measure(frame,`${fixture.transfer}:decoded`));}
          finally{frame?.close();if(decoder.state!=='closed')decoder.close();}
        }
        // Resource changes and bridge resize must not leak stale HDR texels.
        const sdr=new VideoFrame(new Uint8Array([100,100,100,100,128,128]),{format:'I420',codedWidth:2,codedHeight:2,timestamp:0,colorSpace:{primaries:'bt709',matrix:'bt709',transfer:'bt709',fullRange:false}});
        try{surface.present(sdr);const sdrPixels=await surface.captureHdrPixels();rows.push({label:'sdr-after-hdr',maxRgb:Math.max(...sdrPixels.filter((_,i)=>i%4!==3))});}finally{sdr.close();}
        const pq=new VideoFrame(new Uint16Array(fixtures[0].pixels),{format:'I420P10',codedWidth:width,codedHeight:height,timestamp:0,colorSpace:{primaries:'bt2020',matrix:'bt2020-ncl',transfer:'pq',fullRange:false}});
        try{rows.push(await measure(pq,'pq:after-resize'));}finally{pq.close();}
        const converted=new VideoSample(new VideoFrame(new Uint8Array([100,100,100,100,128,128]),{format:'I420',codedWidth:2,codedHeight:2,timestamp:0,colorSpace:{primaries:'bt709',matrix:'bt709',transfer:'bt709',fullRange:false}}));
        try{
          const description=sampleDescription(converted);description.sourceColor={primaries:'bt2020',transfer:'pq',matrix:'bt2020-ncl',fullRange:false};
          gpuGeometry(source,null);const frame={kind:'video-sample',sample:converted,description,width:2,height:2};paintFrame(source,frame);
          rows.push({label:'hdr-source-sdr-tagged-resource',presentation:frame.presentation});
        }finally{converted.close();}
        return {userAgent:navigator.userAgent,configuration:surface.outputConfiguration,nativeHdrAvailable:surface.nativeHdrAvailable,nativeHdrReason:surface.nativeHdrReason,rows,gpuErrors:[...surface.errors]};
      } finally {surface.dispose();disposeGpuPresentation();}
    },{fixtures,width,height});
    await writeFile(artifact('native-hdr.json'),JSON.stringify({experimental,channel,result},null,2));
    assert.equal(result.configuration.displayHdr,true,'This visible test requires an HDR display; forced sRGB must not mask the capability');
    assert.equal(result.configuration.toneMapping,'extended');
    if(experimental)assert.equal(result.nativeHdrAvailable,true,'Explicit HDR feature test must exercise the real float bridge');
    for(const row of result.rows){
      if(row.supported===false){assert.equal(requireNative,false,'Hardware HEVC decode is required');continue;}
      if(row.label==='hdr-source-sdr-tagged-resource'){assert.equal(row.presentation.actualTarget,'sdr');assert.equal(row.presentation.fallbackReason,'native-hdr-resource-unverified');continue;}
      if(row.label==='sdr-after-hdr'){assert.ok(row.maxRgb>0&&row.maxRgb<=1);continue;}
      if(result.nativeHdrAvailable){
        assert.equal(row.presentation.actualTarget,'hdr');assert.equal(row.presentation.executor,'webgpu-browser-hdr-float');
        assert.ok(row.maxDelta<.01,`${row.label}: GPU must preserve browser-converted float colors (${row.maxDelta})`);
        assert.ok(row.rotationDelta<.001,'HDR rotation preserves source pixels');assert.ok(row.retainedDelta<.001);assert.equal(row.captureStable,true);assert.ok(row.captureDelta<=1,'HDR capture must use the browser SDR mapping, not float clipping');assert.ok(row.captureMax<=255);
        assert.ok(row.points[5].every(c=>c>1.5),'HDR high white is above SDR white');
        assert.ok(row.points[4][0]>row.points[3][0]+.2,'HDR highlights remain distinct');
        assert.ok(row.points[3][0]>row.points[2][0]+.2,'HDR highlights do not get an SDR shoulder');
        assert.ok(row.points[6][0]>row.points[6][2]&&row.points[7][1]>row.points[7][0]&&row.points[8][2]>row.points[8][1],'colored patches survive browser conversion');
      }else{
        assert.equal(row.rejected,true);assert.equal(row.presentation.actualTarget,'sdr');
        assert.equal(row.presentation.fallbackReason,'browser-hdr-headroom-unavailable');
      }
    }
    assert.deepEqual(result.gpuErrors,[]);
    await page.addInitScript(()=>{
      localStorage.setItem('voidplayer.color-mode','browser');
      localStorage.setItem('voidplayer.color-output',JSON.stringify({target:'hdr',hdrWhiteNits:203,preview:{presentation:'voidplayer-hdr-sdr-preview-v1',outputColorSpace:'srgb',sourcePeakNits:1000,exposureWhiteNits:203,hlgDisplayPeakNits:1000,hlgSystemGamma:1.2}}));
    });
    await ready();await page.bringToFront();
    const call=(name,params={})=>page.evaluate(async({name,params})=>window.voidPlayer.tools.find(t=>t.name===name).execute(params),{name,params});
    const lib=await call('list_library'),playback=[];
    for(const transfer of ['pq','hlg']){
      await call('load_library_item',{slot:'A',id:lib.entries.find(e=>e.name===`${transfer}.mp4`).id});
      await call('set_review_color_output',{target:'hdr'});await call('seek_review',{ptsUs:1000000});await call('step_review',{direction:1});
      const before=await call('get_review_session');assert.equal(before.tracks[0].decoder,'webcodecs');
      assert.equal(before.tracks[0].presentation.actualTarget,result.nativeHdrAvailable?'hdr':'sdr');
      assert.equal(before.tracks[0].presentation.captureTarget,'sdr');
      for(const mixed of [false,true]){
        if(mixed)await call('load_library_item',{slot:'B',id:lib.entries.find(e=>e.name==='sdr.mp4').id});
        const report=await call('benchmark_review',{durationMs:2000});playback.push({transfer,mixed,report});await writeFile(artifact('native-hdr.json'),JSON.stringify({experimental,channel,result,playback},null,2));
        assert.equal(report.error,null);assert.equal(report.staleAfterPause,false);assert.ok(report.measurements.tracks.A.drawn>20);
        assert.equal(report.passed,true,JSON.stringify(report.failures));
        if(mixed)await call('remove_review_track',{slot:'B'});
      }
      await call('seek_review',{ptsUs:3999999});const tail=await call('get_review_session');assert.ok(tail.tracks[0].frame.ptsUs>3800000);
      await call('set_review_color_output',{target:'sdr'});assert.equal((await call('get_review_session')).tracks[0].presentation.actualTarget,'sdr');
      await call('set_review_color_output',{target:'hdr'});assert.equal((await call('get_review_session')).tracks[0].presentation.actualTarget,result.nativeHdrAvailable?'hdr':'sdr');
      await call('remove_review_track',{slot:'A'});
    }
    if(qa){
      for(const mixed of [false,true]){
        await call('load_library_item',{slot:'A',id:lib.entries.find(e=>e.name==='dolby_hlg_1080p30.mp4').id});
        if(mixed)await call('load_library_item',{slot:'B',id:lib.entries.find(e=>e.name==='h264_9s_1920x1080.mp4').id});
        await call('set_review_color_output',{target:'hdr'});
        const state=await call('get_review_session');assert.equal(state.tracks[0].decoder,'webcodecs');assert.equal(state.tracks[0].presentation.actualTarget,result.nativeHdrAvailable?'hdr':'sdr');
        const report=await call('benchmark_review',{durationMs:3000});playback.push({transfer:'qa-hlg-1080p',mixed,presentation:state.tracks.map(t=>t.presentation),report});
        await writeFile(artifact('native-hdr.json'),JSON.stringify({experimental,channel,result,playback},null,2));
        assert.equal(report.passed,true,JSON.stringify(report.failures));
        await call('remove_review_track',{slot:'A'});if(mixed)await call('remove_review_track',{slot:'B'});
      }
    }
    assert.deepEqual(errors,[]);
    await writeFile(artifact('native-hdr.json'),JSON.stringify({experimental,channel,result,playback},null,2));
    console.log(`PASS native HDR ${experimental?'enabled':'default'}: actual HEVC PQ/HLG, colors, retained frame, rotation/resize, SDR captures, seek/tail/targets and four visible playback benchmarks`);
  });
} finally {await vite?.close();await rm(root,{recursive:true,force:true});}
