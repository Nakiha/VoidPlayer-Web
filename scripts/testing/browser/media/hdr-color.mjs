import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium, webkit } from 'playwright';

const args = process.argv.slice(2), requireWebGpu = args.includes('--require-webgpu');
const targets = args.filter(a => a !== '--require-webgpu');
if (!targets.length) targets.push('chromium');
if (targets.some(t => !['chromium', 'webkit', 'chrome', 'msedge'].includes(t))) throw new Error('Unknown HDR test browser');
const server = await createServer({ server: { port: 0, host: '127.0.0.1' } });
await server.listen();
let browser;
try {
  for (const name of targets) {
    const engine = name === 'webkit' ? webkit : chromium;
    browser = await engine.launch({ headless: !requireWebGpu, ...(['chrome', 'msedge'].includes(name) ? { channel: name } : {}) });
    const page = await browser.newPage();
    await page.route('**/hdr-color-test', route => route.fulfill({ contentType: 'text/html', body: '<canvas id="gl" width="1" height="1"></canvas>' }));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/hdr-color-test`);
    const result = await page.evaluate(async requireWebGpu => {
      const { hdrToSdrPreview, hdrToDisplayNits, hdrToDisplayP3, HDR_PREVIEW_POLICY } = await import('/src/hdr-color.ts');
      const { hdrPreviewGlsl, hdrPreviewWgsl } = await import('/src/hdr-shader.ts');
      const vectors = [];
      for (const transfer of ['pq', 'hlg']) {
        for (let i = 0; i <= 256; i++) vectors.push({ rgb: [i / 256, i / 256, i / 256], transfer });
        for (const rgb of [[.5080784215,.5080784215,.5080784215], [.580688881,.580688881,.580688881], [.751827096,.751827096,.751827096], [1,0,0], [0,1,0], [0,0,1], [1,1,0], [1,0,1], [0,1,1], [.7,.2,.5], [.001,.002,.003], [-.1,.3,1.1]]) vectors.push({ rgb, transfer });
        for (let i = 0; i < 128; i++) vectors.push({ rgb: [(i * 37 % 127) / 127, (i * 53 % 131) / 131, (i * 71 % 137) / 137], transfer });
      }
      const policies = [HDR_PREVIEW_POLICY, { ...HDR_PREVIEW_POLICY, sourcePeakNits: 4000 }, { ...HDR_PREVIEW_POLICY, sourcePeakNits: 2000, exposureWhiteNits: 300, hlgDisplayPeakNits: 2000, hlgSystemGamma: 1.326 }];
      const params = p => [p.sourcePeakNits, p.exposureWhiteNits, p.hlgDisplayPeakNits, p.hlgSystemGamma];
      const gl = document.querySelector('#gl').getContext('webgl', { alpha: false, preserveDrawingBuffer: true });
      if (!gl) throw new Error('WebGL is required for HDR kernel regression');
      const compile = (type, code) => {
        const shader = gl.createShader(type); gl.shaderSource(shader, code); gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
        return shader;
      };
      const vertex = compile(gl.VERTEX_SHADER, 'attribute vec2 position;void main(){gl_Position=vec4(position,0.,1.);}');
      const fragment = compile(gl.FRAGMENT_SHADER, `precision highp float;uniform vec3 rgb;uniform float transfer;uniform vec4 policy;${hdrPreviewGlsl}void main(){gl_FragColor=vec4(hdrPreview(rgb,transfer,policy),1.);}`);
      const program = gl.createProgram(); gl.attachShader(program, vertex); gl.attachShader(program, fragment); gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
      const buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buffer); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,3,-1,-1,3]), gl.STATIC_DRAW);
      gl.useProgram(program); const position = gl.getAttribLocation(program, 'position'); gl.enableVertexAttribArray(position); gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
      gl.viewport(0, 0, 1, 1); gl.disable(gl.DITHER);
      const rgbUniform = gl.getUniformLocation(program, 'rgb'), transferUniform = gl.getUniformLocation(program, 'transfer'), policyUniform = gl.getUniformLocation(program, 'policy');
      let glMax = 0, glWorst;
      const pixel = new Uint8Array(4);
      for (const policy of policies) for (const v of vectors) {
        gl.uniform3fv(rgbUniform, v.rgb); gl.uniform1f(transferUniform, v.transfer === 'pq' ? 1 : 2); gl.uniform4fv(policyUniform, params(policy));
        gl.drawArrays(gl.TRIANGLES, 0, 3); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
        const expected = hdrToSdrPreview(v.rgb, v.transfer, policy).map(v => Math.round(v * 255));
        const delta = Math.max(...expected.map((c, i) => Math.abs(c - pixel[i])));
        if (delta > glMax) { glMax = delta; glWorst = { ...v, policy, expected, actual: [...pixel] }; }
        if (pixel[3] !== 255) throw new Error('Unexpected GLSL output alpha');
      }
      const glError = gl.getError();
      gl.deleteBuffer(buffer); gl.deleteProgram(program); gl.deleteShader(vertex); gl.deleteShader(fragment);
      let gpu = { required: requireWebGpu, tested: false };
      if (requireWebGpu) {
        const adapter = await navigator.gpu?.requestAdapter();
        if (!adapter) throw new Error('WebGPU adapter is required; absence is not a passing HDR test');
        const device = await adapter.requestDevice(), errors = [];
        device.addEventListener('uncapturederror', e => errors.push(e.error.message));
        const module = device.createShaderModule({ code: `${hdrPreviewWgsl}
          @group(0) @binding(0) var<storage,read> input:array<vec4f>;
          @group(0) @binding(1) var<storage,read_write> output:array<vec4f>;
          @group(0) @binding(2) var<uniform> policy:vec4f;
          @compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u){
            if(id.x>=arrayLength(&input)){return;}
            let v=input[id.x];output[id.x*2u]=vec4f(hdrPreview(v.xyz,v.w,policy),1);
            output[id.x*2u+1u]=vec4f(hdrDisplayNits(v.xyz,v.w,policy),1);
          }` });
        const compilation = await module.getCompilationInfo();
        if (compilation.messages.some(m => m.type === 'error')) throw new Error(compilation.messages.map(m => m.message).join('\n'));
        const pipeline = await device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'main' } });
        const inputData = new Float32Array(vectors.flatMap(v => [...v.rgb, v.transfer === 'pq' ? 1 : 2]));
        const input = device.createBuffer({ size: inputData.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
        const byteLength = vectors.length * 32;
        const output = device.createBuffer({ size: byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
        const readback = device.createBuffer({ size: byteLength, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        const uniform = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        device.queue.writeBuffer(input, 0, inputData);
        const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: input } }, { binding: 1, resource: { buffer: output } }, { binding: 2, resource: { buffer: uniform } }] });
        let maxCodeDelta = 0, maxNitsRelative = 0;
        try {
          for (const policy of policies) {
            device.queue.writeBuffer(uniform, 0, new Float32Array(params(policy)));
            const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass();
            pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.dispatchWorkgroups(Math.ceil(vectors.length / 64)); pass.end();
            encoder.copyBufferToBuffer(output, 0, readback, 0, byteLength); device.queue.submit([encoder.finish()]);
            await readback.mapAsync(GPUMapMode.READ); const values = new Float32Array(readback.getMappedRange());
            try {
              for (let i = 0; i < vectors.length; i++) {
                // CPU evaluates the same float32 inputs used by the GPU.
                const rgb = [...inputData.subarray(i * 4, i * 4 + 3)], transfer = vectors[i].transfer;
                const expected = hdrToSdrPreview(rgb, transfer, policy), nits = hdrToDisplayNits(rgb, transfer, policy);
                for (let c = 0; c < 3; c++) {
                  const actual = values[i * 8 + c], actualNits = values[i * 8 + 4 + c];
                  if (!Number.isFinite(actual) || actual < 0 || actual > 1 || !Number.isFinite(actualNits)) throw new Error('Nonfinite or out-of-range WGSL output');
                  maxCodeDelta = Math.max(maxCodeDelta, Math.abs(Math.round(actual * 255) - Math.round(expected[c] * 255)));
                  maxNitsRelative = Math.max(maxNitsRelative, Math.abs(actualNits - nits[c]) / Math.max(1, nits[c]));
                }
              }
            } finally { readback.unmap(); }
          }
          gpu = { required: true, tested: true, maxCodeDelta, maxNitsRelative, errors };
        } finally { input.destroy(); output.destroy(); uniform.destroy(); readback.destroy(); device.destroy(); }
      }
      let extended;
      if(requireWebGpu){
        const {setColorOutput,defaultColorOutput}=await import('/src/color-output.ts');
        const {createExternalSurface}=await import('/src/webgpu-color-surface.mjs');
        const {yuvFixture}=await import('/test/helpers/yuv-fixture.ts');
        const {yuvToRgba}=await import('/src/yuv-color.ts');
        const {setColorMode,getColorMode}=await import('/src/color-mode.ts');const previousMode=getColorMode();setColorMode('reference');
        const original=window.matchMedia;
        // Simulates capability only to exercise the extended canvas. These
        // readbacks do not certify the physical HDR display or measured nits.
        window.matchMedia=query=>query==='(dynamic-range: high)'?{matches:true}:original.call(window,query);
        setColorOutput({...defaultColorOutput(),target:'hdr'});
        const canvas=document.createElement('canvas');const surface=await createExternalSurface(canvas,undefined,'planes');
        try{
          if(surface.outputTarget!=='hdr')throw new Error('Extended canvas configuration unavailable');
          const f=yuvFixture(10,false,false,'bt2020-ncl',2,2);f.description.color.transfer='pq';
          const frame={kind:'yuv',description:f.description,pixels:f.pixels,width:2,height:2};
          surface.present(frame);const pixels=await surface.captureHdrPixels(),preview=await surface.capture();
          const expected=yuvToRgba(f.description,f.pixels);
          const endpoint=hdrToDisplayP3([1,1,1],'pq');for(let y=0;y<2;y++)for(let x=0;x<2;x++)for(let c=0;c<4;c++){const expected=c===3?1:x===0?0:endpoint[c];if(Math.abs(pixels[(y*2+x)*4+c]-expected)>.004)throw new Error('Extended P3 pixel differs from independent CPU anchor');}
          const max=Math.max(...pixels);if(max<=1)throw new Error('HDR highlights were clipped to SDR');
          const maxPreview=Math.max(...preview.map((v,i)=>Math.abs(v-expected[i])));
          const capture=new OffscreenCanvas(2,2);surface.captureSource(capture);
          const captured=capture.getContext('2d').getImageData(0,0,2,2).data;
          const maxCapture=Math.max(...captured.map((v,i)=>Math.abs(v-expected[i])));
          if(maxPreview>1||maxCapture>1)throw new Error('HDR canvas SDR preview/capture differs from shared CPU transform');
          const native=new VideoFrame(new Uint16Array([64,940,64,940,512,512]),{format:'I420P10',codedWidth:2,codedHeight:2,timestamp:0,colorSpace:{matrix:'bt2020-ncl',primaries:'bt2020',transfer:'pq',fullRange:false}});
          try{surface.present(native);const raw=await surface.captureHdrPixels();const nativeMax=Math.max(...raw);extended={simulatedDisplayCapability:true,max,maxPreview,maxCapture,nativeMax,nativeHdrEnabledInProduct:false};}
          finally{native.close();}
          const {renderThumbnailCanvas}=await import('/src/presenter.ts');const {hdrYuvToRgba}=await import('/src/hdr-color.ts');
          const thumbFrame=yuvFixture(10,false,false,'bt2020-ncl',3,2);thumbFrame.description.color.transfer='pq';
          setColorOutput({...defaultColorOutput(),target:'hdr',preview:{...HDR_PREVIEW_POLICY,sourcePeakNits:4000}});
          const thumb=renderThumbnailCanvas({kind:'yuv',...thumbFrame,width:3,height:2},3);
          if(!thumb)throw new Error('Managed HDR thumbnail was skipped');
          const thumbPixels=thumb.canvas.getContext('2d').getImageData(0,0,3,2).data,thumbExpected=hdrYuvToRgba(thumbFrame.description,thumbFrame.pixels);
          extended.thumbnailMax=Math.max(...thumbPixels.map((v,i)=>Math.abs(v-thumbExpected[i])));
          if(extended.thumbnailMax>1)throw new Error('HDR thumbnail must use the fixed default preview recipe');
        }finally{surface.dispose();}
        setColorMode('browser');const browserSurface=await createExternalSurface(document.createElement('canvas'),undefined,'planes');
        try{if(browserSurface.outputTarget!=='sdr')throw new Error('Browser-managed HDR target must downgrade to SDR');}finally{browserSurface.dispose();window.matchMedia=original;setColorOutput(defaultColorOutput());setColorMode(previousMode);}
      }
      return { vectors: vectors.length, policies: policies.length, glMax, glWorst, glError, gpu, extended };
    }, requireWebGpu);
    assert.equal(result.glError, 0); assert.ok(result.glMax <= 1, `${name}: GLSL ${JSON.stringify(result.glWorst)}`);
    if (requireWebGpu) {
      assert.equal(result.gpu.tested, true); assert.deepEqual(result.gpu.errors, []);
      assert.ok(result.gpu.maxCodeDelta <= 1, `${name}: WGSL code error ${result.gpu.maxCodeDelta}`);
      assert.ok(result.gpu.maxNitsRelative <= .001, `${name}: WGSL nits error ${result.gpu.maxNitsRelative}`);
    }
    if(requireWebGpu)console.log('Extended surface diagnostics (simulated display capability): '+JSON.stringify(result.extended));
    console.log(`PASS ${name}: ${result.vectors} vectors × ${result.policies} policies; GLSL max ${result.glMax} code; ${requireWebGpu ? `WGSL max ${result.gpu.maxCodeDelta} code, nits relative ${result.gpu.maxNitsRelative}` : 'WebGPU not requested'}`);
    await browser.close(); browser = undefined;
  }
} finally { await browser?.close(); await server.close(); }
