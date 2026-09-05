// Offscreen playback benchmark. Requires the media-library service on :5180
// (npm run serve -- --folder ../resources/video) with a current dist build.
// Usage: PLAYWRIGHT_BROWSERS_PATH=../.cache/ms-playwright node scripts/bench-playback.mjs [chromium|webkit]

import { chromium, webkit } from 'playwright';

const browserName = process.argv[2] === 'webkit' ? 'webkit' : 'chromium';
const base = 'http://127.0.0.1:5180/';

// name -> [library file for A, library file for B | null]
const SCENARIOS = {
  'hevc-4k-solo': ['mhw_hevc_fullrange_bt709_3s.mp4', null],
  'vvc-wasm-solo': ['h266_10s_1920x1080.mp4', null],
  'vvc+hevc-4k': ['h266_10s_1920x1080.mp4', 'mhw_hevc_fullrange_bt709_3s.mp4'],
  'mpeg2ts+h264': ['mpeg2_10s_1280x720.ts', 'h264_9s_1920x1080.mp4'],
};

const results = [];
const browser = await (browserName === 'webkit' ? webkit : chromium).launch();
try {
  for (const [name, [fileA, fileB]] of Object.entries(SCENARIOS)) {
    const page = await browser.newPage();
    const crashed = new Promise((_, reject) => page.once('crash', () => reject(new Error('page crashed'))));
    try {
      await Promise.race([page.goto(base, { waitUntil: 'load' }), crashed]);
      const loaded = await page.evaluate(async ([a, b]) => {
        const tools = window.voidPlayer.tools;
        const find = n => tools.find(t => t.name === n);
        const lib = await find('list_library').execute({});
        if (!lib.entries?.length) throw new Error('library unavailable');
        const id = name => lib.entries.find(e => e.name === name)?.id;
        await find('load_library_item').execute({ id: id(a), slot: 'A' });
        if (b) await find('load_library_item').execute({ id: id(b), slot: 'B' });
        return window.voidPlayer.getState().tracks.map(t => ({ slot: t.slot, codec: t.codec, decoder: t.decoder, w: t.width, h: t.height }));
      }, [fileA, fileB]);

      // 4 s wall-clock playback; sample position; real draw counts come from
      // the session's 播放采样 debug events (polling getState is too coarse).
      const probe = await Promise.race([page.evaluate(async () => {
        const longTasks = [];
        new PerformanceObserver(list => { for (const e of list.entries()) longTasks.push(e.duration); }).observe({ entryTypes: ['longtask'] });
        const out = [];
        await window.voidPlayer.play();
        const t0 = performance.now();
        while (performance.now() - t0 < 4000) {
          await new Promise(r => setTimeout(r, 200));
          const s = window.voidPlayer.getState();
          out.push({ wall: performance.now() - t0, positionUs: s.positionUs, playing: s.playing });
        }
        await window.voidPlayer.pause();
        const logs = await window.voidPlayer.tools.find(t => t.name === 'get_review_logs').execute({ level: 'debug', limit: 2000 });
        const sampling = (logs.events ?? logs).filter(e => e.msg === '播放采样').map(e => e.data);
        return { samples: out, longTasks, sampling };
      }), crashed]);

      const s = probe.samples;
      // ratio of media time advanced to wall time spent actually playing
      const played = s.filter(x => x.playing);
      const activeWallS = played.length ? (played.at(-1).wall - played[0].wall) / 1000 : 0;
      const mediaS = played.length ? (played.at(-1).positionUs - played[0].positionUs) / 1e6 : 0;
      const posRatio = activeWallS > 0 ? mediaS / activeWallS : 0;
      // drawn frames per track per sampled window from the session's own counters
      const fps = [];
      for (const window of probe.sampling) {
        for (const [slot, n] of Object.entries(window.drawnPerTrack ?? {})) {
          const i = slot === 'A' ? 0 : 1;
          fps[i] = Math.max(fps[i] ?? 0, Math.round(n / 2)); // 2 s sampling window
        }
      }
      const longTaskMs = probe.longTasks.reduce((a, b) => a + b, 0);
      results.push({
        scenario: name, tracks: loaded,
        mediaAdvancedS: +mediaS.toFixed(2), activeWallS: +activeWallS.toFixed(2),
        posRatio: +posRatio.toFixed(2), drawnFpsPerTrackMax: fps,
        samplingWindows: probe.sampling.length,
        longTaskCount: probe.longTasks.length, longTaskTotalMs: Math.round(longTaskMs),
      });
    } catch (error) {
      results.push({ scenario: name, error: String(error.message ?? error) });
    }
    await page.close();
  }
} finally {
  await browser.close();
}

for (const r of results) console.log(JSON.stringify(r));
const crashedAny = results.some(r => r.error);
const slow = results.filter(r => !r.error && r.posRatio < 0.85);
const janky = results.filter(r => !r.error && r.longTaskTotalMs > 1500);
console.log(`\nsummary: scenarios=${results.length} crashed=${crashedAny} slow=${slow.map(r => r.scenario)} janky=${janky.map(r => r.scenario)}`);
process.exit(crashedAny ? 2 : 0);
