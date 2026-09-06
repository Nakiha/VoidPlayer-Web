import assert from 'node:assert/strict';
import path from 'node:path';
import { webkit, chromium } from 'playwright';
import { createMediaServer } from '../server/app.ts';
const root = path.resolve(import.meta.dirname, '..');
const server = createMediaServer({ roots: [path.join(root, 'fixtures/video')], staticDir: path.join(root, 'dist'), onLog() {} });
await new Promise(r => server.listen(0, '127.0.0.1', r));
const name = process.argv[2] ?? 'webkit';
const browser = await (name === 'chromium' ? chromium : webkit).launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
  const errors = []; page.on('pageerror', e => errors.push(e.message)); page.on('dialog', d => d.accept());
  await page.addInitScript(()=>localStorage.setItem('voidplayer.annotation.recent-colors','["#123456"]'));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const load = () => page.evaluate(async () => {
    const tool = n => window.voidPlayer.tools.find(t => t.name === n);
    const lib = await tool('list_library').execute({});
    await tool('load_library_item').execute({slot: 'A', id: lib.entries.find(e => e.name === 'ci_h264_smoke.mp4').id});
  });
  const state = () => page.evaluate(() => window.voidPlayer.getState());
  await load();
  assert.equal(await page.locator('#annotate').count(), 0, 'transport has no annotation launcher');
  for (const width of [1280, 600, 480, 360, 280, 240]) {
    await page.setViewportSize({width, height:800});
    await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
    const layout=await page.evaluate(()=>{
      const rect=id=>document.querySelector(id).getBoundingClientRect();
      const bar=rect('.transport');
      const input=document.querySelector('#position');
      const measure=document.createElement('canvas').getContext('2d'); const font=getComputedStyle(input); measure.font=`${font.fontWeight} ${font.fontSize} ${font.fontFamily}`;
      const buttons=['#previous','#play','#next','#fullscreen','#toggle-chrome'].map(id=>{
        const r=rect(id),s=getComputedStyle(document.querySelector(id));return {width:r.width,height:r.height,padding:s.padding};
      });
      const items=['#previous','#play','#next','#position','.duration','#timeline','#fullscreen','#toggle-chrome']
        .map(id=>({id,rect:rect(id)})).filter(item=>item.rect.width>0);
      return {buttons, timeExtra:input.getBoundingClientRect().width ? input.getBoundingClientRect().width-measure.measureText(input.value).width : null, bar:bar.toJSON(), items:items.map(({id,rect:r})=>({id,x:r.x,right:r.right,cy:r.y+r.height/2})),
        rail:rect('#timeline').width, timeFont:getComputedStyle(document.querySelector('#position')).font,
        durationFont:getComputedStyle(document.querySelector('.duration')).font};
    });
    assert.equal(layout.timeFont,layout.durationFont, 'time labels share typography');
    assert.ok(layout.timeExtra===null || (layout.timeExtra>=0 && layout.timeExtra<2),`current time extra width at ${width}px: ${layout.timeExtra}`);
    for (const button of layout.buttons) assert.deepEqual(button,{width:28,height:28,padding:'5px'},'transport buttons share target and padding');
    assert.ok(layout.rail>=36,'seek target stays usable');
    for (const [i,item] of layout.items.entries()) {
      assert.ok(Math.abs(item.cy-(layout.bar.y+layout.bar.height/2))<1,`${width}: ${item.id} is vertically centered`);
      assert.ok(item.x>=layout.bar.x && item.right<=layout.bar.right,`${width}: ${item.id} stays inside bar`);
      if(i) assert.ok(item.x>=layout.items[i-1].right,`${width}: controls do not overlap`);
    }
  }
  await page.setViewportSize({width:1280,height:800});
  await page.locator('#pixel-size').hover(); await page.locator('#control-tooltip').waitFor({state:'visible'});
  async function toggle(id, menuId = `${id}-menu`) {
    const button = page.locator(`#${id}`), menu = page.locator(`#${menuId}`);
    for (let i = 0; i < 2; i++) {
      await button.click(); assert.equal(await menu.evaluate(e => e.matches(':popover-open')), true, `${id} opens`);
      assert.equal(await menu.evaluate(e=>getComputedStyle(e).backdropFilter || getComputedStyle(e).webkitBackdropFilter),'blur(8px)','menu uses bounded light frost');
      assert.equal(await menu.evaluate(e=>getComputedStyle(e).opacity),'1','menu content stays opaque');
      await button.hover();
      // Intentionally exceed the tooltip delay, including pending focus timers.
      await page.waitForTimeout(400);
      assert.equal(await page.locator('#control-tooltip').isVisible(), false, `${id} suppresses tooltip while expanded`);
      await button.click(); assert.equal(await menu.evaluate(e => e.matches(':popover-open')), false, `${id} closes on second click`);
      assert.equal(await button.getAttribute('aria-expanded'), 'false');
    }
    await button.focus(); await button.press('Enter');
    assert.equal(await menu.evaluate(e => e.matches(':popover-open')), true);
    await page.keyboard.press('Escape'); assert.equal(await button.evaluate(e => e === document.activeElement), true);
  }
  for (const id of ['pixel-size', 'zoom-select']) await toggle(id);
  await toggle('more-actions', 'more-actions-menu');
  await page.locator('.brand').click(); await page.keyboard.press('n'); await page.locator('[data-drawing-tool=rect]').click();
  assert.equal(await page.locator('#annotation-toolbar').evaluate(e=>getComputedStyle(e).padding),'4px','compact wrapper preserves button targets');
  await page.mouse.move(280,240); await page.mouse.down(); await page.mouse.move(500,420,{steps:8}); await page.mouse.up();
  assert.equal((await state()).marks[0].drawings[0].color,'#ff3b30','new annotations default to red');
  for (const id of ['drawing-width-choice', 'drawing-font-choice', 'drawing-color-choice']) await toggle(id);
  await page.locator('#drawing-width-choice').click();
  assert.deepEqual(await page.locator('#drawing-width-choice-menu .stroke-sample').evaluateAll(nodes => nodes.map(e => e.getBoundingClientRect().height)), [1,2,4,6,8,12]);
  if (process.env.MENU_SCREENSHOTS) await page.screenshot({path:'/tmp/voidplayer-stroke-menu.png'});
  await page.getByRole('menuitemradio',{name:'粗 · 8 px',exact:true}).click();
  assert.equal((await state()).marks[0].drawings[0].strokeWidth,8);
  assert.equal(await page.locator('#drawing-width-choice .stroke-sample').evaluate(e=>e.getBoundingClientRect().height),8);
  await page.locator('#drawing-color-choice').click();
  assert.equal((await page.locator('#drawing-color-choice-menu').innerText()).trim(),'','palette has no visible prose');
  const tiles = await page.getByRole('group',{name:'常用色',exact:true}).locator('.color-swatch').evaluateAll(nodes=>nodes.map(n=>n.getBoundingClientRect().toJSON()));
  assert.equal(tiles.length,12); assert.equal(tiles[0].right,tiles[1].left); assert.equal(tiles[0].top,tiles[11].top);
  const spectrumTiles = await page.getByRole('group',{name:'色盘',exact:true}).locator('.color-swatch').evaluateAll(nodes=>nodes.map(n=>n.getBoundingClientRect().toJSON()));
  assert.equal(spectrumTiles.length,120); assert.equal(spectrumTiles[0].right,spectrumTiles[1].left); assert.equal(spectrumTiles[0].bottom,spectrumTiles[12].top);
  assert.equal(await page.locator('input[type=color]').count(),0,'no native system picker');
  const square=await page.locator('#drawing-color-choice .color-swatch').boundingBox(); assert.equal(square.width,18); assert.equal(square.height,18);
  const cyan=page.getByRole('menuitemradio',{name:'青色 #5ac8fa',exact:true});
  const beforeHover=(await state()).marks[0].drawings[0].color;
  await cyan.hover();
  const feedback=await cyan.evaluate(e=>({background:getComputedStyle(e,'::before').backgroundColor,inset:getComputedStyle(e,'::before').top,radius:getComputedStyle(e,'::before').borderRadius,shadow:getComputedStyle(e.querySelector('.color-swatch')).boxShadow}));
  assert.equal(feedback.background,'rgb(255, 255, 255)'); assert.equal(feedback.inset,'-6px'); assert.equal(feedback.radius,'12px'); assert.equal(feedback.shadow,'none');
  assert.equal((await state()).marks[0].drawings[0].color,beforeHover,'hover is a preview, not a color change');
  if (process.env.MENU_SCREENSHOTS) await page.screenshot({path:'/tmp/voidplayer-color-feedback.png'});
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#drawing-color-choice').evaluate(e=>getComputedStyle(e).outlineStyle),'none','keyboard focus has no outline');
  await page.locator('#drawing-color-choice').click();
  for (const color of ['蓝色 #007aff','绿色 #34c759','蓝色 #007aff']) {
    await page.getByRole('menuitemradio',{name:color,exact:true}).click();
    await page.locator('#drawing-color-choice').click();
  }
  assert.equal((await state()).marks[0].drawings[0].color,'#007aff');
  const tone = page.getByRole('group',{name:'色盘',exact:true}).locator('button').nth(50);
  const hue = await tone.getAttribute('data-color'); await tone.click();
  assert.equal((await state()).marks[0].drawings[0].color,hue,'full palette updates annotation ink');
  await page.locator('#drawing-color-choice').click();
  await page.getByRole('menuitemradio',{name:'蓝色 #007aff',exact:true}).click();
  await page.locator('#drawing-color-choice').click();
  assert.equal(await page.getByRole('group',{name:'最近使用',exact:true}).count(),0);
  assert.equal(await page.evaluate(()=>localStorage.getItem('voidplayer.annotation.recent-colors')),null,'choosing colors writes no history');
  await page.keyboard.press('Home'); await page.keyboard.press('ArrowRight');
  assert.equal(await page.evaluate(()=>document.activeElement.dataset.color),'#ff9500','palette supports horizontal keyboard navigation');
  await page.keyboard.press('ArrowDown'); assert.equal(await page.evaluate(()=>document.activeElement.dataset.color),'#ebebeb');
  if (process.env.MENU_SCREENSHOTS) await page.screenshot({path:'/tmp/voidplayer-color-menu.png'});
  // Switching between invokers leaves exactly one menu and no tooltip.
  await page.locator('#drawing-font-choice').click();
  assert.equal(await page.locator('.popup-menu:popover-open').count(),1);
  assert.equal(await page.locator('#drawing-font-choice-menu').evaluate(e=>e.matches(':popover-open')),true);
  await page.mouse.click(20,20); assert.equal(await page.locator('.popup-menu:popover-open').count(),0,'outside click dismisses');
  await page.locator('#mark-close').click(); await page.locator('.brand').click(); await page.keyboard.press('n');
  assert.equal(await page.locator('#drawing-color').inputValue(),'#ff3b30','a fresh editing session defaults to red');
  assert.equal((await state()).marks[0].drawings[0].color,'#007aff','existing colors are preserved');
  await page.reload(); await load(); await page.locator('.brand').click(); await page.keyboard.press('n'); await page.locator('#drawing-color-choice').click();
  assert.equal(await page.getByRole('group',{name:'色盘',exact:true}).locator('button').count(),120,'palette is fixed across reloads');
  assert.equal(await page.evaluate(()=>localStorage.getItem('voidplayer.annotation.recent-colors')),null);
  assert.equal(await page.locator('#drawing-color').inputValue(),'#ff3b30','stateless palette keeps red as the default');
  await page.keyboard.press('Escape'); await page.locator('#mark-close').click();
  await page.evaluate(async()=>{const tool=n=>window.voidPlayer.tools.find(t=>t.name===n);const lib=await tool('list_library').execute({});for(const [slot,name] of [['B','av1_10s_1920x1080.webm'],['C','vp9_10s_1920x1080.webm'],['D','h264_9s_1920x1080.mp4']])await tool('load_library_item').execute({slot,id:lib.entries.find(e=>e.name===name).id});});
  await page.setViewportSize({width:640,height:800});
  await page.locator('#header-more-A').waitFor({state:'visible'});
  await toggle('header-more-A','header-actions-A');
  await page.setViewportSize({width:1280,height:800});
  await page.emulateMedia({contrast:'more'});
  await page.locator('#pixel-size').click();
  for (const selector of ['.transport','.card-heading','#pixel-size-menu']) {
    assert.equal(await page.locator(selector).first().evaluate(e=>getComputedStyle(e).backdropFilter || getComputedStyle(e).webkitBackdropFilter),'none','high contrast disables blur');
  }
  // A future dark palette must also control opaque/high-contrast fallbacks.
  await page.addStyleTag({content: ':root { --surface-input-solid: #252932; --contrast-text-secondary: #e4e7ed; --swatch-selection-fill: #353b45; }'});
  assert.equal(await page.locator('#drawing-color').evaluate(e=>getComputedStyle(e).backgroundColor),'rgb(37, 41, 50)');
  assert.equal(await page.locator('.transport .duration').evaluate(e=>getComputedStyle(e).color),'rgb(228, 231, 237)');
  await page.keyboard.press('Escape');await page.locator('.brand').click();await page.keyboard.press('n');
  assert.equal(await page.locator('#annotation-toolbar').evaluate(e=>getComputedStyle(e).boxShadow),'none');
  await page.locator('#drawing-color-choice').click();
  assert.equal(await page.getByRole('group',{name:'常用色',exact:true}).locator('[aria-checked=true]').evaluate(e=>getComputedStyle(e,'::before').backgroundColor),'rgb(53, 59, 69)');
  assert.deepEqual(errors,[]);
  console.log(`PASS ${name}: repeated click/keyboard toggle, tooltip exclusion, stroke previews, shared style edits, fixed gapless palette, no color history, red defaults`);
} finally { await browser.close(); server.closeAllConnections(); await new Promise(r=>server.close(r)); }
