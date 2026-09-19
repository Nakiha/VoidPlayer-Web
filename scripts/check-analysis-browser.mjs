// 顶部码流分析面板回归：只读查询口径、双轨配对、悬停/定位、DTS 切换、
// 播放共存。Usage: npm run test:analysis:browser -- [webkit|chromium]
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import path from 'node:path';
import { chromium, webkit } from 'playwright';
import { createMediaServer } from '../server/app.ts';

const engineName = process.argv[2] ?? 'webkit';
assert.ok(['webkit', 'chromium'].includes(engineName), 'Expected webkit or chromium');
const root = path.resolve(import.meta.dirname, '..');
const temp = await mkdtemp(join(tmpdir(), 'vp-analysis-'));
let browser, server;
try {
  server = createMediaServer({
    roots: [join(root, 'fixtures/video')], staticDir: join(root, 'dist'), onLog() {},
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  browser = await (engineName === 'webkit' ? webkit : chromium).launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  // 测试快照钩子只在 QA 显式启用时构建，生产 hover 不为测试付费。
  await page.addInitScript(() => { window.__vpAnalysisQA = true; });
  page.setDefaultTimeout(30000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(base);
  await page.waitForFunction(() => window.voidPlayer);
  if (await page.locator('#identity-welcome').isVisible().catch(() => false)) {
    await page.locator('#identity-welcome [data-guest]').click();
    await page.locator('#identity-welcome').waitFor({ state: 'hidden' });
  }
  // 面板默认折叠；空会话下展开开关禁用（与子轨道面板同契约）。
  await page.locator('#analysis-panel').waitFor({ state: 'attached' });
  assert.equal(await page.locator('#toggle-analysis').getAttribute('aria-expanded'), 'false');
  assert.equal(await page.locator('#toggle-analysis').isDisabled(), true);

  // 经由 Agent 同一入口载入两轨（与 UI 共用会话行为）。
  const ids = await page.evaluate(async () => {
    const tools = window.voidPlayer.tools;
    const list = tools.find(t => t.name === 'list_library');
    const found = {};
    for (const name of ['ci_h264_smoke.mp4', 'h264_9s_1920x1080.mp4']) {
      const page1 = await list.execute({ search: name, limit: 10 });
      const entry = (page1.entries ?? []).find(e => e.name === name);
      found[name] = entry?.id;
    }
    return found;
  });
  assert.ok(ids['ci_h264_smoke.mp4'], 'Missing fixture: ci_h264_smoke.mp4');
  assert.ok(ids['h264_9s_1920x1080.mp4'], 'Missing fixture: h264_9s_1920x1080.mp4');
  await page.evaluate(async ids => {
    const tools = window.voidPlayer.tools;
    const load = tools.find(t => t.name === 'load_library_item');
    await load.execute({ id: ids['ci_h264_smoke.mp4'], slot: 'A' });
    await load.execute({ id: ids['h264_9s_1920x1080.mp4'], slot: 'B' });
  }, ids);
  // 有轨道后开关可用，展开面板，并等打开动画落定再量坐标。
  await page.waitForFunction(() => !document.getElementById('toggle-analysis').disabled, undefined, { timeout: 30000 });
  await page.locator('#toggle-analysis').click();
  await page.waitForFunction(() => !document.getElementById('analysis-panel').hidden);
  await page.waitForFunction(() => {
    const r1 = document.getElementById('analysis-canvas').getBoundingClientRect();
    return r1.y > 0 && r1.height > 0;
  }, undefined, { timeout: 15000 });
  await page.waitForTimeout(500);
  // 等两轨分析就绪（原生路径懒枚举 + 会话投影 + 双方结果落定）。
  await page.waitForFunction(async () => {
    const q = window.voidPlayer.tools.find(t => t.name === 'query_analysis');
    try {
      const [a, b] = await Promise.all([
        q.execute({ slot: 'A', startUs: 0, endUs: 10000000, pixelWidth: 60, bitrateWindowUs: 250000 }),
        q.execute({ slot: 'B', startUs: 0, endUs: 10000000, pixelWidth: 60, bitrateWindowUs: 250000 }),
      ]);
      return a.samples.length > 0 && b.samples.length > 0
        && a.capability.indexState === 'complete' && b.capability.indexState === 'complete';
    } catch { return false; }
  }, { timeout: 180000 });

  // Agent 查询口径：压缩字节总数与文件大小一致（1752B 级小文件除外，按总和校验大文件）。
  const stats = await page.evaluate(async () => {
    const q = window.voidPlayer.tools.find(t => t.name === 'query_analysis');
    const r = await q.execute({ slot: 'B', startUs: 0, endUs: 10000000, pixelWidth: 600, bitrateWindowUs: 1000000 });
    const sizes = r.samples.map(s => s.sizeBytes);
    return {
      samples: r.samples.length, truncated: r.truncated,
      total: sizes.reduce((a, b) => a + b, 0),
      max: Math.max(...sizes),
      peak: Math.max(...r.bitrate.map(p => p.mbps ?? -1)),
      dts: r.samples.filter(s => s.dtsUs == null).length,
    };
  });
  assert.equal(stats.truncated, false);
  assert.ok(stats.samples > 100, `samples=${stats.samples}`);
  assert.ok(stats.total > 10_000_000, `total=${stats.total}`);
  assert.ok(stats.peak > 5 && stats.peak < 60, `peak=${stats.peak}`);
  assert.equal(stats.dts, stats.samples); // 原生路径无 DTS，不得伪造

  // 原生轨道查 DTS 应明确失败，不返回伪造时间。
  const dtsFailed = await page.evaluate(async () => {
    const q = window.voidPlayer.tools.find(t => t.name === 'query_analysis');
    try { await q.execute({ slot: 'B', startUs: 0, endUs: 1000000, axis: 'dts', pixelWidth: 100, bitrateWindowUs: 1000000 }); }
    catch (error) { return /DTS/.test(error.message); }
    return false;
  });
  assert.equal(dtsFailed, true);

  // 悬停只读：横轴带区悬浮条，不触发 seek；只开码率图也能读两轨码率。
  const box = await page.locator('#analysis-canvas').boundingBox();
  let posBefore = await page.locator('#position').inputValue();
  // 图表占满面板宽度（无右侧固定表）。
  const bodyBox = await page.locator('#analysis-body').boundingBox();
  assert.ok(Math.abs(bodyBox.width - box.width) <= 2, `图表应占满面板宽：body=${bodyBox.width} canvas=${box.width}`);
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.waitForFunction(() => window.__vpAnalysis?.inspection, undefined, { timeout: 10000 });
  const tip0 = await page.locator('.analysis-card').textContent();
  assert.match(tip0, /码率/);
  assert.match(tip0, /帧率|样本率/);
  assert.match(tip0, /帧大小/);
  // 单位常驻；无邻近说明、无直击摘要、无近似后缀。
  assert.match(tip0, /Mbps/);
  assert.match(tip0, /fps|\/s/);
  assert.match(tip0, /KiB/);
  assert.doesNotMatch(tip0, /邻近/);
  assert.doesNotMatch(tip0, /直击/);
  assert.doesNotMatch(tip0, /≈/);
  assert.doesNotMatch(tip0, /该区间无覆盖/);
  assert.equal(await page.locator('#position').inputValue(), posBefore);
  // 横轴下方卡片：竖排三行带单位，X 以鼠标为中心（限位），不盖数据区与轴数字。
  const mx = box.x + box.width * 0.45, my = box.y + box.height * 0.5;
  await page.mouse.move(mx, my);
  await page.waitForTimeout(400);
  const fl = await page.evaluate(() => window.__vpAnalysis.float);
  assert.ok(fl, '悬停时卡片应可见');
  assert.match(await page.locator('.analysis-card .fl-time').textContent(), /\d\d:\d\d\.\d\d\d/);
  assert.ok(fl.x >= box.x - 1 && fl.x + fl.width <= box.x + box.width + 1, `卡片横向不出绘图区：${JSON.stringify(fl)}`);
  assert.ok(fl.y >= box.y + box.height - 4, `卡片应在横轴下方、不盖图表与轴数字：${JSON.stringify(fl)}`);
  assert.ok(Math.abs((fl.x + fl.width / 2) - mx) <= fl.width / 2 + 8, '卡片水平以鼠标为中心');
  // 移出后顶层卡片隐藏（不占布局）。
  await page.mouse.move(box.x + box.width * 0.5, box.y - 60);
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => window.__vpAnalysis.float), null, '移出后卡片隐藏');
  // 等待测试快照：布局 glyph 就绪。
  await page.waitForFunction(() => window.__vpAnalysis?.glyphs?.length > 0, undefined, { timeout: 30000 });
  // 只开码率图：隐藏帧大小行，鼠标在曲线上仍能读两轨码率。
  const sizePressed = await page.locator('[data-seg="size"]').getAttribute('aria-pressed');
  if (sizePressed === 'true') await page.locator('[data-seg="size"]').click();
  // 取两轨重叠区（A 约 4s、B 约 10s，选 25% 宽度 ≈2.5s，两轨都在覆盖内）。
  await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.25);
  await page.waitForTimeout(400);
  const bitrateOnly = await page.evaluate(() => window.__vpAnalysis.inspection);
  assert.ok(bitrateOnly && bitrateOnly.tracks.length === 2, '两轨检查状态');
  assert.ok(bitrateOnly.tracks.every(t => t.bitrate != null), `只开码率图两轨码率可用：${JSON.stringify(bitrateOnly.tracks)}`);
  if (sizePressed === 'true') await page.locator('[data-seg="size"]').click();
  // 同一 x 在码率行内上下移动（均不命中单样本柱）：公共时间与各轨码率不变。
  await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.15);
  await page.waitForTimeout(400);
  const top = await page.evaluate(() => window.__vpAnalysis.inspection);
  await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.3);
  await page.waitForTimeout(400);
  const bottom = await page.evaluate(() => window.__vpAnalysis.inspection);
  assert.ok(top && bottom, '上下均有检查状态');
  assert.equal(bottom.t, top.t);
  assert.deepEqual(bottom.tracks.map(t => t.bitrate), top.tracks.map(t => t.bitrate));

  // 全览区间桶点击：按峰值样本定位，不缩放视图（取中间桶，避开 0 时刻峰值）。
  const bucket = await page.evaluate(() => {
    const bs = window.__vpAnalysis.glyphs.filter(g => g.kind === 'bucket');
    return bs[Math.floor(bs.length / 2)];
  });
  assert.ok(bucket, '全览应有区间桶 glyph');
  const viewB0 = await page.evaluate(() => window.__vpAnalysis.view);
  await page.mouse.click(box.x + bucket.cx, box.y + bucket.cy);
  await page.waitForFunction(pos => document.getElementById('position').value !== pos, posBefore, { timeout: 8000 });
  const viewB1 = await page.evaluate(() => window.__vpAnalysis.view);
  assert.deepEqual(viewB1, viewB0, '桶点击只定位，不缩放视图');
  posBefore = await page.locator('#position').inputValue();

  // 框选放大后跟随关闭（区间桶按峰值样本定位，放大只走框选/滚轮）。
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.5, { steps: 8 });
  await page.mouse.up();
  await page.waitForFunction(() => document.querySelector('[data-seg="follow"]').textContent === '跟随：关', undefined, { timeout: 15000 });

  // 放大到逐样本后，单击指定 B 柱：必须命中 B 的 sampleId 与可信展示 PTS。
  // 若仍为共享桶（点击只放大），继续框选缩小直到出现逐样本 glyph。
  let clicked = null;
  for (let attempt = 0; attempt < 6 && !clicked; attempt++) {
    await page.waitForFunction(() => window.__vpAnalysis?.glyphs?.some(g => g.kind === 'sample'), undefined, { timeout: 30000 }).catch(() => {});
    const hasSample = await page.evaluate(() => window.__vpAnalysis?.glyphs?.some(g => g.kind === 'sample'));
    if (!hasSample) {
      await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.7);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.7, { steps: 8 });
      await page.mouse.up();
      await page.waitForTimeout(1500);
      continue;
    }
    const target = await page.evaluate(() => window.__vpAnalysis.glyphs.find(g => g.kind === 'sample' && g.slot === 'B' && !g.stacked));
    assert.ok(target, '应有 B 逐样本 glyph');
    const viewBefore = await page.evaluate(() => window.__vpAnalysis.view);
    await page.mouse.click(box.x + target.cx, box.y + target.cy);
    try {
      await page.waitForFunction(pos => document.getElementById('position').value !== pos, posBefore, { timeout: 8000 });
      clicked = target;
    } catch {
      // 未定位（如点到聚合标记）时换一个 B 柱再试。
      await page.evaluate((exclude) => {
        window.__vpAnalysis.glyphs = window.__vpAnalysis.glyphs.filter(g => g.id !== exclude);
      }, target.id);
      continue;
    }
    // 单击单帧只定位，不缩放视图。
    const viewAfter = await page.evaluate(() => window.__vpAnalysis.view);
    assert.deepEqual(viewAfter, viewBefore, '单击不得改变视图范围');
  }
  assert.ok(clicked, '指定 B 柱应能定位');
  assert.equal(clicked.slot, 'B');
  // 直接命中一致性：表格、高亮、点击须为同一 sampleId，不得表里一个、定位另一个。
  const hitState = await page.evaluate(() => window.__vpAnalysis.inspection);
  assert.equal(hitState.direct?.kind, 'sample');
  assert.equal(hitState.direct?.sampleId, clicked.id);
  assert.equal(hitState.tracks.find(t => t.slot === 'B')?.refId, clicked.id);
  assert.equal(hitState.t, clicked.axisUs);
  const posAfter = await page.locator('#position').inputValue();
  assert.notEqual(posAfter, posBefore);
  // 点击后位置应接近该 B 样本的轴时间（±100ms 内），不得退回第一轨最近样本。
  const statePos = await page.evaluate(() => window.voidPlayer.getState().positionUs);
  assert.ok(Math.abs(statePos - clicked.axisUs) < 100_000, `position=${statePos} axis=${clicked.axisUs}`);

  await page.locator('#analysis-canvas').dblclick();
  await page.waitForFunction(() => document.querySelector('[data-seg="follow"]').textContent === '跟随：开', undefined, { timeout: 15000 });

  // 滚轮平移：先框选放大，再滚轮，同一像素下的时间变化，且跟随关闭。
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5, { steps: 8 });
  await page.mouse.up();
  await page.waitForFunction(() => document.querySelector('[data-seg="follow"]').textContent === '跟随：关', undefined, { timeout: 15000 });
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.5);
  await page.waitForFunction(() => window.__vpAnalysis?.inspection, undefined, { timeout: 15000 });
  const t0 = await page.locator('.analysis-card .fl-time').textContent();
  await page.mouse.wheel(0, 400);
  await page.waitForFunction(prev => document.querySelector('.analysis-card .fl-time')?.textContent !== prev, t0, undefined, { timeout: 10000 });
  assert.equal(await page.locator('[data-seg="follow"]').textContent(), '跟随：关');
  // Ctrl+滚轮（触摸板捏合）：以 hover 为中心缩放，不报错且悬停可用。
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -400);
  await page.keyboard.up('Control');
  await page.waitForTimeout(1000);
  assert.match(await page.locator('.analysis-card .fl-time').textContent(), /\d\d:\d\d\.\d\d\d/);
  await page.locator('#analysis-canvas').dblclick();
  await page.waitForTimeout(500);

  // 播放共存：面板打开时播放推进且无错误。
  await page.evaluate(() => window.voidPlayer.play());
  await page.waitForFunction(() => document.getElementById('position').value !== '00:00.000', undefined, { timeout: 30000 });
  await page.waitForTimeout(2000);
  await page.evaluate(() => window.voidPlayer.pause());

  // 窄屏下面板保持单行横滚，不撑出横向滚动条、不挤塌视频。
  await page.setViewportSize({ width: 600, height: 800 });
  for (const id of ['toggle-inspector', 'toggle-sources', 'toggle-subtracks']) {
    if (await page.locator(`#${id}`).getAttribute('aria-expanded') !== 'true') await page.locator(`#${id}`).click();
  }
  await page.waitForTimeout(800);
  const narrow = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth > innerWidth,
    headH: document.querySelector('.analysis-head').getBoundingClientRect().height,
    images: [...document.querySelectorAll('.video-card:not([hidden]) .image-wrap')].map(el => [el.offsetWidth, el.offsetHeight]),
  }));
  assert.equal(narrow.overflow, false);
  assert.ok(narrow.headH < 80, `headH=${narrow.headH}`);
  assert.ok(narrow.images.every(([w, h]) => w > 0 && h > 0));
  await page.setViewportSize({ width: 1280, height: 800 });

  // 移除最后一条轨道 → 面板直接缩起，开关禁用（与子轨道面板同契约）。
  await page.evaluate(async () => {
    const remove = window.voidPlayer.tools.find(t => t.name === 'remove_review_track');
    await remove.execute({ slot: 'A' });
    await remove.execute({ slot: 'B' });
  });
  await page.waitForFunction(() => document.getElementById('analysis-panel').hidden, undefined, { timeout: 15000 });
  assert.equal(await page.locator('#toggle-analysis').getAttribute('aria-expanded'), 'false');
  assert.equal(await page.locator('#toggle-analysis').isDisabled(), true);

  // 分享工作区包含分析面板状态：导出 → 改动 → 导入 → 还原。
  await page.evaluate(async ids => {
    const tools = window.voidPlayer.tools;
    const load = tools.find(t => t.name === 'load_library_item');
    await load.execute({ id: ids['ci_h264_smoke.mp4'], slot: 'A' });
    await load.execute({ id: ids['h264_9s_1920x1080.mp4'], slot: 'B' });
  }, ids);
  await page.waitForFunction(() => !document.getElementById('toggle-analysis').disabled, undefined, { timeout: 30000 });
  await page.locator('#toggle-analysis').click();
  await page.waitForFunction(() => !document.getElementById('analysis-panel').hidden);
  await page.waitForFunction(() => {
    const r1 = document.getElementById('analysis-canvas').getBoundingClientRect();
    return r1.y > 0 && r1.height > 0;
  }, undefined, { timeout: 15000 });
  await page.waitForTimeout(500);
  // 先悬停一次让检查快照（含 glyph）发布，再框选。
  const box2 = await page.locator('#analysis-canvas').boundingBox();
  await page.mouse.move(box2.x + box2.width * 0.4, box2.y + box2.height * 0.5);
  await page.waitForFunction(() => window.__vpAnalysis?.glyphs?.length > 0, undefined, { timeout: 60000 });
  // 框选定一个区间并关掉帧大小行，形成非默认快照。
  await page.mouse.move(box2.x + box2.width * 0.3, box2.y + box2.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box2.x + box2.width * 0.55, box2.y + box2.height * 0.5, { steps: 8 });
  await page.mouse.up();
  await page.waitForFunction(() => document.querySelector('[data-seg="follow"]').textContent === '跟随：关', undefined, { timeout: 15000 });
  await page.locator('[data-seg="size"]').click();
  const exported = await page.evaluate(async () => {
    const t = window.voidPlayer.tools.find(t => t.name === 'export_workspace');
    return await t.execute({});
  });
  assert.ok(exported.layout.analysisView, '导出应含分析面板状态');
  assert.ok(exported.layout.analysisView.view, '应记录放大的区间');
  assert.equal(exported.layout.analysisView.showSize, false);
  const savedView = exported.layout.analysisView.view;
  // 改动面板后再导入：视图与开关状态应还原。
  await page.locator('#analysis-canvas').dblclick();
  await page.locator('[data-seg="size"]').click();
  await page.evaluate(async (doc) => {
    await window.voidPlayer.tools.find(t => t.name === 'import_workspace').execute({ document: doc });
  }, exported);
  await page.waitForFunction(() => !document.getElementById('analysis-panel').hidden, undefined, { timeout: 60000 });
  const box3 = await page.locator('#analysis-canvas').boundingBox();
  await page.mouse.move(box3.x + box3.width * 0.4, box3.y + box3.height * 0.5);
  await page.waitForFunction(() => window.__vpAnalysis?.inspection, undefined, { timeout: 60000 });
  const restoredView = await page.evaluate(() => window.__vpAnalysis.view);
  assert.deepEqual(restoredView, savedView, '导入后分析视图区间应还原');
  assert.equal(await page.locator('[data-seg="size"]').getAttribute('aria-pressed'), 'false', '导入后帧大小开关应还原');

  assert.deepEqual(errors, []);
  await page.screenshot({ path: join(temp, 'analysis-panel.png') });
  await browser.close(); browser = undefined;
  console.log('PASS analysis panel: capabilities, merged layout, read-only hover, click seek, zoom, playback coexistence');
} finally {
  await browser?.close(); server?.close();
  await rm(temp, { recursive: true, force: true });
}
