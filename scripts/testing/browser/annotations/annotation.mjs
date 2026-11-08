import assert from 'node:assert/strict';
import { withBrowserFixture } from '../../browser-fixture.mjs';
const name = process.argv[2] ?? 'webkit';
await withBrowserFixture({ caseName: 'annotation', engine: name, pageOptions: {"viewport": {"width": 1280, "height": 900}} }, async ({ page, ready }) => {

  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await ready();
  
  await page.evaluate(async () => {
    const tool = n => window.voidPlayer.tools.find(t => t.name === n);
    const lib = await tool('list_library').execute({});
    await tool('load_library_item').execute({ id: lib.entries.find(e => e.name === 'ci_h264_smoke.mp4').id, slot: 'A' });
  });
  await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); }); await page.keyboard.press('n');
  const box = await page.locator('#drawing-A').boundingBox();
  const point = (x, y) => [box.x + box.width * x, box.y + box.height * y];
  async function drag(a, b) { await page.mouse.move(...point(...a)); await page.mouse.down(); await page.mouse.move(...point(...b), { steps: 12 }); await page.mouse.up(); }
  const state = () => page.evaluate(() => window.voidPlayer.tools.find(t => t.name === 'get_review_session').execute({}));
  await page.locator('[data-drawing-tool=rect]').click(); await drag([.15,.15],[.35,.35]);
  assert.equal((await state()).marks.length, 1, 'drawing is saved without a save button');
  await page.locator('#drawing-undo').click(); assert.equal((await state()).marks.length, 0, 'undo first stroke removes its saved mark');
  await page.locator('#drawing-redo').click(); assert.equal((await state()).marks.length, 1);
  const markId = (await state()).marks[0].id;
  await page.locator('#mark-close').click();
  await page.locator('#annotations-A .annotation-hit').waitFor({ state: 'visible' });
  await page.mouse.click(...point(.25,.25));
  await page.locator('#annotation-toolbar').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#drawing-delete').isEnabled(), true, 'single click on a saved annotation opens and selects it');
  assert.equal(await page.locator('#drawing-A .annotation-selection').count(), 1, 'clicked annotation has selection handles');
  // Drawing-mode taps select; intentional drags still create nested shapes.
  const original = structuredClone((await state()).marks[0].drawings[0]);
  const cursorAt = (x,y) => page.evaluate(([x,y]) => getComputedStyle(document.elementFromPoint(x,y)).cursor, point(x,y));
  for (const tool of ['rect','ellipse','line','pen']) {
    await page.locator(`[data-drawing-tool=${tool}]`).click();
    assert.equal(await cursorAt(.25,.25),'crosshair',`${tool} interior cursor describes drawing`);
    assert.equal(await cursorAt(.15,.22),'crosshair',`${tool} edge cursor describes drawing`);
    await page.mouse.move(...point(.25,.25));await page.mouse.down();
    assert.equal(await page.locator('#drawing-A .annotation-object').count(),1,'pointer down does not flash a new shape');
    await page.mouse.move(...point(.25,.25).map(v=>v+1));await page.mouse.up();
    assert.equal(await page.locator('[data-drawing-tool=select]').getAttribute('aria-pressed'),'true','precise click switches to selection');
    assert.equal(await cursorAt(.25,.25),'move');
    assert.deepEqual((await state()).marks[0].drawings,[original],'selection does not mutate or duplicate annotations');
  }
  await page.locator('[data-drawing-tool=rect]').click();
  await drag([.2,.2],[.3,.3]);
  assert.equal((await state()).marks[0].drawings.length,2,'drag from an existing interior creates a nested rectangle');
  assert.equal(await page.locator('[data-drawing-tool=rect]').getAttribute('aria-pressed'),'true');
  await page.locator('#drawing-undo').click();
  await page.mouse.click(...point(.25,.25));
  assert.equal(await page.locator('[data-drawing-tool=select]').getAttribute('aria-pressed'),'true');

  await page.locator('[data-drawing-tool=select]').click(); await drag([.23,.23],[.33,.33]);
  let shape = (await state()).marks[0].drawings[0]; assert.ok(shape.points[0].x > .23, 'object moved');
  await page.locator('#drawing-A [data-corner=se]').waitFor({ state: 'visible' });
  const corner = await page.locator('#drawing-A [data-corner=se]').evaluate(e => e.getBoundingClientRect().toJSON());
  await page.mouse.move(corner.x + corner.width / 2, corner.y + corner.height / 2); await page.mouse.down(); await page.mouse.move(...point(.55,.55)); await page.mouse.up();
  shape = (await state()).marks[0].drawings[0]; assert.ok(shape.points[1].x > .5, 'object resized');
  const beforeWidth = shape.strokeWidth;
  await page.locator('#drawing-width-choice').click();
  await page.getByRole('menuitemradio', {name:'细 · 2 px', exact:true}).click();
  assert.ok((await state()).marks[0].drawings[0].strokeWidth < beforeWidth, 'style menu edits selected object');
  await page.locator('#drawing-undo').click();
  await page.locator('[data-drawing-tool=text]').click(); await page.mouse.click(...point(.58,.2));
  const input = page.getByRole('textbox', { name: '画面文字' }); await input.fill('直接编辑\n第二行');
  assert.equal(await page.locator('#drawing-A .annotation-selection').count(), 1, 'text resize handles stay visible during editing');
  assert.equal(await input.evaluate(e => getComputedStyle(e).cursor), 'text', 'live text editing uses the text cursor');
  assert.equal(await input.evaluate(e => getComputedStyle(e).backgroundColor), 'rgba(0, 0, 0, 0)');
  const fontBefore = (await state()).marks.flatMap(m => m.drawings).find(d => d.tool === 'text').fontSize;
  const textCorner = await page.locator('#drawing-A [data-corner=se]').evaluate(e => e.getBoundingClientRect().toJSON());
  await page.mouse.move(textCorner.x + textCorner.width / 2, textCorner.y + textCorner.height / 2);
  await page.mouse.down(); await page.mouse.move(textCorner.x + textCorner.width / 2 + 35, textCorner.y + textCorner.height / 2 + 20); await page.mouse.up();
  assert.equal(await page.getByRole('textbox', { name: '画面文字' }).count(), 1, 'text editing resumes after dragging its handle');
  assert.ok((await state()).marks.flatMap(m => m.drawings).find(d => d.tool === 'text').fontSize > fontBefore, 'dragging during text entry changes font size');
  const textCount = (await state()).marks.flatMap(m => m.drawings).filter(d => d.tool === 'text').length;
  await page.mouse.click(...point(.9,.8));
  assert.equal(await page.getByRole('textbox', { name: '画面文字' }).count(), 0, 'outside click finishes text editing');
  assert.equal((await state()).marks.flatMap(m => m.drawings).filter(d => d.tool === 'text').length, textCount, 'outside click does not create another text');
  await page.locator('[data-drawing-tool=rect]').click();
  const textShape = page.locator('#drawing-A foreignObject .annotation-text'); await textShape.dblclick();
  await page.getByRole('textbox', { name: '画面文字' }).fill('改过的文字');
  await page.locator('[data-drawing-tool=pen]').click(); await drag([.15,.65],[.65,.65]);
  await page.locator('[data-drawing-tool=eraser]').click(); await drag([.4,.6],[.4,.7]);
  const erased = (await state()).marks.flatMap(m => m.drawings).filter(d => d.tool === 'pen');
  assert.equal(erased.length, 2, 'eraser splits a stroke instead of painting video pixels');
  await page.locator('#drawing-undo').click(); assert.equal((await state()).marks.flatMap(m => m.drawings).filter(d => d.tool === 'pen').length, 1);
  await page.locator('#drawing-redo').click(); assert.equal((await state()).marks.flatMap(m => m.drawings).filter(d => d.tool === 'pen').length, 2);
  const toolbar = await page.locator('#annotation-toolbar').boundingBox(), transport = await page.locator('.transport').boundingBox();
  assert.ok(toolbar.y + toolbar.height < transport.y, 'toolbar floats above transport');
  await page.setViewportSize({width:480,height:900});
  await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  const strip=page.locator('.drawing-tools');
  const beforeScroll=await strip.evaluate(e=>({height:e.clientHeight,scroll:e.scrollLeft,max:e.scrollWidth-e.clientWidth}));
  assert.ok(beforeScroll.max>0,'narrow toolbar really overflows');
  const stripBox=await strip.boundingBox();await page.mouse.move(stripBox.x+stripBox.width/2,stripBox.y+stripBox.height/2);
  await page.mouse.wheel(320,0);
  await page.waitForFunction(()=>document.querySelector('.drawing-tools').scrollLeft>0,{},{timeout:3000});
  const scrolled=await strip.evaluate(e=>({height:e.clientHeight,gutter:e.offsetHeight-e.clientHeight,width:getComputedStyle(e).scrollbarWidth,pseudo:getComputedStyle(e,'::-webkit-scrollbar').display}));
  assert.equal(scrolled.height,beforeScroll.height);assert.equal(scrolled.gutter,0);
  assert.ok(scrolled.width==='none' || scrolled.pseudo==='none','scrollbar is hidden while horizontal pan remains usable');
  if(process.env.ANNOTATION_NARROW_SCREENSHOT) await page.screenshot({path:process.env.ANNOTATION_NARROW_SCREENSHOT});
  await page.setViewportSize({width:1280,height:900});
  if (process.env.ANNOTATION_SCREENSHOT) await page.screenshot({ path: process.env.ANNOTATION_SCREENSHOT });
  await page.locator('#mark-close').click();
  assert.equal((await state()).marks[0].id, markId, 'autosave preserves mark identity');
  if (await page.locator('#toggle-subtracks').getAttribute('aria-expanded') !== 'true') await page.locator('#toggle-subtracks').click();
  await page.locator('#toggle-marks').click();
  assert.equal(await page.getByRole('button', { name: '编辑标注' }).count(), 0, 'annotation card no longer shows a redundant edit button');
  await page.locator('#selected-marks .mark-frame-number').first().waitFor();
  assert.match(await page.locator('#selected-marks .mark-frame-number').first().textContent(), /^(· )?#(\d+~?|…)$|^(· )?—$/);
  await page.locator('#selected-marks .mark-entry').first().dblclick();
  await page.locator('#annotation-toolbar').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#drawing-A .annotation-object').count(), 4);
  await page.locator('#drawing-delete').click();
  assert.equal((await state()).marks[0].drawings.length, 3);
  await page.locator('#drawing-undo').click();
  await page.evaluate(async () => {
    const tool = name => window.voidPlayer.tools.find(t => t.name === name);
    const mark = (await tool('get_review_session').execute({})).marks[0];
    mark.drawings[0].color = '#00aaff';
    await tool('update_review_mark').execute({ id: mark.id, drawings: mark.drawings });
  });
  assert.equal(await page.locator('#drawing-A .annotation-object').first().getAttribute('stroke'), '#00aaff', 'Agent update refreshes the active editor');
  await page.locator('#mark-close').click();
  // Compare the actual VideoFrame import against the native-resolution canvas.
  const snapshotStyle=await page.addStyleTag({content:'#stage-A > svg{visibility:hidden!important}'});
  const screenshot=await page.locator('#stage-A .frame-presentation').screenshot();
  const importErrors = await page.evaluate(async bytes => {
    const source = window.voidPlayer.captureFrame('A'), target = document.querySelector('#stage-A .frame-presentation');
    const actual=new OffscreenCanvas(target.width,target.height),actualCtx=actual.getContext('2d'),expected=document.createElement('canvas');
    const bitmap=await createImageBitmap(new Blob([new Uint8Array(bytes)],{type:'image/png'}));actualCtx.drawImage(bitmap,0,0);bitmap.close();
    expected.width = target.width; expected.height = target.height;
    const ctx = expected.getContext('2d'), view = target.getBoundingClientRect(), image = document.querySelector('#image-A').getBoundingClientRect();
    ctx.imageSmoothingEnabled = image.width * devicePixelRatio <= source.width; ctx.imageSmoothingQuality = 'low';
    ctx.drawImage(source, (image.left - view.left) * devicePixelRatio, (image.top - view.top) * devicePixelRatio, image.width * devicePixelRatio, image.height * devicePixelRatio);
    const differences = [];
    for (const u of [.231, .473, .817]) for (const v of [.217, .461, .789]) {
      const x = Math.floor((image.left - view.left + image.width * u) * devicePixelRatio), y = Math.floor((image.top - view.top + image.height * v) * devicePixelRatio);
      const pixel=actualCtx.getImageData(x,y,1,1).data;
      const reference = ctx.getImageData(x, y, 1, 1).data;
      differences.push(Math.max(...pixel.map((c, i) => Math.abs(c - reference[i]))));
    }
    return differences;
  },[...screenshot]);
  await snapshotStyle.evaluate(e=>e.remove());
  assert.ok(importErrors.every(error => error <= 3), `VideoFrame orientation/color mismatch: ${importErrors}`);
  // Sampling pixels are independently exercised in presentation-browser; this
  // interaction test checks the actual composited video against its source above.
  assert.deepEqual(errors, []);
  console.log(`PASS ${process.argv[2] ?? 'webkit'}: click-to-select intent, matching cursors, nested drag, narrow toolbar pan, object edits, WYSIWYG text, eraser, undo/redo, autosave/reopen, actual sampling pixels`);
});
