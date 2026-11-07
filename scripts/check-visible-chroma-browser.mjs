// Run against a Vite dev server: BASE_URL=http://127.0.0.1:5199 node scripts/check-visible-chroma-browser.mjs
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const browser=await chromium.launch({headless:true,...(process.env.CHROME_EXECUTABLE_PATH?{executablePath:process.env.CHROME_EXECUTABLE_PATH}:{}),args:['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-features=Vulkan','--use-vulkan=swiftshader']});
try {
  const page=await browser.newPage({locale:'zh-CN'});page.on('console',m=>console.error(m.text()));page.on('pageerror',e=>console.error(e));
  await page.route('**/visible-chroma-test',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>YUV presentation test</title>'}));
  await page.goto(new URL('/visible-chroma-test',process.env.BASE_URL??'http://127.0.0.1:5199').href);
  const result=await page.evaluate(async()=>{
    const {yuvFixture}=await import('/test/helpers/yuv-fixture.ts');
    const {yuvToRgba}=await import('/shared/color/yuv-color.ts');
    const {createYuvSurface}=await import('/src/presentation/yuv-surface.ts');
    const {createExternalSurface}=await import('/src/presentation/webgpu-color-surface.mjs');
    const {setPresentationChannel}=await import('/src/presentation/presentation-channel.ts');
    const canvas=document.createElement('canvas');canvas.width=3;canvas.height=1;
    const gl=canvas.getContext('webgl',{preserveDrawingBuffer:true});if(!gl)throw new Error('WebGL unavailable');
    const surface=createYuvSurface(gl),gpuCanvas=document.createElement('canvas');
    const gpu=await createExternalSurface(gpuCanvas,undefined,'planes');
    let cases=0;
    try {
      for(const depth of [8,10])for(const semi of [false,true])for(const siting of [1,2,3,4,5,6])for(const channel of ['rgb','u','v']){
        setPresentationChannel(channel);
        const f=yuvFixture(depth,semi);f.description.width=3;f.description.height=1;
        f.description.visibleRect={x:1,y:1,width:3,height:1};f.description.yuv.chromaLocation=siting;
        const expected=yuvToRgba(f.description,f.pixels,channel);
        surface.upload(f.description,f.pixels);surface.draw(null,3,1,{x:0,y:0,width:3,height:1},0,false);
        const actual=new Uint8Array(12);gl.readPixels(0,0,3,1,gl.RGBA,gl.UNSIGNED_BYTE,actual);
        if(actual.some((v,i)=>v!==expected[i]))throw new Error(`WebGL mismatch ${depth}/${semi}/${siting}/${channel}: ${actual} != ${expected}`);
        gpu.present({kind:'yuv',description:f.description,pixels:f.pixels},3,1);
        const gpuPixels=await gpu.capture();
        if(gpuPixels.some((v,i)=>Math.abs(v-expected[i])>1))throw new Error(`WebGPU mismatch ${depth}/${semi}/${siting}/${channel}: ${gpuPixels} != ${expected}`);
        cases++;
      }
      // Switching among already-uploaded planes only writes small uniform buffers.
      const f=yuvFixture(10,true,false,'bt709',128,72),original=f.pixels.slice();
      gpu.present({kind:'yuv',description:f.description,pixels:f.pixels},128,72);
      f.pixels.fill(0);
      let uploads=0;
      const write=gpu.device.queue.writeBuffer.bind(gpu.device.queue);
      gpu.device.queue.writeBuffer=(buffer,offset,data,...args)=>{if(data.byteLength>192)uploads++;return write(buffer,offset,data,...args);};
      try {
        for(const channel of ['y','u','v','rgb']){
          setPresentationChannel(channel);
          if(!gpu.redrawChannel())throw Error('Uploaded YUV frame could not be redrawn');
          await Promise.resolve();await gpu.device.queue.onSubmittedWorkDone();
          const displayed=new OffscreenCanvas(128,72),ctx=displayed.getContext('2d');
          ctx.drawImage(gpuCanvas,0,0);
          const actual=ctx.getImageData(0,0,128,72).data,expected=yuvToRgba(f.description,original,channel);
          if(actual.some((value,i)=>Math.abs(value-expected[i])>1))throw Error(`Retained WebGPU viewport mismatch: ${channel}`);
          const captured=await gpu.capture();
          if(captured.some((value,i)=>Math.abs(value-expected[i])>1))throw Error(`Retained WebGPU capture mismatch: ${channel}`);
        }
        if(uploads)throw Error('Channel redraw uploaded pixel planes again');
      }finally{gpu.device.queue.writeBuffer=write;}
      if(gpu.errors.length)throw new Error(gpu.errors.join('; '));
      return {cases,webgl:'exact CPU match',webgpu:'CPU match within one RGB code'};
    }finally{surface.dispose();gpu.dispose();setPresentationChannel('rgb');}
  });
  assert.equal(result.cases,72);console.log(JSON.stringify(result));
}finally{await browser.close();}
