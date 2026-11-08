// Local Chromium replay against a running VoidPlayer. Timings are informational.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { withinBrowserPhase } from '../../browser-failure-evidence.mjs';
import { chooseTestGuest } from '../../test-identity.mjs';

const root = path.resolve(import.meta.dirname, '../../..');
const headless = process.argv.includes('--headless');
const base = process.env.BASE_URL ?? 'http://127.0.0.1:5180/';
const fixtures = ['h264_9s_1920x1080.mp4', 'mpeg2_10s_1280x720.ts'];
const viewport = { width: 1280, height: 800 }, dpr = 2;
const replay = { frames: 70, eventsPerFrame: 4, startZoom: 1.4, panDeltaY: 2, zoomDeltaY: 1 };
const output = process.env.BENCH_REPORT ?? path.join(root, '.run/viewport-bench', headless ? 'headless.json' : 'headed.json');
const browser = await chromium.launch({ headless });
try {
  const page = await browser.newPage({ viewport, deviceScaleFactor: dpr, locale: 'zh-CN' });
  await page.goto(base);
  await chooseTestGuest(page);
  await page.bringToFront();
  const browserSession = await browser.newBrowserCDPSession();
  const { gpu } = await browserSession.send('SystemInfo.getInfo');
  const client = await page.context().newCDPSession(page);
  await client.send('Performance.enable');
  const metrics = async () => Object.fromEntries((await client.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
  const build = await page.evaluate(async () => {
    const response = await fetch('/build-info.json', { cache: 'no-store' });
    if (!response.ok) throw Error('Cannot identify the served build');
    return { id: (await response.json()).buildId, entry: document.querySelector('script[type=module][src]').src };
  });
  assert.ok(build.id, 'Expected a versioned frontend build');
  const results = [];
  for (const [index, fixture] of fixtures.entries()) {
    const slot = ['A', 'B'][index];
    await page.locator('#file-' + slot).setInputFiles(path.join(root, 'fixtures/video', fixture));
    await page.waitForFunction(count => {
      const state = window.voidPlayer?.getState();
      if (state?.tracks.some(t => t.failure)) throw Error('Fixture failed to open');
      return state && !state.busy && !state.playing && state.tracks.filter(t => t.frame).length === count;
    }, index + 1);
    const tracks = await page.evaluate(() => window.voidPlayer.getState().tracks.map(t => ({
      slot: t.slot, name: t.name, width: t.width, height: t.height, decoder: t.decoder,
      executor: document.querySelector('#canvas-' + t.slot).dataset.colorExecutor,
    })));
    for (let pass = 1; pass <= 2; pass++) for (const method of ['pan', 'zoom']) {
      await page.evaluate(zoom => window.voidPlayer.setViewport({ zoom, offsetX: 0, offsetY: 0 }), replay.startZoom);
      // Let the previous gesture's deferred settle/recomposition finish outside the sample.
      await page.waitForTimeout(500);
      const before = await metrics();
      const sample = await withinBrowserPhase(() => page.evaluate(async ({ method, replay }) => {
        const stage = document.querySelector('#stage-A'), rect = stage.getBoundingClientRect();
        const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2, target = document.elementFromPoint(x, y);
        if (!stage.contains(target) || document.hidden) throw Error('Expected a visible, unobstructed video stage');
        const frame = () => new Promise(requestAnimationFrame);
        const start = window.voidPlayer.getViewport(), intervals = [];
        let previous = await frame();
        for (let i = 0; i < replay.frames; i++) {
          const deltaY = (i % 2 ? 1 : -1) * (method === 'zoom' ? replay.zoomDeltaY : replay.panDeltaY);
          for (let j = 0; j < replay.eventsPerFrame; j++) target.dispatchEvent(new WheelEvent('wheel', {
            clientX: x, clientY: y, deltaY, ctrlKey: method === 'zoom', bubbles: true, cancelable: true,
          }));
          const now = await frame();
          intervals.push(now - previous);
          previous = now;
          if (i === 0) {
            const current = window.voidPlayer.getViewport();
            const expectedY = start.offsetY + replay.eventsPerFrame * replay.panDeltaY;
            const correct = method === 'zoom' ? current.zoom > start.zoom : current.zoom === start.zoom && current.offsetY === expectedY;
            if (!correct) throw Error('The replay did not apply the expected ' + method);
          }
        }
        return intervals;
      }, { method, replay }), 30_000, { engine: 'chromium', caseName: 'viewport benchmark', phase: method });
      const after = await metrics(), sorted = [...sample].sort((a, b) => a - b);
      const p95Ms = sorted[Math.ceil(.95 * sorted.length) - 1];
      results.push({ tracks, pass, method, p95Ms, maxMs: sorted.at(-1), over25ms: sample.filter(ms => ms > 25).length,
        layouts: after.LayoutCount - before.LayoutCount, layoutMs: (after.LayoutDuration - before.LayoutDuration) * 1000, intervalsMs: sample });
      console.log(`${tracks.length} track(s), pass ${pass} ${method}: P95 ${p95Ms.toFixed(2)} ms`);
    }
  }
  const finalBuild = await page.evaluate(async () => (await (await fetch('/build-info.json', { cache: 'no-store' })).json()).buildId);
  assert.equal(finalBuild, build.id, 'The served build changed during the benchmark');
  const report = { schema: 'voidplayer-viewport-benchmark', version: 1, build, browser: browser.version(), headless, viewport, dpr, replay,
    renderers: gpu.devices.map(d => d.deviceString), compositing: gpu.featureStatus.gpu_compositing ?? 'unknown', results };
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(output);
} finally {
  await browser.close();
}
