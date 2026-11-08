import { chromium as nativeChromium, webkit, firefox } from 'playwright';

// Linux software graphics uses full Chromium's new headless mode, rather than
// the separate headless shell. Slow shader compilation has no GPU watchdog in
// these functional checks; suite deadlines and device/resource errors still fail.
export function chromiumLaunchOptions(options = {}, platform = process.platform) {
  if (options.headless === false) return options;
  const backend = platform === 'darwin' ? 'metal' : platform === 'win32' ? 'd3d11' : 'swiftshader';
  const software = platform === 'linux'
    ? ['--use-gl=angle', '--enable-unsafe-swiftshader', '--disable-accelerated-video-decode', '--disable-gpu-watchdog'] : [];
  const channel = platform === 'linux' && !options.executablePath ? { channel: 'chromium' } : {};
  return { ...channel, ...options, args: [...new Set([...(options.args ?? []), '--enable-unsafe-webgpu', `--use-angle=${backend}`, ...software])] };
}
const chromium = new Proxy(nativeChromium, {
  get(target, key) {
    if (key === 'launch') return (options = {}) => target.launch(chromiumLaunchOptions(options));
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});
export { chromium, webkit, firefox };
