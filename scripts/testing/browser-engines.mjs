import { chromium as nativeChromium, webkit, firefox } from 'playwright';

// Linux CI pairs Dawn and the compositor on SwiftShader Vulkan under Xvfb.
// ANGLE alone can create an adapter but lose it at getCurrentTexture().
// Suite deadlines and device/resource errors remain fatal.
export function chromiumLaunchOptions(options = {}, platform = process.platform, legacyScreenshot = !!process.env.PLAYWRIGHT_LEGACY_SCREENSHOT) {
  if (options.headless === false) return options;
  const backend = platform === 'darwin' ? 'metal' : platform === 'win32' ? 'd3d11' : 'vulkan';
  const software = platform === 'linux'
    ? ['--use-gl=angle', '--enable-unsafe-swiftshader', '--disable-accelerated-video-decode', '--disable-gpu-watchdog',
      '--enable-gpu', '--ignore-gpu-blocklist', '--use-vulkan=swiftshader',
      '--use-webgpu-adapter=swiftshader', '--disable-vulkan-surface']
    : platform==='win32'?['--enable-gpu','--ignore-gpu-blocklist']:[];
  const args = [...(options.args ?? [])];
  if (platform === 'linux') {
    const features = args.filter(arg => arg.startsWith('--enable-features=')).flatMap(arg => arg.slice('--enable-features='.length).split(','));
    for (let i = args.length - 1; i >= 0; i--) if (args[i].startsWith('--enable-features=')) args.splice(i, 1);
    // Chromium keeps the last enable-features switch, including over Playwright's
    // defaults. Preserve its screenshot surface instead of silently reverting it.
    const defaults = ['Vulkan', ...(legacyScreenshot ? [] : ['CDPScreenshotNewSurface'])];
    args.push(`--enable-features=${[...new Set([...features, ...defaults])].join(',')}`);
  }
  return { ...options, ...(['linux','win32'].includes(platform)?{headless:false}:{}), args: [...new Set([...args, '--enable-unsafe-webgpu', `--use-angle=${backend}`, ...software])] };
}
const chromium = new Proxy(nativeChromium, {
  get(target, key) {
    if (key === 'launch') return (options = {}) => target.launch(chromiumLaunchOptions(options));
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});
export { chromium, webkit, firefox };
