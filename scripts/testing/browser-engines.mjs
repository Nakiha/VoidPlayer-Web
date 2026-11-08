import { chromium as nativeChromium, webkit, firefox } from 'playwright';

// Linux CI uses software WebGPU; macOS/Windows keep the native graphics
// backend so hardware-decoded textures can be imported. Visible probes stay native.
const chromium = new Proxy(nativeChromium, {
  get(target, key) {
    if (key === 'launch') return (options = {}) => target.launch({
      ...options,
      ...(options.headless !== false ? {args: [...new Set([...(options.args ?? []), '--enable-unsafe-webgpu', process.platform==='darwin'?'--use-angle=metal':process.platform==='win32'?'--use-angle=d3d11':'--use-angle=swiftshader'])]} : {}),
    });
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});
export { chromium, webkit, firefox };
