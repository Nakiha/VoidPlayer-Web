import shaders from 'virtual:voidplayer-websr-shaders';

declare const GPUTextureUsage: { readonly TEXTURE_BINDING: number; readonly STORAGE_BINDING: number };

export function createWebSrUpscaler(device: GPUDevice) {
  const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
  const pipelines = shaders.map(code => device.createComputePipeline({
    label: 'WebSR Real Life S',
    layout: 'auto',
    compute: { module: device.createShaderModule({ code }), entryPoint: 'computeMain' },
  }));
  let first: GPUTexture | undefined, second: GPUTexture | undefined, output: GPUTexture | undefined, source: GPUTexture | undefined;
  let bindings: GPUBindGroup[] = [];
  const texture = (width: number, height: number, format: GPUTextureFormat) => device.createTexture({
    label: 'WebSR Real Life S',
    size: [width, height],
    format,
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
  });
  const clear = () => {
    first?.destroy();
    second?.destroy();
    output?.destroy();
    first = second = output = source = undefined;
    bindings = [];
  };
  return {
    configureTexture(width: number, height: number) {
      clear();
      first = texture(width, height, 'rgba16float');
      second = texture(width, height, 'rgba16float');
      output = texture(2 * width, 2 * height, 'rgba8unorm');
    },
    renderTexture(input: GPUTexture) {
      if (!first || !second || !output) throw new Error('WebSR textures are not configured');
      if (source !== input) {
        const sourceView = input.createView(), a = first.createView(), b = second.createView();
        const resources = [[sourceView, a], [a, b], [b, a], [a, b], [sampler, sourceView, b, output.createView()]];
        bindings = resources.map((group, index) => device.createBindGroup({
          layout: pipelines[index].getBindGroupLayout(0),
          entries: group.map((resource, binding) => ({ resource, binding })),
        }));
        source = input;
      }
      const encoder = device.createCommandEncoder({ label: 'WebSR Real Life S' });
      const pass = encoder.beginComputePass();
      for (const [index, pipeline] of pipelines.entries()) {
        const target = index === pipelines.length - 1 ? output : input;
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindings[index]);
        pass.dispatchWorkgroups(Math.ceil(target.width / 8), Math.ceil(target.height / 8));
      }
      pass.end();
      device.queue.submit([encoder.finish()]);
      return output;
    },
    clear,
    dispose: clear,
  };
}
