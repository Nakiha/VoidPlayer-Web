import { chromium as nativeChromium, webkit, firefox } from 'playwright';

// Software graphics on Linux CI can exceed Chromium's GPU watchdog during
// shader compilation. Keep that watchdog off only in these headless functional
// checks; the suite still owns its deadline and fails on device/resource errors.
export function chromiumLaunchOptions(options = {}, platform = process.platform) {
  if (options.headless === false) return options;
  const backend = platform === 'darwin' ? 'metal' : platform === 'win32' ? 'd3d11' : 'swiftshader';
  const software = platform === 'linux'
    ? ['--use-gl=angle', '--enable-unsafe-swiftshader', '--disable-accelerated-video-decode', '--disable-gpu-watchdog'] : [];
  return { ...options, args: [...new Set([...(options.args ?? []), '--enable-unsafe-webgpu', `--use-angle=${backend}`, ...software])] };
}
const chromium = new Proxy(nativeChromium, {
  get(target, key) {
    if (key === 'launch') return (options = {}) => target.launch(chromiumLaunchOptions(options));
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});
export { chromium, webkit, firefox };
