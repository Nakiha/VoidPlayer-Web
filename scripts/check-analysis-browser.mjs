// 顶部码流分析面板回归：只读查询口径、双轨配对、悬停/定位、DTS 切换、
// 播放共存。Usage: npm run test:analysis:browser -- [webkit|chromium]
// 诊断与临时输入分离：截图/状态写入 .run/analysis-reports/<engine>/（CI 上传），
// 临时目录仅放可删除的中间文件；失败时尽力保留现场后重抛。
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import path from 'node:path';
import { chromium, webkit } from 'playwright';
import { createMediaServer } from '../server/app.ts';

const engineName = process.argv[2] ?? 'webkit';
assert.ok(['webkit', 'chromium'].includes(engineName), 'Expected webkit or chromium');
const root = path.resolve(import.meta.dirname, '..');
// B4：诊断目录固定、可上传；与临时输入分离，finally 不得删除。
const reportDir = join(root, '.run', 'analysis-reports', engineName);
await mkdir(reportDir, { recursive: true });
const temp = await mkdtemp(join(tmpdir(), 'vp-analysis-'));
let browser, server, page;
// 失败现场暂存：catch/finally 中尽力落盘，保留原始异常。
let failure = null;
async function saveDiagnostics(activePage, name, extra = {}) {
  try {
    if (activePage) {
      await activePage.screenshot({ path: join(reportDir, `${name}.png`) }).catch(() => {});
    }
    let state = null;
    if (activePage) {
      try {
        state = await activePage.evaluate(() => ({
          url: location.href,
          view: window.__vpAnalysis?.view ?? null,
          inspection: window.__vpAnalysis?.inspection ?? null,
          float: window.__vpAnalysis?.float ?? null,
          glyphs: window.__vpAnalysis?.glyphs?.length ?? null,
          queries: document.getElementById('analysis-canvas')?.dataset?.analysisQueries ?? null,
        }));
      } catch (error) { state = { collectError: String(error) }; }
    }
    await writeFile(
      join(reportDir, `${name}.json`),
      JSON.stringify({ engine: engineName, name, time: new Date().toISOString(), state, ...extra }, null, 2),
    ).catch(() => {});
  } catch { /* 诊断落盘本身不得掩盖原始失败 */ }
}
try {
  server = createMediaServer({
    roots: [join(root, 'fixtures/video')], staticDir: join(root, 'dist'), onLog() {},
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  browser = await (engineName === 'webkit' ? webkit : chromium).launch({ headless: true });
  page = await browser.newPage({locale:'zh-CN',  viewport: { width: 1280, height: 800 } });
  // 测试快照钩子只在 QA 显式启用时构建，生产 hover 不为测试付费。
  await page.addInitScript(() => { window.__vpAnalysisQA = true; });
  page.setDefaultTimeout(30000);
  const errors = [];
  const decoderNotices = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() !== 'error') return;
    const text = message.text();
    // FFmpeg writes this AV1 size-limit notice to stderr; preserve it as
    // evidence while still rejecting every actual error and unexpected line.
    if (/^\[libdav1d @ 0x[0-9a-f]+\] Frame size limit reduced from 2147483647 to 67108864\.$/.test(text)) decoderNotices.push(text);
    else errors.push(text);
  });
  const panelRequests = [];
  page.on('request', request => { if (/\/analysis-panel-[^/]+\.js/.test(request.url())) panelRequests.push(request.url()); });
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

  assert.equal(panelRequests.length, 0, 'closed analysis panel does not load its optional implementation');
  // Exercise the actual bundled metadata worker even when these containers use
  // the shared MP4/FFmpeg packet path instead of Mediabunny's fallback adapter.
  const workerAsset = (await readdir(join(root, 'dist/assets'))).find(name => /^native-worker-.*\.js$/.test(name));
  assert.ok(workerAsset, 'native metadata worker is bundled');
  const workerResult = await page.evaluate(async url => {
    const worker = new Worker(url, { type: 'module' });
    try {
      const call = (id, type, input, transfer = []) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => { cleanup(); reject(new Error('metadata Worker timed out')); }, 10000);
        const receive = event => { if (event.data.id === id && !event.data.event) { cleanup(); event.data.ok ? resolve(event.data.data) : reject(new Error(event.data.error)); } };
        const error = event => { cleanup(); reject(new Error(event.message)); };
        const cleanup = () => { clearTimeout(timer); worker.removeEventListener('message', receive); worker.removeEventListener('error', error); };
        worker.addEventListener('message', receive); worker.addEventListener('error', error); worker.postMessage({ id, type, input }, transfer);
      });
      const records = new Float64Array([80000,300,0,0,100,1,40000,200,0]);
      const count = await call(1, 'append', { records }, [records.buffer]);
      const rank = await call(2, 'rank', { firstPtsUs: 0, axis: 'pts', tUs: 40000 });
      const sample = await call(3, 'locate', { mediaId: 'native', firstPtsUs: 0, sampleId: 'native:v:0' });
      return { count, detached: records.byteLength === 0, rank, sample };
    } finally { worker.terminate(); }
  }, base + '/assets/' + workerAsset);
  assert.equal(workerResult.count, 3); assert.equal(workerResult.detached, true);
  assert.deepEqual(workerResult.rank, { rank: 1, total: 3, ordinal: 2 });
  assert.equal(workerResult.sample.effectivePtsUs, 80000);


  // 经由 Agent 同一入口载入两轨（与 UI 共用会话行为）。
  const ids = await page.evaluate(async () => {
    const tools = window.voidPlayer.tools;
    const list = tools.find(t => t.name === 'list_library');
    const found = {};
    for (const name of ['ci_h264_smoke.mp4', 'h264_9s_1920x1080.mp4', 'av1_10s_1920x1080.webm', 'mpeg2_10s_1280x720.ts', 'ffv1_yuv422p_8bit.mkv']) {
      const page1 = await list.execute({ search: name, limit: 10 });
      const entry = (page1.entries ?? []).find(e => e.name === name);
      found[name] = entry?.id;
    }
    return found;
  });
  assert.ok(ids['ci_h264_smoke.mp4'], 'Missing fixture: ci_h264_smoke.mp4');
  assert.ok(ids['h264_9s_1920x1080.mp4'], 'Missing fixture: h264_9s_1920x1080.mp4');
  assert.ok(ids['av1_10s_1920x1080.webm'], 'Missing fixture: av1_10s_1920x1080.webm');
  // Container playback and analysis share the exact same cached packet index.
  for (const name of ['av1_10s_1920x1080.webm', 'mpeg2_10s_1280x720.ts', 'ffv1_yuv422p_8bit.mkv']) {
    assert.ok(ids[name], `Missing fixture: ${name}`);
    let baseline;
    for (const mode of ['cold', 'warm', 'local']) {
    if (mode === 'local') {
      await page.locator('#file-A').setInputFiles(join(root, 'fixtures/video', name));
      await page.waitForTimeout(300);
    } else {
      await page.evaluate(async id => {
        await window.voidPlayer.tools.find(t => t.name === 'load_library_item').execute({ id, slot: 'A' });
      }, ids[name]);
    }
    if (await page.locator('#toggle-analysis').getAttribute('aria-expanded') === 'false') await page.locator('#toggle-analysis').click();
    await page.waitForFunction(() => document.querySelector('#analysis-canvas')?.dataset.analysisQueries != null);
    assert.equal(panelRequests.length, 1, 'analysis implementation is loaded once on first open');
    const packets = await page.evaluate(async () => {
      const deadline = performance.now() + 30000;
      while (performance.now() < deadline) {
        const r = await window.voidPlayer.tools.find(t => t.name === 'query_analysis').execute({ slot: 'A', axis: 'pts', startUs: 0, endUs: 20_000_000, pixelWidth: 2000 });
        if (r.capability.indexState === 'complete' && r.samples.length) return r;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error('shared packet index did not complete');
    });
    assert.ok(packets.samples.length > 0, `compressed packet samples are available: ${JSON.stringify({name, cap:packets.capability, sampleCount:packets.samples.length, buckets:packets.buckets?.length, revision:packets.indexRevision,version:packets.sourceVersion, range:packets.coverageUs,truncated:packets.truncated})}`);
    assert.ok(packets.samples.every(p => p.sizeBytes >= 0 && p.decodeOrdinal >= 0));
    assert.equal(await page.locator('.analysis-empty').isVisible(), false);
    assert.equal(await page.locator('.analysis-notice').isVisible(), false);
    const identity = packets.samples.map(p => [p.decodeOrdinal, p.containerPtsUs, p.dtsUs, p.sizeBytes]);
    if (baseline) assert.deepEqual(identity, baseline, 'warm cache and local files reuse the same packet semantics');
    else baseline = identity;
    await saveDiagnostics(page, `shared-index-${mode}-${name}`);
    }
  }
  // Smooth wheel zoom with the exact mixed-container pair from the reported issue.
  await page.evaluate(async ids => {
    const load = window.voidPlayer.tools.find(t => t.name === 'load_library_item');
    await load.execute({ id: ids['mpeg2_10s_1280x720.ts'], slot: 'A' });
    await load.execute({ id: ids['av1_10s_1920x1080.webm'], slot: 'B' });
  }, ids);
  await page.evaluate(async () => {
    const q = window.voidPlayer.tools.find(t => t.name === 'query_analysis'), deadline = performance.now() + 30000;
    while (performance.now() < deadline) {
      const results = await Promise.all(['A', 'B'].map(slot => q.execute({ slot, startUs: 0, endUs: 10_000_000, pixelWidth: 2000 })));
      if (results.every(r => r.capability.indexState === 'complete' && r.samples.length)) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('mixed-format indexes did not complete');
  });
  await page.locator('[data-seg="full"]').click();
  const smoothWidths = [];
  for (let step = 0; step < 40; step++) {
    await page.evaluate(delta => {
      const canvas = document.getElementById('analysis-canvas'), rect = canvas.getBoundingClientRect();
      canvas.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: delta,
        clientX: rect.x + rect.width * 0.3, clientY: rect.y + rect.height * 0.7, bubbles: true, cancelable: true }));
    }, step === 0 ? -400 : -8);
    await page.waitForTimeout(80);
    const snapshot = await page.evaluate(() => {
      const glyphs = window.__vpAnalysis?.glyphs ?? [];
      const widths = glyphs.filter(g => !g.stacked && g.width > 0).map(g => g.width).sort((a,b) => a-b);
      return { width: widths[Math.floor(widths.length / 2)] ?? null, raw: glyphs.some(g => g.kind === 'sample') };
    });
    if (snapshot.width != null) smoothWidths.push(snapshot);
  }
  assert.ok(smoothWidths.length > 30 && smoothWidths.some(s => s.raw), 'mixed-format zoom produces single-frame bars');
  for (let i = 1; i < smoothWidths.length; i++) assert.ok(Math.abs(smoothWidths[i].width - smoothWidths[i - 1].width) < 0.5,
    `smooth zoom width jumped: ${JSON.stringify(smoothWidths)}`);
  await saveDiagnostics(page, 'smooth-width', { smoothWidths });
  await page.locator('[data-seg="full"]').click();
  await page.evaluate(async () => {
    const remove = window.voidPlayer.tools.find(t => t.name === 'remove_review_track');
    await remove.execute({ slot: 'A' }); await remove.execute({ slot: 'B' });
  });
  await page.waitForFunction(() => document.getElementById('analysis-panel').hidden);
  await page.evaluate(async ids => {
    const tools = window.voidPlayer.tools;
    const load = tools.find(t => t.name === 'load_library_item');
    await load.execute({ id: ids['ci_h264_smoke.mp4'], slot: 'A' });
    await load.execute({ id: ids['h264_9s_1920x1080.mp4'], slot: 'B' });
  }, ids);
  // Inject a query-only RPC failure; playback and the real index remain healthy.
  await page.evaluate(() => {
    window.analysisOriginalPost = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function(message, ...args) {
      if (message.type === 'analysis') {
        queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: { id: message.id, ok: false, error: 'analysis regression failure' } })));
        return;
      }
      return window.analysisOriginalPost.call(this, message, ...args);
    };
  });
  // 有轨道后开关可用，展开面板，并等打开动画落定再量坐标。
  await page.waitForFunction(() => !document.getElementById('toggle-analysis').disabled, undefined, { timeout: 30000 });
  await page.locator('#toggle-analysis').click();
  await page.waitForFunction(() => document.querySelector('.analysis-empty')?.textContent.includes('analysis regression failure'));
  assert.equal(await page.locator('.analysis-empty').isVisible(), true, 'query failure must be visible, not only announced to screen readers');
  assert.match(await page.locator('.analysis-empty').textContent(), /轨道 A 查询失败/);
  assert.doesNotMatch(await page.locator('.analysis-empty').textContent(), /正在查询统计/);
  await page.waitForTimeout(350); // Capture the settled panel, not its opening animation.
  await saveDiagnostics(page, 'query-failure');
  await page.evaluate(() => { Worker.prototype.postMessage = window.analysisOriginalPost; delete window.analysisOriginalPost; });
  await page.locator('#toggle-analysis').click();
  await page.waitForFunction(() => document.getElementById('analysis-panel').hidden);
  await page.locator('#toggle-analysis').click();
  await page.waitForFunction(() => !document.getElementById('analysis-canvas').hidden);
  await page.waitForFunction(() => document.querySelector('.analysis-notice').hidden);
  assert.equal(await page.locator('.analysis-empty').isVisible(), false, 'successful retry clears the failed empty state');
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

  // Direct page/Agent calls cannot rely on a WebMCP host to validate the schema.
  const toolContract = await page.evaluate(async () => {
    const tools = window.voidPlayer.tools;
    const query = tools.find(tool => tool.name === 'query_analysis');
    const state = tools.find(tool => tool.name === 'get_review_session');
    const logs = tools.find(tool => tool.name === 'get_review_logs');
    const custom = await query.execute({ slot: 'A', axis: 'dts', startUs: -1, endUs: 1000000, pixelWidth: 32, bitrateWindowUs: 123 });
    const defaults = await query.execute({ slot: 'A', startUs: 0, endUs: 1000000 });
    const before = JSON.stringify(state.execute({})), logSeq = (await logs.execute({ limit: 1 })).lastSeq;
    const invalid = [{ axis: 'other' }, { pixelWidth: 31 }, { pixelWidth: 4097 },
      { bitrateWindowUs: 0 }, { bitrateWindowUs: 1.5 }, { bitrateWindowUs: '123' }, { extra: true }];
    const rejected = invalid.map(extra => {
      try { query.execute({ slot: 'A', startUs: 0, endUs: 1, ...extra }); return false; }
      catch (error) { return /工具参数约定/.test(error.message); }
    });
    return { schema: query.inputSchema.properties.bitrateWindowUs, customAxis: custom.axis, defaultAxis: defaults.axis,
      rejected, unchanged: before === JSON.stringify(state.execute({})), quiet: logSeq === (await logs.execute({ limit: 1 })).lastSeq };
  });
  assert.deepEqual(toolContract.schema, { type: 'integer', minimum: 1 });
  assert.equal(toolContract.customAxis, 'dts'); assert.equal(toolContract.defaultAxis, 'pts');
  assert.ok(toolContract.rejected.every(Boolean), 'Invalid direct tool calls must fail at the tool boundary');
  assert.ok(toolContract.unchanged, 'Invalid queries must retain the review state');
  assert.ok(toolContract.quiet, 'Read-only queries must not manufacture log events');
  await saveDiagnostics(page, 'agent-tool-contract', { toolContract });

  const frameNumber = page.locator('#analysis-status-items .st-item').filter({ has: page.locator('.st-slot', { hasText: 'B' }) }).locator('.st-num');
  await frameNumber.waitFor();
  await page.waitForFunction(() => {
    const item = [...document.querySelectorAll('#analysis-status-items .st-item')].find(el => el.querySelector('.st-slot')?.textContent === 'B');
    return item?.querySelector('.st-num:not(:disabled)');
  });
  await page.setViewportSize({ width: 825, height: 800 });
  const statusBefore = await frameNumber.evaluate(button => ({
    number: button.getBoundingClientRect().width,
    item: button.closest('.st-item').getBoundingClientRect().width,
    header: document.querySelector('.analysis-head').getBoundingClientRect().height,
  }));
  await frameNumber.click();
  const frameInput = page.getByRole('textbox', { name: '轨道 B PTS序帧号' });
  const statusEditing = await frameInput.evaluate(input => ({
    number: input.getBoundingClientRect().width,
    item: input.closest('.st-item').getBoundingClientRect().width,
    header: document.querySelector('.analysis-head').getBoundingClientRect().height,
  }));
  assert.ok(Math.abs(statusBefore.number - statusEditing.number) < 1, 'frame number keeps its width while editing');
  assert.ok(Math.abs(statusBefore.item - statusEditing.item) < 1, 'status item does not push the toolbar while editing');
  assert.ok(Math.abs(statusBefore.header - statusEditing.header) < 1, 'editing does not change header height');
  await frameInput.fill('12'); await frameInput.press('Enter');
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForFunction(() => {
    const item = [...document.querySelectorAll('#analysis-status-items .st-item')].find(el => el.querySelector('.st-slot')?.textContent === 'B');
    return item?.querySelector('.st-num')?.textContent === '#12';
  });

  // Agent 查询口径：压缩字节总数与文件大小一致（1752B 级小文件除外，按总和校验大文件）。
  const stats = await page.evaluate(async () => {
    const q = window.voidPlayer.tools.find(t => t.name === 'query_analysis');
    const r = await q.execute({ slot: 'B', startUs: 0, endUs: 10000000, pixelWidth: 600, bitrateWindowUs: 1000000 });
    const sizes = r.samples.map(s => s.sizeBytes);
    return {
      samples: r.samples.length, truncated: r.truncated,
      hasDts: r.capability.hasDts,
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
  assert.equal(stats.hasDts, true, 'packet MP4 exposes its sample-table DTS');
  assert.equal(stats.dts, 0, 'packet MP4 DTS values must be present, not synthesized as null');

  // DTS 查询使用同一份 MP4 sample-table index，且返回实际解码时间。
  const dtsQuery = await page.evaluate(async () => {
    const q = window.voidPlayer.tools.find(t => t.name === 'query_analysis');
    return q.execute({ slot: 'B', startUs: 0, endUs: 1000000, axis: 'dts', pixelWidth: 100, bitrateWindowUs: 1000000 });
  });
  assert.equal(dtsQuery.capability.hasDts, true);
  assert.ok(dtsQuery.samples.length > 0, 'DTS query returns samples');
  assert.ok(dtsQuery.samples.every(sample => Number.isFinite(sample.dtsUs)), 'DTS query returns finite decode times');

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

  // 缩窄绘图区使全览低于 1px 柱 + 间隔容量，验证聚合桶仍按峰值定位。
  await page.locator('[data-seg="full"]').click();
  await page.setViewportSize({ width: 640, height: 800 });
  await page.waitForFunction(() => window.__vpAnalysis?.glyphs.some(g => g.kind === 'bucket'));
  const bucketBox = await page.locator('#analysis-canvas').boundingBox();
  const bucket = await page.evaluate(() => {
    const bs = window.__vpAnalysis.glyphs.filter(g => g.kind === 'bucket');
    return bs[Math.floor(bs.length / 2)];
  });
  assert.ok(bucket, '全览应有区间桶 glyph');
  const viewB0 = await page.evaluate(() => window.__vpAnalysis.view);
  await page.mouse.click(bucketBox.x + bucket.cx, bucketBox.y + bucket.cy);
  await page.waitForFunction(pos => document.getElementById('position').value !== pos, posBefore, { timeout: 8000 });
  const viewB1 = await page.evaluate(() => window.__vpAnalysis.view);
  assert.deepEqual(viewB1, viewB0, '桶点击只定位，不缩放视图');
  posBefore = await page.locator('#position').inputValue();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForTimeout(300);

  // 框选放大后跟随关闭（区间桶按峰值样本定位，放大只走框选/滚轮）。
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.5, { steps: 8 });
  await page.mouse.up();
  await page.waitForFunction(() => document.querySelector('[data-seg="follow"]').textContent === '跟随：关', undefined, { timeout: 15000 });

  // 放大到逐样本后，单击指定 B 柱：必须命中 B 的 sampleId 与可信展示 PTS。
  // 固定夹具、固定目标、固定操作；失败保留现场并直接断言，不换目标重试。
  let hasSample = false;
  for (let attempt = 0; attempt < 6 && !hasSample; attempt++) {
    hasSample = await page.evaluate(() => window.__vpAnalysis?.glyphs?.some(g => g.kind === 'sample') ?? false);
    if (hasSample) break;
    await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.7);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.7, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(1500);
  }
  assert.ok(hasSample, '连续放大后应出现逐样本 glyph');
  const clicked = await page.evaluate(() => window.__vpAnalysis.glyphs.find(g => g.kind === 'sample' && g.slot === 'B' && !g.stacked));
  assert.ok(clicked, '应有 B 逐样本 glyph');
  const viewBefore = await page.evaluate(() => window.__vpAnalysis.view);
  await page.mouse.click(box.x + clicked.cx, box.y + clicked.cy);
  try {
    await page.waitForFunction(pos => document.getElementById('position').value !== pos, posBefore, { timeout: 8000 });
  } catch {
    // 失败保留现场：目标 glyph、检查快照与视图一起带出，不改测试快照换目标。
    const scene = await page.evaluate(() => ({ inspection: window.__vpAnalysis.inspection, view: window.__vpAnalysis.view }));
    assert.fail(`指定 B 柱未定位：${JSON.stringify({ clicked, scene })}`);
  }
  // 单击单帧只定位，不缩放视图。
  const viewAfter = await page.evaluate(() => window.__vpAnalysis.view);
  assert.deepEqual(viewAfter, viewBefore, '单击不得改变视图范围');
  assert.equal(clicked.slot, 'B');
  // 直接命中一致性：表格、高亮、点击须为同一 sampleId，不得表里一个、定位另一个。
  const hitState = await page.evaluate(() => window.__vpAnalysis.inspection);
  assert.equal(hitState.direct?.kind, 'sample');
  assert.equal(hitState.direct?.sampleId, clicked.id);
  assert.equal(hitState.tracks.find(t => t.slot === 'B')?.refId, clicked.id);
  assert.equal(hitState.t, clicked.axisUs);
  // 点击样本柱按该样本的展示 PTS 精确定位（整数微秒），不用宽松容差。
  const statePos = await page.evaluate(() => window.voidPlayer.getState().positionUs);
  assert.equal(statePos, clicked.axisUs, `position=${statePos} axis=${clicked.axisUs}`);

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
  await page.waitForFunction(() => !document.getElementById('analysis-canvas').hidden, undefined, { timeout: 60000 }).catch(async () => {
    console.error('DIAG', JSON.stringify(await page.evaluate(async () => {
      const q = window.voidPlayer.tools.find(t => t.name === 'query_analysis');
      let probe = null;
      try {
        const r = await q.execute({ slot: 'A', startUs: 2739047, endUs: 5332229, axis: 'pts', pixelWidth: 100, bitrateWindowUs: 1000000 });
        probe = { sourceVersion: r.sourceVersion ?? null, keys: Object.keys(r).slice(0, 8) };
      } catch (e) { probe = { error: String(e) }; }
      return {
        queries: document.getElementById('analysis-canvas').dataset.analysisQueries ?? null,
        live: document.querySelector('#analysis-panel output')?.textContent ?? null,
        vp: window.__vpAnalysis ? { glyphs: window.__vpAnalysis.glyphs?.length ?? null } : null,
        tracks: window.voidPlayer.getState().tracks.map(t => ({ slot: t.slot, id: t.id, gen: t.sourceGen })),
        probe,
      };
    })));
    console.error('DIAG_ERRORS', JSON.stringify(errors));
    throw new Error('分析画布在导入后 60s 内未显示');
  });
  const box3 = await page.locator('#analysis-canvas').boundingBox();
  await page.mouse.move(box3.x + box3.width * 0.4, box3.y + box3.height * 0.5);
  await page.waitForFunction(() => window.__vpAnalysis?.inspection, undefined, { timeout: 60000 });
  const restoredView = await page.evaluate(() => window.__vpAnalysis.view);
  assert.deepEqual(restoredView, savedView, '导入后分析视图区间应还原');
  assert.equal(await page.locator('[data-seg="size"]').getAttribute('aria-pressed'), 'false', '导入后帧大小开关应还原');

  assert.deepEqual(errors, []);
  // 成功截图写入固定诊断目录（CI 按目录上传），同时校验落盘存在。
  await page.screenshot({ path: join(reportDir, 'analysis-panel.png') });
  const successState = await page.evaluate(() => ({
    view: window.__vpAnalysis?.view ?? null,
    inspection: window.__vpAnalysis?.inspection ?? null,
    glyphs: window.__vpAnalysis?.glyphs?.length ?? null,
  }));
  await writeFile(
    join(reportDir, 'analysis-panel.json'),
    JSON.stringify({ engine: engineName, time: new Date().toISOString(), state: successState, errors, decoderNotices }, null, 2),
  );
  await browser.close(); browser = undefined;
  console.log('PASS analysis panel: capabilities, merged layout, read-only hover, click seek, zoom, playback coexistence');
} catch (error) {
  failure = error;
  // 失败保留现场：截图 + 检查状态/视图/错误 + 原始异常信息；诊断失败不掩盖原错。
  await saveDiagnostics(page, 'failure', {
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  throw failure;
} finally {
  await browser?.close().catch(() => {}); server?.close();
  // 只删临时输入，诊断目录保留供 CI 上传与本地排查。
  await rm(temp, { recursive: true, force: true }).catch(() => {});
}
