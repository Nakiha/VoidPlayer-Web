// Runs the SAME benchmark exposed by the app's Help dialog and WebMCP.
// Default: visible browser, 3 repetitions, 8 seconds or clip end per run.
// Usage: node scripts/bench-playback.mjs [chromium|webkit] [--headless]
// BASE_URL, BENCH_REPEATS, BENCH_DURATION_MS override the defaults.
import { chromium, webkit } from 'playwright';
const browserName = process.argv[2] === 'webkit' ? 'webkit' : 'chromium';
const headless = process.argv.includes('--headless');
const repeats = Number(process.env.BENCH_REPEATS ?? 3);
const durationMs = Number(process.env.BENCH_DURATION_MS ?? 8000);
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 20 || !Number.isInteger(durationMs) || durationMs < 1000 || durationMs > 30000) throw new Error('Invalid benchmark repeat count or duration');
const scenarios = {
  'hevc-4k-solo': ['mhw_hevc_fullrange_bt709_3s.mp4'],
  'vvc-wasm-solo': ['h266_10s_1920x1080.mp4'],
  'vvc+hevc-4k': ['h266_10s_1920x1080.mp4', 'mhw_hevc_fullrange_bt709_3s.mp4'],
  'mpeg2ts+h264': ['mpeg2_10s_1280x720.ts', 'h264_9s_1920x1080.mp4'],
};
const results = [];
const browser = await (browserName === 'webkit' ? webkit : chromium).launch({ headless });
try {
  for (const [scenario, files] of Object.entries(scenarios)) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    // Repeat in the same page to exercise replacement/worker cleanup, not just cold starts.
    for (let repeat = 1; repeat <= repeats; repeat++) {
      let timer;
      let onCrash;
      try {
        const crashed = new Promise((_, reject) => { onCrash = () => reject(new Error('page crashed')); page.once('crash', onCrash); });
        const run = async () => {
          if (repeat === 1) await page.goto(process.env.BASE_URL ?? 'http://127.0.0.1:5180/');
          await page.bringToFront();
          return page.evaluate(async ({ files, durationMs }) => {
            const tool = name => window.voidPlayer.tools.find(t => t.name === name);
            const lib = await tool('list_library').execute({});
            for (let i = 0; i < files.length; i++) {
              const entry = lib.entries?.find(e => e.name === files[i]);
              if (!entry) throw new Error(`Missing library sample: ${files[i]}`);
              await tool('load_library_item').execute({ id: entry.id, slot: i ? 'B' : 'A' });
            }
            return tool('benchmark_review').execute({ durationMs });
          }, { files, durationMs });
        };
        const report = await Promise.race([run(), crashed, new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('scenario timeout (including navigation/load)')), durationMs + 45000);
        })]);
        results.push({ scenario, repeat, browserName, headless, ...report });
      } catch (error) {
        results.push({ scenario, repeat, browserName, headless, passed: false, error: String(error.message ?? error) });
        break;
      } finally { clearTimeout(timer); if (onCrash) page.off('crash', onCrash); }
      console.error(`[bench] ${scenario} ${repeat}/${repeats}: ${results.at(-1).passed ? 'PASS' : 'FAIL'}`);
    }
    await page.close().catch(() => {});
  }
} finally { await browser.close(); }
for (const result of results) console.log(JSON.stringify(result));
const passed = results.length === Object.keys(scenarios).length * repeats && results.every(r => r.passed);
console.error(`summary: ${passed ? 'PASS' : 'FAIL'}; ${results.length} runs; headless=${headless}`);
process.exitCode = passed ? 0 : 1;
