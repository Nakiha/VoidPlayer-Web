import assert from 'node:assert/strict';
import { withBrowserFixture } from '../../browser-fixture.mjs';

const engine = process.argv[2] ?? 'webkit';
await withBrowserFixture({ caseName: 'viewport-interactions', engine,
  pageOptions: { viewport: { width: 776, height: 778 }, hasTouch: true, locale: 'zh-CN' } }, async ({ page, ready, artifact }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => { window.__vpAnalysisQA = true; });
  await ready();
  await page.evaluate(async () => {
    const call = (name, args = {}) => window.voidPlayer.tools.find(tool => tool.name === name).execute(args);
    const library = await call('list_library');
    await call('load_library_item', { slot: 'A', id: library.entries.find(entry => entry.name === 'h264_9s_1920x1080.mp4').id });
  });
  const compact = page.locator('#library-compact');
  assert.equal(await compact.getAttribute('data-compact'), 'true', 'compact is the new default');
  assert.equal(await compact.getAttribute('aria-pressed'), null, 'density is a next-state action');
  await compact.evaluate(button => button.click());
  assert.equal(await compact.getAttribute('data-compact'), 'false');
  assert.match(await compact.getAttribute('aria-label'), /紧凑/);
  await compact.evaluate(button => button.click());
  assert.match(await compact.getAttribute('aria-label'), /详细/);
  const arrangement = await page.locator('#arrangement').getAttribute('data-arrangement');
  await page.locator('#arrangement').click();
  assert.notEqual(await page.locator('#arrangement').getAttribute('data-arrangement'), arrangement);
  await page.locator('#arrangement').click();
  assert.equal(await page.locator('#arrangement').getAttribute('data-arrangement'), arrangement);
  for (const id of ['arrangement', 'library-compact']) {
    const colors = await page.locator(`#${id}`).evaluate(button => ({ color: getComputedStyle(button).color,
      accent: getComputedStyle(document.querySelector('.slot-A')).backgroundColor }));
    assert.notEqual(colors.color, colors.accent, `${id} uses neutral color`);
  }
  if (await page.locator('#toggle-sources').getAttribute('aria-expanded') === 'true') await page.locator('#toggle-sources').click();
  await page.waitForFunction(() => ![...document.getAnimations()].some(animation => animation.playState === 'running' && animation.effect?.getComputedTiming().iterations !== Infinity));
  const box = await page.locator('#stage-A').boundingBox(), x = box.x + box.width / 2, y = box.y + box.height / 2;
  const view = () => page.evaluate(() => window.voidPlayer.exportState().viewport);
  const reset = async () => { await page.evaluate(() => window.voidPlayer.setViewport({ zoom: 1, offsetX: 0, offsetY: 0 })); await settle(); };
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const touch = await touchInput(page, engine);
  await page.mouse.move(x, y); await page.mouse.down({ button: 'right' });
  await page.waitForFunction(() => !document.querySelector('#viewport-pan-surface').hidden);
  await page.evaluate(({ x, y }) => {
    window.panCursorSamples = []; window.samplingPanCursor = true;
    const sample = () => {
      if (!window.samplingPanCursor) return;
      const target = document.elementFromPoint(x, y);
      window.panCursorSamples.push({ target: target.id, cursor: getComputedStyle(target).cursor });
      requestAnimationFrame(sample);
    }; sample();
  }, { x, y });
  for (let i = 1; i <= 4; i++) { await page.mouse.move(x + i, y + i); await page.waitForTimeout(90); }
  const cursors = await page.evaluate(() => { window.samplingPanCursor = false; return window.panCursorSamples; });
  assert.ok(cursors.length);
  assert.ok(cursors.every(sample => sample.target === 'viewport-pan-surface' && sample.cursor === 'grabbing'), 'slow and paused pan retains one stationary grabbing surface');
  await page.mouse.up({ button: 'right' });
  assert.equal(await page.locator('#viewport-pan-surface').isHidden(), true);
  await reset();
  await touch('start', [[1, x, y]]);
  await touch('move', [[1, x + 20, y + 30]]);
  await touch('end', []);
  await settle();
  assert.deepEqual([(await view()).offsetX, (await view()).offsetY], [20, 30]);
  assert.equal(await page.locator('#annotation-toolbar').isVisible(), false, 'single touch pans without opening annotations');
  await touch('start', [[1, x - 50, y]]);
  await touch('start', [[1, x - 50, y], [2, x + 50, y]]);
  await touch('move', [[1, x - 30, y + 30], [2, x + 70, y + 30]]);
  await touch('end', []);
  await settle();
  assert.equal((await view()).zoom, 1, 'two-finger pan at 1× must not accumulate zoom drift');
  assert.deepEqual([(await view()).offsetX, (await view()).offsetY], [40, 60]);
  await reset();
  const before = await page.locator('#image-A').boundingBox();
  await touch('start', [[1, x - 50, y]]);
  await touch('start', [[1, x - 50, y], [2, x + 50, y]]);
  await touch('move', [[1, x - 80, y + 20], [2, x + 120, y + 20]]);
  await touch('end', []);
  await settle();
  const after = await page.locator('#image-A').boundingBox();
  assert.ok(Math.abs((await view()).zoom - 2) < .001, 'two fingers zoom');
  assert.ok(Math.abs(after.x + (x - before.x) * after.width / before.width - x - 20) < 1, `pinch follows its moving midpoint horizontally: ${JSON.stringify({before, after, x, y, view: await view()})}`);
  assert.ok(Math.abs(after.y + (y - before.y) * after.height / before.height - y - 20) < 1, 'pinch follows its moving midpoint vertically');
  await reset();
  await page.locator('#toggle-annotations').click();
  await page.locator('[data-drawing-tool=pen]').click();
  await touch('start', [[1, x - 50, y - 40]]);
  await touch('move', [[1, x - 30, y - 25]]);
  await touch('start', [[1, x - 30, y - 25], [2, x + 70, y - 25]]);
  await touch('move', [[1, x - 50, y - 25], [2, x + 90, y - 25]]);
  await touch('end', [[1, x - 50, y - 25]]);
  await touch('move', [[1, x - 10, y + 10]]);
  await touch('end', []);
  assert.equal(await page.evaluate(() => window.voidPlayer.getState().marks.length), 0, 'second finger cancels the provisional stroke and the remaining finger cannot draw');
  await touch('start', [[1, x - 40, y - 30]]);
  await touch('move', [[1, x - 10, y - 10]]);
  await touch('end', []);
  assert.equal(await page.evaluate(() => window.voidPlayer.getState().marks[0]?.drawings.length), 1, 'fresh single touch annotates');
  await page.locator('#mark-close').click();
  await page.locator('#toggle-analysis').click();
  await page.locator('#analysis-locate').waitFor();
  assert.deepEqual(await page.locator('.analysis-zoom-controls button').evaluateAll(buttons => buttons.map(button => button.dataset.seg ?? button.id)),
    ['analysis-range-trigger', 'analysis-zoom-in', 'analysis-zoom-out', 'full', 'analysis-locate', 'analysis-follow']);
  assert.equal(await page.locator('#analysis-follow span').textContent(), '跟随');
  await page.evaluate(async () => {
    const state = window.voidPlayer.exportState();
    Object.assign(state.layout.analysisView, { diagrams: ['bitrate'], showBitrate: true, showSize: false,
      loadMetrics: ['bitrate'], view: { start: 1000000, end: 3000000 } });
    await window.voidPlayer.applyState(state);
    await window.voidPlayer.seek(0);
  });
  await page.waitForFunction(() => window.__vpAnalysis?.queryResults[0]?.samples > 0 && !window.__vpAnalysis.queryPending.length);
  const curve = page.locator('#analysis-canvas'), curveBounds = await curve.boundingBox();
  await page.mouse.move(curveBounds.x + 250, curveBounds.y + 30);
  await page.waitForFunction(() => window.__vpAnalysis?.inspection?.tracks[0]?.refAxis > 1000000);
  const curveTarget = await page.evaluate(() => window.__vpAnalysis.inspection.tracks[0].refAxis);
  const curveRange = await page.evaluate(() => window.voidPlayer.exportState().layout.analysisView.view);
  await curve.click({ position: { x: 250, y: 30 } });
  await page.waitForFunction(time => window.voidPlayer.getState().positionUs === time && !window.voidPlayer.getState().busy, curveTarget);
  assert.equal(await page.evaluate(() => window.voidPlayer.getState().tracks[0].frame.ptsUs), curveTarget,
    'clicking a load curve seeks exactly the card frame');
  assert.deepEqual(await page.evaluate(() => window.voidPlayer.exportState().layout.analysisView.view), curveRange);
  await page.evaluate(async () => {
    const state = window.voidPlayer.exportState();
    state.layout.analysisView.view = { start: 1000000, end: 2000000 };
    await window.voidPlayer.applyState(state);
    await window.voidPlayer.seek(4500000);
  });
  const range = () => page.evaluate(() => window.voidPlayer.exportState().layout.analysisView);
  const span = (await range()).view.end - (await range()).view.start;
  await page.locator('#analysis-locate').click();
  await page.waitForFunction(() => window.voidPlayer.exportState().layout.analysisView.view.start > 3900000);
  const located = (await range()).view;
  assert.equal(located.end - located.start, span);
  assert.ok(Math.abs((located.start + located.end) / 2 - 4500000) < 50000, 'current displayed frame is centered');
  await page.locator('#analysis-follow').click();
  assert.equal((await range()).follow, true);
  await page.evaluate(() => window.voidPlayer.seek(6500000));
  await page.waitForFunction(() => window.voidPlayer.exportState().layout.analysisView.view.start > 5900000);
  assert.equal((await range()).view.end - (await range()).view.start, span);
  await page.evaluate(() => window.voidPlayer.play());
  await page.waitForFunction(() => window.voidPlayer.exportState().layout.analysisView.view.start > 6400000);
  await page.evaluate(() => window.voidPlayer.pause());
  assert.equal((await range()).follow, true);
  await page.locator('#analysis-zoom-in').click();
  assert.equal((await range()).follow, false, 'manual navigation releases follow mode');
  await page.evaluate(() => window.voidPlayer.seek(4500000));
  const dts = await page.evaluate(async () => {
    const track = window.voidPlayer.getState().tracks[0], time = track.frame.ptsUs + track.offsetUs;
    const result = await window.voidPlayer.tools.find(tool => tool.name === 'query_analysis').execute({
      slot: 'A', startUs: time, endUs: time + 1, axis: 'pts', pixelWidth: 1000 });
    return result.samples.find(sample => sample.effectivePtsUs === time)?.dtsUs;
  });
  assert.equal(typeof dts, 'number', 'fixture exposes actual DTS');
  await page.locator('#analysis-axis [data-axis=dts]').click();
  const dtsSpan = (await range()).view.end - (await range()).view.start;
  await page.locator('#analysis-locate').click();
  await page.waitForFunction(expected => {
    const view = window.voidPlayer.exportState().layout.analysisView.view;
    return Math.abs((view.start + view.end) / 2 - expected) < 2;
  }, dts);
  assert.equal((await range()).view.end - (await range()).view.start, dtsSpan);
  await page.screenshot({ path: artifact('viewport-interactions.png') });
  assert.deepEqual(errors, []);
  console.log(`PASS ${engine}: ${engine === 'chromium' ? 'native multi-touch' : 'pointer touch simulation'}, pan/pinch anchors, annotation arbitration, neutral toggles, curve-to-card frame seek, locate/follow and constant time span`);
});

async function touchInput(page, engine) {
  if (engine === 'chromium') {
    const cdp = await page.context().newCDPSession(page);
    return (type, points) => cdp.send('Input.dispatchTouchEvent', { type: `touch${type === 'start' ? 'Start' : type === 'move' ? 'Move' : 'End'}`,
      touchPoints: points.map(([id, x, y]) => ({ id, x, y, radiusX: 5, radiusY: 5 })) });
  }
  // WebKit's automation protocol exposes single taps only. Exercise the same
  // PointerEvent sequence there; native browser contact/capture is covered above.
  await page.evaluate(() => {
    const capture = Element.prototype.setPointerCapture, release = Element.prototype.releasePointerCapture;
    Element.prototype.setPointerCapture = function(id) { if (id < 900) capture.call(this, id); };
    Element.prototype.releasePointerCapture = function(id) { if (id < 900) release.call(this, id); };
    window.__testTouches = new Map();
  });
  return (type, points) => page.evaluate(({ type, points }) => {
    const active = window.__testTouches, remaining = new Set(points.map(([id]) => id));
    const dispatch = (target, kind, id, x, y) => target.dispatchEvent(new PointerEvent(kind, { bubbles: true, cancelable: true,
      pointerType: 'touch', pointerId: id + 900, button: 0, buttons: kind === 'pointerup' ? 0 : 1, clientX: x, clientY: y }));
    for (const [id, x, y] of points) {
      const previous = active.get(id), target = previous?.target ?? document.elementFromPoint(x, y);
      if (!previous) dispatch(target, 'pointerdown', id, x, y);
      else if (type === 'move') dispatch(target, 'pointermove', id, x, y);
      active.set(id, { target, x, y });
    }
    for (const [id, { target, x, y }] of active) if (!remaining.has(id)) { dispatch(target, 'pointerup', id, x, y); active.delete(id); }
  }, { type, points });
}
