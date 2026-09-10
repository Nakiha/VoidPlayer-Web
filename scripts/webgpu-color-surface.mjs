// Experimental SDR presenter. Both inputs use the browser's external-texture
// conversion. No native copyTo; readback occurs only in explicit capture().
export async function createExternalSurface(canvas, sharedDevice, mode = 'external') {
  if (!navigator.gpu) throw new Error('WebGPU unavailable');
  const adapter = sharedDevice ? null : await navigator.gpu.requestAdapter();
  if (!adapter && !sharedDevice) throw new Error('WebGPU adapter unavailable');
  const device = sharedDevice ?? await adapter.requestDevice();
  const ownsDevice = !sharedDevice;
  const errors = [];
  const onError = e => errors.push(e.error.message);
  device.addEventListener('uncapturederror', onError);
  if (!['external','copy'].includes(mode)) throw new Error('Unknown GPU input mode');
  let lost = false, disposed = false, current, copiedTexture, copiedWidth=0, copiedHeight=0;
  device.lost.then(() => { lost = true; });
  let context;
  try {
  context = canvas.getContext('webgpu');
  if (!context) { if(ownsDevice)device.destroy(); throw new Error('WebGPU canvas unavailable'); }
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({device, format, colorSpace:'srgb', alphaMode:'opaque'});
  const shader = device.createShaderModule({code:`
    @group(0) @binding(0) var input: ${mode==='copy'?'texture_2d<f32>':'texture_external'};
    @group(0) @binding(1) var smp: sampler;
    struct V { @builtin(position) p: vec4f, @location(0) uv: vec2f }
    @vertex fn vs(@builtin(vertex_index) i:u32)->V {
      var p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));
      var o:V; o.p=vec4f(p[i],0,1); o.uv=vec2f((p[i].x+1)*0.5,(1-p[i].y)*0.5); return o;
    }
    @fragment fn fs(v:V)->@location(0) vec4f {
      return vec4f(clamp(${mode==='copy'?'textureSample':'textureSampleBaseClampToEdge'}(input,smp,v.uv).rgb,vec3f(0),vec3f(1)),1);
    }`});
  const compilation = await shader.getCompilationInfo();
  if (compilation.messages.some(m => m.type==='error')) { if(ownsDevice)device.destroy(); throw new Error(JSON.stringify(compilation.messages)); }
  const pipelines = new Map();
  for (const target of new Set([format,'rgba8unorm'])) pipelines.set(target, await device.createRenderPipelineAsync({
    layout:'auto', vertex:{module:shader,entryPoint:'vs'}, fragment:{module:shader,entryPoint:'fs',targets:[{format:target}]},primitive:{topology:'triangle-list'}
  }));
  const samplers = {nearest:device.createSampler(),linear:device.createSampler({minFilter:'linear',magFilter:'linear'})};
  function render(texture, target, linear=false) {
    if (disposed || lost || !current) throw new Error('No live GPU/frame resource');
    const pipeline=pipelines.get(target);
    const external=mode==='copy'?copiedTexture.createView():device.importExternalTexture({source:current,colorSpace:'srgb'});
    const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:external},{binding:1,resource:samplers[linear?'linear':'nearest']}]});
    const encoder=device.createCommandEncoder();
    const pass=encoder.beginRenderPass({colorAttachments:[{view:texture.createView(),loadOp:'clear',storeOp:'store',clearValue:[0,0,0,1]}]});
    pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.draw(3);pass.end();
    device.queue.submit([encoder.finish()]);
  }
  return {
    device, adapter: adapter ? {vendor:adapter.info?.vendor,architecture:adapter.info?.architecture,device:adapter.info?.device} : null,errors,
    // Own one clone so paused redraw and capture use precisely the same resource.
    present(frame,width=frame.displayWidth,height=frame.displayHeight) {
      const next=frame.clone();const previous=current;current=next;
      try {if(canvas.width!==width)canvas.width=width;if(canvas.height!==height)canvas.height=height;
        if(mode==='copy'){
          const w=frame.displayWidth,h=frame.displayHeight;
          if(!copiedTexture||copiedWidth!==w||copiedHeight!==h){
            copiedTexture?.destroy();copiedTexture=device.createTexture({size:[w,h],format:'rgba8unorm',usage:GPUTextureUsage.COPY_DST|GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.RENDER_ATTACHMENT});copiedWidth=w;copiedHeight=h;
          }
          device.queue.copyExternalImageToTexture({source:current},{texture:copiedTexture,colorSpace:'srgb',premultipliedAlpha:false},[w,h]);
        }
        render(context.getCurrentTexture(),format,width<frame.displayWidth);
      } catch(e) {current=previous;next.close();throw e;}
      previous?.close();
    },
    async capture() {
      if(!current)throw new Error('No frame');
      const width=current.displayWidth,height=current.displayHeight,row=Math.ceil(width*4/256)*256;
      const texture=device.createTexture({size:[width,height],format:'rgba8unorm',usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC});
      const buffer=device.createBuffer({size:row*height,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
      try {
        render(texture,'rgba8unorm');
        const encoder=device.createCommandEncoder();encoder.copyTextureToBuffer({texture},{buffer,bytesPerRow:row},[width,height]);device.queue.submit([encoder.finish()]);
        await buffer.mapAsync(GPUMapMode.READ);
        const mapped=new Uint8Array(buffer.getMappedRange()),pixels=new Uint8ClampedArray(width*height*4);
        for(let y=0;y<height;y++)pixels.set(mapped.subarray(y*row,y*row+width*4),y*width*4);
        buffer.unmap();return pixels;
      } finally {buffer.destroy();texture.destroy();}
    },
    drain:()=>device.queue.onSubmittedWorkDone(),
    dispose(){if(disposed)return;disposed=true;current?.close();current=undefined;copiedTexture?.destroy();context.unconfigure();device.removeEventListener('uncapturederror',onError);if(ownsDevice)device.destroy();}
  };
  } catch(error) {
    current?.close();copiedTexture?.destroy();context?.unconfigure();
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
