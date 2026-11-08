// Independent external-texture oracle: no application shaders or color helpers.
// Native decode identity is checked separately against frozen FFmpeg references.
export async function createNativeReference() {
  const adapter=await navigator.gpu?.requestAdapter();
  if(!adapter)throw Error('Native reference requires WebGPU');
  const device=await adapter.requestDevice();
  const module=device.createShaderModule({code:`
    @group(0) @binding(0) var image: texture_external;
    @group(0) @binding(1) var nearest: sampler;
    @group(0) @binding(2) var<uniform> dimensions: vec4f;
    @vertex fn vertex(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
      let points=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));
      return vec4f(points[i],0,1);
    }
    @fragment fn fragment(@builtin(position) position: vec4f) -> @location(0) vec4f {
      let pixel=floor(position.xy/dimensions.zw*dimensions.xy);
      let color=textureSampleBaseClampToEdge(image,nearest,(pixel+0.5)/dimensions.xy);
      return vec4f(clamp(color.rgb,vec3f(0),vec3f(1))*color.a,color.a);
    }`});
  const pipeline=device.createRenderPipeline({layout:'auto',vertex:{module,entryPoint:'vertex'},
    fragment:{module,entryPoint:'fragment',targets:[{format:'rgba8unorm'}]}});
  const sampler=device.createSampler({minFilter:'nearest',magFilter:'nearest'});
  const uniform=device.createBuffer({size:16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
  let texture,buffer,width=0,height=0,stride=0;
  return {
    async sample(frame,w=frame.displayWidth,h=frame.displayHeight) {
      if(w!==width||h!==height){
        texture?.destroy();buffer?.destroy();width=w;height=h;stride=Math.ceil(w*4/256)*256;
        texture=device.createTexture({size:[w,h],format:'rgba8unorm',usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC});
        buffer=device.createBuffer({size:stride*h,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
      }
      device.queue.writeBuffer(uniform,0,new Float32Array([frame.displayWidth,frame.displayHeight,w,h]));
      const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[
        {binding:0,resource:device.importExternalTexture({source:frame,colorSpace:'srgb'})},
        {binding:1,resource:sampler},{binding:2,resource:{buffer:uniform}},
      ]});
      const encoder=device.createCommandEncoder();
      const pass=encoder.beginRenderPass({colorAttachments:[{view:texture.createView(),loadOp:'clear',storeOp:'store'}]});
      pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.draw(3);pass.end();
      encoder.copyTextureToBuffer({texture},{buffer,bytesPerRow:stride},[w,h]);
      device.queue.submit([encoder.finish()]);
      await buffer.mapAsync(GPUMapMode.READ);
      try{
        const mapped=new Uint8Array(buffer.getMappedRange()),pixels=new Uint8ClampedArray(w*h*4);
        for(let y=0;y<h;y++)pixels.set(mapped.subarray(y*stride,y*stride+w*4),y*w*4);
        return pixels;
      }finally{buffer.unmap();}
    },
    dispose(){texture?.destroy();buffer?.destroy();uniform.destroy();device.destroy();},
  };
}
