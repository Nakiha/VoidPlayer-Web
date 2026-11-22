export interface SharpenSettings {
  radius: 1 | 2 | 3;
  strength: number;
}

declare const GPUBufferUsage: { readonly UNIFORM: number; readonly COPY_DST: number };
declare const GPUTextureUsage: { readonly STORAGE_BINDING: number; readonly TEXTURE_BINDING: number };

const shader = /* wgsl */ `
  @group(0) @binding(0) var source: texture_2d<f32>;
  @group(0) @binding(1) var destination: texture_storage_2d<rgba8unorm, write>;
  @group(0) @binding(2) var blurred: texture_2d<f32>;
  @group(0) @binding(3) var<uniform> params: vec2f;
  @group(0) @binding(4) var horizontal: texture_storage_2d<rgba16float, write>;
  const LUMA = vec3f(0.2126, 0.7152, 0.0722);
  const WEIGHTS = array(
    vec4f(2., 1., 0., 0.) / 4.,
    vec4f(6., 4., 1., 0.) / 16.,
    vec4f(20., 15., 6., 1.) / 64.
  );

  @compute @workgroup_size(8, 8)
  fn blur(@builtin(global_invocation_id) id: vec3u) {
    let size = textureDimensions(source);
    if (any(id.xy >= size)) { return; }
    let p = vec2i(id.xy);
    let xmax = i32(size.x) - 1;
    let radius = i32(params.x);
    let weights = WEIGHTS[radius - 1];
    var sum = dot(textureLoad(source, p, 0).rgb, LUMA) * weights.x;
    for (var i = 1; i <= radius; i++) {
      let a = textureLoad(source, vec2i(max(p.x - i, 0), p.y), 0).rgb;
      let b = textureLoad(source, vec2i(min(p.x + i, xmax), p.y), 0).rgb;
      sum += dot(a + b, LUMA) * weights[i];
    }
    textureStore(horizontal, p, vec4f(sum, 0., 0., 1.));
  }

  @compute @workgroup_size(8, 8)
  fn sharpen(@builtin(global_invocation_id) id: vec3u) {
    let size = textureDimensions(source);
    if (any(id.xy >= size)) { return; }
    let p = vec2i(id.xy);
    let ymax = i32(size.y) - 1;
    let radius = i32(params.x);
    let weights = WEIGHTS[radius - 1];
    var sum = textureLoad(blurred, p, 0).r * weights.x;
    for (var i = 1; i <= radius; i++) {
      let a = textureLoad(blurred, vec2i(p.x, max(p.y - i, 0)), 0).r;
      let b = textureLoad(blurred, vec2i(p.x, min(p.y + i, ymax)), 0).r;
      sum += (a + b) * weights[i];
    }
    let rgb = textureLoad(source, p, 0).rgb;
    let detail = (dot(rgb, LUMA) - sum) * params.y;
    textureStore(destination, p, vec4f(clamp(rgb + detail, vec3f(0.), vec3f(1.)), 1.));
  }
`;

export function createSharpen(device: GPUDevice) {
  const module = device.createShaderModule({ label: 'local luminance sharpen', code: shader });
  const blur = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'blur' } });
  const sharpen = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'sharpen' } });
  const params = device.createBuffer({ size: 8, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  let horizontal: GPUTexture | undefined, output: GPUTexture | undefined, boundSource: GPUTexture | undefined;
  let blurGroup: GPUBindGroup, sharpenGroup: GPUBindGroup;
  const clear = () => {
    horizontal?.destroy();
    output?.destroy();
    horizontal = output = boundSource = undefined;
  };

  return {
    render(source: GPUTexture, { radius, strength }: SharpenSettings) {
      const { width, height } = source;
      if (!horizontal || !output || width !== output.width || height !== output.height) {
        clear();
        const size = [width, height];
        const usage = GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING;
        horizontal = device.createTexture({ size, usage, format: 'rgba16float' });
        output = device.createTexture({ size, usage, format: 'rgba8unorm' });
      }
      if (boundSource !== source) {
        const inputView = source.createView(), intermediate = horizontal.createView(), paramsBinding = { buffer: params };
        blurGroup = device.createBindGroup({ layout: blur.getBindGroupLayout(0), entries: [
          { binding: 0, resource: inputView }, { binding: 3, resource: paramsBinding }, { binding: 4, resource: intermediate },
        ] });
        sharpenGroup = device.createBindGroup({ layout: sharpen.getBindGroupLayout(0), entries: [
          { binding: 0, resource: inputView }, { binding: 1, resource: output.createView() },
          { binding: 2, resource: intermediate }, { binding: 3, resource: paramsBinding },
        ] });
        boundSource = source;
      }
      device.queue.writeBuffer(params, 0, new Float32Array([radius, strength]));
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      for (const [pipeline, group] of [[blur, blurGroup], [sharpen, sharpenGroup]] as const) {
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, group);
        pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
      }
      pass.end();
      device.queue.submit([encoder.finish()]);
      return output;
    },
    clear,
    dispose() { clear(); params.destroy(); },
  };
}
