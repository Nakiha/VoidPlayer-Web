import { yuvKernel } from './webgpu-yuv-kernel.mjs';
import { resolveYuvColor, validateYuv, yuvCoefficients, chromaOffset } from './yuv-color.ts';
import { getPresentationChannel, presentationChannelCode } from './presentation-channel.ts';
import { getColorOutput, hdrDisplayAvailable } from './color-output.ts';
import { hdrTransfer } from './hdr-policy.ts';
import { createBrowserHdrBridge } from './browser-hdr-bridge.mjs';
// One submission per microtask across canvases. Flush before overwriting a
// resource already referenced by queued commands. Frame closure follows submit.
const batches=new WeakMap();
function flush(device){const batch=batches.get(device);if(!batch?.commands.length)return;const commands=batch.commands.splice(0);batch.surfaces.clear();device.queue.submit(commands);for(const close of batch.closes.splice(0))close();}
function beforeWrite(device,token){if(batches.get(device)?.surfaces.has(token))flush(device);}
function submit(device,token,command){let batch=batches.get(device);if(!batch){batch={commands:[],surfaces:new Set(),closes:[]};batches.set(device,batch);}const schedule=!batch.commands.length;batch.commands.push(command);batch.surfaces.add(token);if(schedule)queueMicrotask(()=>flush(device));}
function retire(device,frame){if(!frame)return;const batch=batches.get(device);if(batch?.commands.length)batch.closes.push(()=>frame.close());else frame.close();}
// Native frames use browser external textures; raw WASM planes use the selected
// resource profile in WGSL. No playback readback; capture is demand-driven.
export async function createExternalSurface(canvas, sharedDevice, mode = 'external') {
  if (!navigator.gpu) throw new Error('WebGPU unavailable');
  const adapter = sharedDevice ? null : await navigator.gpu.requestAdapter();
  if (!adapter && !sharedDevice) throw new Error('WebGPU adapter unavailable');
  const device = sharedDevice ?? await adapter.requestDevice();
  const ownsDevice = !sharedDevice;const token={};
  const errors = [];
  const onError = e => errors.push(e.error.message);
  device.addEventListener('uncapturederror', onError);
  if (!['external','copy','hybrid','planes','webkit-planes'].includes(mode)) throw new Error('Unknown GPU input mode');
  let lost = false, disposed = false, current, copiedTexture, copiedWidth=0, copiedHeight=0, copiedFormat;
  device.lost.then(() => { lost = true; });
  let geometry=null,rotation=0;
  let context, externalUniform, yuvBuffer, yuvSize=0, yuvUniform, yuvParams, browserHdrBridge;
  try {
  context = canvas.getContext('webgpu');
  if (!context) { if(ownsDevice)device.destroy(); throw new Error('WebGPU canvas unavailable'); }
  const output=getColorOutput(),sdrFormat=navigator.gpu.getPreferredCanvasFormat();
  const displayHdr=hdrDisplayAvailable();
  let hdrOutput=output.target==='hdr'&&displayHdr&&mode!=='copy';
  let outputFallbackReason=output.target!=='hdr'?null:!displayHdr?'hdr-display-unavailable':mode==='copy'?'hdr-copy-mode-unavailable':null;
  if(hdrOutput){
    device.pushErrorScope('validation');
    try{context.configure({device,format:'rgba16float',colorSpace:'display-p3',toneMapping:{mode:'extended'},alphaMode:'premultiplied'});
      hdrOutput=context.getConfiguration()?.toneMapping?.mode==='extended';
    }catch{hdrOutput=false;}
    const error=await device.popErrorScope();if(error)hdrOutput=false;
  }
  if(output.target==='hdr'&&!hdrOutput&&!outputFallbackReason)outputFallbackReason='hdr-canvas-unavailable';
  if(hdrOutput){try{browserHdrBridge=createBrowserHdrBridge();}catch{browserHdrBridge={available:false,reason:'browser-hdr-float16-unavailable'};}}
  const nativeHdrReason=outputFallbackReason??(browserHdrBridge?.available?null:browserHdrBridge?.reason??'hdr-output-not-requested');
  const format=hdrOutput?'rgba16float':sdrFormat;
  if(!hdrOutput)context.configure({device,format,colorSpace:'srgb',alphaMode:'premultiplied'});
  const nativeShader = copied => device.createShaderModule({code:`
    @group(0) @binding(0) var input: ${copied?'texture_2d<f32>':'texture_external'};
    @group(0) @binding(1) var smp: sampler;
    @group(0) @binding(2) var<uniform> geom:array<vec4f,2>;
    struct V { @builtin(position) p: vec4f, @location(0) uv: vec2f }
    @vertex fn vs(@builtin(vertex_index) i:u32)->V {
      var p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));
      var o:V; o.p=vec4f(p[i],0,1); o.uv=vec2f((p[i].x+1)*0.5,(1-p[i].y)*0.5); return o;
    }
    fn samplePoint(pixel:vec2f)->vec3f{
      let size=geom[1].yz;let uv=(clamp(pixel,vec2f(0),size-1)+0.5)/size;
      return ${hdrOutput?'max':'clamp'}(${copied?'textureSampleLevel':'textureSampleBaseClampToEdge'}(input,smp,uv${copied?',0.0':''}).rgb,vec3f(0)${hdrOutput?'':',vec3f(1)'});
    }
    @fragment fn fs(v:V)->@location(0) vec4f {
      var uv=(v.p.xy-geom[0].xy)/geom[0].zw;
      if(any(uv<vec2f(0))||any(uv>=vec2f(1))){discard;}
      if(geom[1].x==90){uv=vec2f(uv.y,1-uv.x);}else if(geom[1].x==180){uv=1-uv;}else if(geom[1].x==270){uv=vec2f(1-uv.y,uv.x);}
      let pixel=uv*geom[1].yz-0.5;
      if(geom[1].w>0){let a=floor(pixel);let w=fract(pixel);return vec4f(mix(mix(samplePoint(a),samplePoint(a+vec2f(1,0)),w.x),mix(samplePoint(a+vec2f(0,1)),samplePoint(a+vec2f(1,1)),w.x),w.y),1);}
      return vec4f(samplePoint(floor(pixel+0.5)),1);
    }`});
  const shader=nativeShader(mode==='copy');
  const compilation = await shader.getCompilationInfo();
  if (compilation.messages.some(m => m.type==='error')) { if(ownsDevice)device.destroy(); throw new Error(JSON.stringify(compilation.messages)); }
  const pipelines = new Map();
  for (const target of new Set([format,sdrFormat,'rgba8unorm'])) pipelines.set(target, await device.createRenderPipelineAsync({
    layout:'auto', vertex:{module:shader,entryPoint:'vs'}, fragment:{module:shader,entryPoint:'fs',targets:[{format:target}]},primitive:{topology:'triangle-list'}
  }));
  const bridgePipelines=new Map();
  if(browserHdrBridge?.available){
    const module=nativeShader(true);
    for(const target of new Set([format,sdrFormat,'rgba8unorm']))bridgePipelines.set(target,await device.createRenderPipelineAsync({layout:'auto',vertex:{module,entryPoint:'vs'},fragment:{module,entryPoint:'fs',targets:[{format:target}]},primitive:{topology:'triangle-list'}}));
  }
  const yuvModule=device.createShaderModule({code:yuvKernel});
  const yuvInfo=await yuvModule.getCompilationInfo();if(yuvInfo.messages.some(m=>m.type==='error'))throw new Error(yuvInfo.messages.map(m=>m.message+' at '+m.lineNum).join('\n'));
  const yuvPipelines=new Map();
  for(const target of new Set([format,sdrFormat,'rgba8unorm']))yuvPipelines.set(target,await device.createRenderPipelineAsync({layout:'auto',vertex:{module:yuvModule,entryPoint:'vs'},fragment:{module:yuvModule,entryPoint:'fs',targets:[{format:target}]},primitive:{topology:'triangle-list'}}));
  yuvUniform=device.createBuffer({size:192,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
  externalUniform=device.createBuffer({size:32,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
  const samplers = {nearest:device.createSampler(),linear:device.createSampler({minFilter:'linear',magFilter:'linear'})};
  function render(texture, target, linear=false, capture=false, hdrCapture=false) {
    if (disposed || lost || !current) throw new Error('No live GPU/frame resource');
    beforeWrite(device,token);
    const isYuv=!!current.yuv;
    const bridge=!isYuv&&browserHdrBridge?.available&&hdrTransfer(current.colorSpace?.transfer);
    const pipeline=(isYuv?yuvPipelines:bridge?bridgePipelines:pipelines).get(target);
    let rect=[0,0,texture.width,texture.height];
    if(geometry&&!capture){const g=geometry,w=g.imageWidth*g.zoom*g.dpr,h=g.imageHeight*g.zoom*g.dpr;rect=[((g.width-g.imageWidth*g.zoom)/2+g.offsetX)*g.dpr,((g.height-g.imageHeight*g.zoom)/2+g.offsetY)*g.dpr,w,h];}
    device.queue.writeBuffer(externalUniform,0,new Float32Array([...rect,rotation,current.displayWidth,current.displayHeight,Number(linear)]));
    if(isYuv){yuvParams[3]=presentationChannelCode(getPresentationChannel());yuvParams.set(rect,32);yuvParams[31]=rotation;yuvParams[29]=Number(linear);yuvParams[45]=Number(hdrOutput&&(!capture||hdrCapture));yuvParams[46]=output.hdrWhiteNits;device.queue.writeBuffer(yuvUniform,0,yuvParams);}
    const external=isYuv?null:bridge||mode==='copy'?copiedTexture.createView():device.importExternalTexture({source:current,colorSpace:hdrOutput&&(!capture||hdrCapture)?'display-p3':'srgb'});
    const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:isYuv?[{binding:0,resource:{buffer:yuvBuffer}},{binding:1,resource:{buffer:yuvUniform}}]:[{binding:0,resource:external},{binding:1,resource:samplers.nearest},{binding:2,resource:{buffer:externalUniform}}]});
    const encoder=device.createCommandEncoder();
    const pass=encoder.beginRenderPass({colorAttachments:[{view:texture.createView(),loadOp:'clear',storeOp:'store',clearValue:[0,0,0,0]}]});
    pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.draw(3);pass.end();
    submit(device,token,encoder.finish());
  }
  return {
    outputTarget:hdrOutput?'hdr':'sdr',outputFallbackReason,
    nativeHdrAvailable:!!browserHdrBridge?.available,nativeHdrReason,
    outputConfiguration:{displayHdr,format,colorSpace:hdrOutput?'display-p3':'srgb',toneMapping:hdrOutput?'extended':'standard'},
    setGeometry(g,r=rotation){if(JSON.stringify(g)===JSON.stringify(geometry)&&r===rotation)return;geometry=g;rotation=r;if(current&&g)this.presentRetained();},
    presentRetained(){const w=geometry?Math.max(1,Math.round(geometry.width*geometry.dpr)):canvas.width,h=geometry?Math.max(1,Math.round(geometry.height*geometry.dpr)):canvas.height;if(canvas.width!==w)canvas.width=w;if(canvas.height!==h)canvas.height=h;if(current?.yuv&&yuvParams)yuvParams[3]=presentationChannelCode(getPresentationChannel());render(context.getCurrentTexture(),format,geometry?geometry.imageWidth*geometry.zoom*geometry.dpr<current.displayWidth:w<current.displayWidth);},
    device, adapter: adapter ? {vendor:adapter.info?.vendor,architecture:adapter.info?.architecture,device:adapter.info?.device} : null,errors,
    // Own one clone so paused redraw and capture use precisely the same resource.
    present(frame,width=frame.displayWidth,height=frame.displayHeight) {
      beforeWrite(device,token);
      const isYuv=frame.kind==='yuv';
      if(!isYuv&&hdrTransfer(frame.colorSpace?.transfer)&&!browserHdrBridge?.available)throw new Error(nativeHdrReason);
      if(isYuv){
        const d=frame.description,l=d.yuv,plan=resolveYuvColor(d);validateYuv(d,frame.pixels.byteLength);
        if(mode==='webkit-planes'&&d.color.matrix==null){plan.matrix='bt709';plan.primaries=d.color.primaries??'bt709';}
        if(!plan.supported)throw new Error('Unsupported raw-plane color contract');
        const length=Math.ceil(frame.pixels.byteLength/4)*4;
        if(length>device.limits.maxStorageBufferBindingSize)throw new Error('YUV frame exceeds storage budget');
        if(yuvSize!==length){yuvBuffer?.destroy();yuvBuffer=device.createBuffer({size:length,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});yuvSize=length;}
        const data=frame.pixels.byteLength===length?frame.pixels:new Uint8Array(length);if(data!==frame.pixels)data.set(frame.pixels);
        device.queue.writeBuffer(yuvBuffer,0,data);
        yuvParams=new Float32Array(48);yuvParams.set([d.width,d.height,plan.primaries==='bt2020'?3:mode==='hybrid'?(plan.primaries==='smpte170m'?1:plan.primaries==='bt470bg'?2:0):0,presentationChannelCode(getPresentationChannel()),d.visibleRect.x,d.visibleRect.y,2**l.subsampleX,2**l.subsampleY,l.bitDepth>8?2:1,l.bitShift,Number(l.semiplanar),2**l.bitDepth-1]);
        l.planes.forEach((p,i)=>new Uint32Array(yuvParams.buffer).set([p.offset,p.stride,p.width,p.height],12+i*4));
        yuvParams.set([2**(l.bitDepth-8),Number(plan.fullRange),...yuvCoefficients(plan.matrix),mode==='hybrid'&&plan.transfer==='bt709'?1.961:0,0,Number(mode==='webkit-planes'&&l.bitDepth===8),0],24);
        yuvParams.set(chromaOffset(l),36);
        if(plan.hdrPolicy){const p=plan.hdrPolicy;yuvParams.set([p.sourcePeakNits,p.exposureWhiteNits,p.hlgDisplayPeakNits,p.hlgSystemGamma],40);yuvParams[44]=plan.hdr==='pq'?1:2;}
        width??=d.width;height??=d.height;
      }
      const next=isYuv?{yuv:true,displayWidth:frame.description.width,displayHeight:frame.description.height,close(){}}:frame.clone();const previous=current;current=next;
      try {if(!geometry){if(canvas.width!==width)canvas.width=width;if(canvas.height!==height)canvas.height=height;}
        const bridge=!isYuv&&browserHdrBridge?.available&&hdrTransfer(current.colorSpace?.transfer);
        if(!isYuv&&(mode==='copy'||bridge)){
          const w=frame.displayWidth,h=frame.displayHeight;
          const textureFormat=bridge?'rgba16float':'rgba8unorm';
          if(!copiedTexture||copiedWidth!==w||copiedHeight!==h||copiedFormat!==textureFormat){
            copiedTexture?.destroy();copiedTexture=device.createTexture({size:[w,h],format:textureFormat,usage:GPUTextureUsage.COPY_DST|GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.RENDER_ATTACHMENT});copiedWidth=w;copiedHeight=h;copiedFormat=textureFormat;
          }
          device.queue.copyExternalImageToTexture({source:bridge?browserHdrBridge.draw(current):current},{texture:copiedTexture,colorSpace:hdrOutput?'display-p3':'srgb',premultipliedAlpha:false},[w,h]);
        }
        this.presentRetained();
      } catch(e) {current=previous;next.close();throw e;}
      retire(device,previous);
    },
    get available(){return !lost&&!disposed;},
    clear(){flush(device);current?.close();current=undefined;yuvBuffer?.destroy();yuvBuffer=undefined;yuvSize=0;copiedTexture?.destroy();copiedTexture=undefined;browserHdrBridge?.dispose?.();},
    captureSource(target) {
      if(!current)throw new Error('No frame');
      const swap=rotation===90||rotation===270;
      const w=swap?current.displayHeight:current.displayWidth,h=swap?current.displayWidth:current.displayHeight;
      target.width=w;target.height=h;const out=target.getContext('2d',{colorSpace:'srgb'});
      if(!current.yuv&&hdrTransfer(current.colorSpace?.transfer)){
        out.save();out.clearRect(0,0,w,h);out.translate(w/2,h/2);out.rotate(rotation*Math.PI/180);out.drawImage(current,-current.displayWidth/2,-current.displayHeight/2,current.displayWidth,current.displayHeight);out.restore();return target;
      }
      const scratch=new OffscreenCanvas(w,h),ctx=scratch.getContext('webgpu');
      ctx.configure({device,format:sdrFormat,colorSpace:'srgb',alphaMode:'premultiplied'});
      try{render(ctx.getCurrentTexture(),sdrFormat,false,true);flush(device);out.clearRect(0,0,w,h);out.drawImage(scratch,0,0);return target;}finally{ctx.unconfigure();}
    },
    async capture(viewport=false) {
      if(!current)throw new Error('No frame');
      if(!current.yuv&&hdrTransfer(current.colorSpace?.transfer)){
        const target=new OffscreenCanvas(1,1);this.captureSource(target);
        if(!viewport)return target.getContext('2d').getImageData(0,0,target.width,target.height).data;
        const scaled=new OffscreenCanvas(canvas.width,canvas.height),ctx=scaled.getContext('2d');
        const g=geometry,w=g?g.imageWidth*g.zoom*g.dpr:canvas.width,h=g?g.imageHeight*g.zoom*g.dpr:canvas.height;
        ctx.drawImage(target,g?((g.width-g.imageWidth*g.zoom)/2+g.offsetX)*g.dpr:0,g?((g.height-g.imageHeight*g.zoom)/2+g.offsetY)*g.dpr:0,w,h);
        return ctx.getImageData(0,0,scaled.width,scaled.height).data;
      }
      const width=viewport?canvas.width:current.displayWidth,height=viewport?canvas.height:current.displayHeight,row=Math.ceil(width*4/256)*256;
      const texture=device.createTexture({size:[width,height],format:'rgba8unorm',usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC});
      const buffer=device.createBuffer({size:row*height,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
      try {
        render(texture,'rgba8unorm',viewport&&width<current.displayWidth,!viewport);
        const encoder=device.createCommandEncoder();encoder.copyTextureToBuffer({texture},{buffer,bytesPerRow:row},[width,height]);submit(device,token,encoder.finish());
        flush(device);await buffer.mapAsync(GPUMapMode.READ);
        const mapped=new Uint8Array(buffer.getMappedRange()),pixels=new Uint8ClampedArray(width*height*4);
        for(let y=0;y<height;y++)pixels.set(mapped.subarray(y*row,y*row+width*4),y*width*4);
        buffer.unmap();return pixels;
      } finally {buffer.destroy();texture.destroy();}
    },
    // Diagnostic only: extended Display-P3 code values, not a screen capture
    // or evidence that the physical monitor reached a particular luminance.
    async captureHdrPixels(){
      if(!hdrOutput||!current)throw new Error('No extended HDR surface');
      const swap=rotation===90||rotation===270,width=swap?current.displayHeight:current.displayWidth,height=swap?current.displayWidth:current.displayHeight;
      const row=Math.ceil(width*8/256)*256,texture=device.createTexture({size:[width,height],format:'rgba16float',usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC});
      const buffer=device.createBuffer({size:row*height,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
      try{
        render(texture,'rgba16float',false,true,true);
        const encoder=device.createCommandEncoder();encoder.copyTextureToBuffer({texture},{buffer,bytesPerRow:row},[width,height]);submit(device,token,encoder.finish());flush(device);
        await buffer.mapAsync(GPUMapMode.READ);const raw=new Uint16Array(buffer.getMappedRange()),out=new Float32Array(width*height*4);
        const half=v=>{const sign=v&32768?-1:1,exponent=(v>>10)&31,fraction=v&1023;return sign*(exponent===0?fraction*2**-24:exponent===31?fraction?NaN:Infinity:(1+fraction/1024)*2**(exponent-15));};
        for(let y=0;y<height;y++)for(let x=0;x<width*4;x++)out[(y*width*4)+x]=half(raw[y*row/2+x]);
        buffer.unmap();return out;
      }finally{buffer.destroy();texture.destroy();}
    },
    drain:()=>{flush(device);return device.queue.onSubmittedWorkDone();},
    dispose(){if(disposed)return;flush(device);disposed=true;current?.close();current=undefined;yuvBuffer?.destroy();yuvUniform?.destroy();externalUniform?.destroy();copiedTexture?.destroy();browserHdrBridge?.dispose?.();context.unconfigure();device.removeEventListener('uncapturederror',onError);if(ownsDevice)device.destroy();}
  };
  } catch(error) {
    current?.close();yuvBuffer?.destroy();yuvUniform?.destroy();externalUniform?.destroy();copiedTexture?.destroy();browserHdrBridge?.dispose?.();context?.unconfigure();
    device.removeEventListener('uncapturederror',onError);if(ownsDevice)device.destroy();
    throw error;
  }
}

export function wasmVideoFrame(frame,resolveYuvColor,validateYuv) {
  const d=frame.description,l=d.yuv;
  if(frame.kind!=='yuv'||!frame.pixels||!l)throw new Error('Experiment requires original WASM YUV');
  validateYuv(d,frame.pixels.byteLength);
  const plan=resolveYuvColor(d);
  if(!plan.supported)throw new Error('Experiment is SDR only');
  if(l.bitShift!==0||![8,10,12].includes(l.bitDepth)||l.subsampleX>1||(!l.subsampleX&&l.subsampleY))throw new Error('YUV layout has no direct VideoFrame mapping');
  if(l.semiplanar&&(l.bitDepth!==8||l.subsampleX!==1||l.subsampleY!==1))throw new Error('Only NV12 semiplanar mapping supported');
  const base=l.subsampleX?(l.subsampleY?'I420':'I422'):'I444';
  const format=l.semiplanar?'NV12':base+(l.bitDepth===8?'':`P${l.bitDepth}`);
  // Preserve actual tags. Browser constructor support is tested, never silently
  // replace rejected tags or truncate high-bit-depth data.
  const resource=new VideoFrame(frame.pixels,{format,codedWidth:d.codedWidth,codedHeight:d.codedHeight,
    visibleRect:d.visibleRect,displayWidth:d.width,displayHeight:d.height,timestamp:frame.sourcePtsUs,
    layout:l.planes.map(({offset,stride})=>({offset,stride})),
    colorSpace:{matrix:plan.matrix,primaries:plan.primaries,transfer:plan.transfer,fullRange:plan.fullRange}});
  return resource;
}
