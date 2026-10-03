import assert from 'node:assert/strict';
import { withBrowserFixture } from '../../browser-fixture.mjs';
const name=process.argv[2]??'webkit';
await withBrowserFixture({ caseName: 'shortcuts', engine: name, pageOptions: {viewport:{width:1280,height:800}} }, async ({ page, ready }) => {
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await ready();
  await page.waitForFunction(() => window.voidPlayer);
  await page.evaluate(async()=>{const tool=n=>window.voidPlayer.tools.find(t=>t.name===n);const lib=await tool('list_library').execute({});await tool('load_library_item').execute({slot:'A',id:lib.entries.find(e=>e.name==='av1_10s_1920x1080.webm').id});});
  const playing=()=>page.evaluate(()=>window.voidPlayer.getState().playing);
  // Real key down/up: Space must not generate a click on the focused action.
  for (const id of ['previous','next','fullscreen','toggle-chrome','timeline','play']) {
    await page.locator(`#${id}`).focus();
    await page.evaluate(id=>{window.shortcutClicks=[];document.getElementById(id).addEventListener('click',()=>window.shortcutClicks.push(id),{once:true});},id);
    await page.keyboard.press('Space');await page.waitForFunction(()=>window.voidPlayer.getState().playing);
    await page.keyboard.press('Space');await page.waitForFunction(()=>!window.voidPlayer.getState().playing);
    assert.deepEqual(await page.evaluate(()=>window.shortcutClicks),id==='play'?['play']:[],`${id}: Space does not activate focused controls`);
    assert.equal(await page.locator('#toggle-chrome').getAttribute('aria-pressed'),'false');
    assert.equal(await page.locator(`#${id}`).evaluate(e=>getComputedStyle(e).outlineStyle),'none','Space retains keyboard focus without a focus ring');
  }
  await page.locator('#previous').focus();
  await page.keyboard.down('Space');await page.waitForFunction(()=>window.voidPlayer.getState().playing);
  await page.keyboard.down('Space');await page.keyboard.down('Space');
  assert.equal(await playing(),true,'holding Space toggles only once');
  await page.keyboard.up('Space');await page.keyboard.press('Space');
  await page.waitForFunction(()=>!window.voidPlayer.getState().playing);
  await page.locator('#previous').dispatchEvent('keydown',{key:' ',code:'Space',isComposing:true});
  assert.equal(await playing(),false,'IME composition does not trigger playback');
  await page.locator('#pixel-size').click();
  await page.keyboard.press('ArrowDown');
  const pixelMode=await page.evaluate(()=>window.voidPlayer.getViewport().pixelSize);
  await page.keyboard.press('Space');await page.waitForFunction(()=>window.voidPlayer.getState().playing);
  assert.equal(await page.evaluate(()=>window.voidPlayer.getViewport().pixelSize),pixelMode);
  await page.keyboard.press('Space');await page.waitForFunction(()=>!window.voidPlayer.getState().playing);
  await page.keyboard.press('Escape');
  await page.locator('#settings-open').click();await page.locator('#settings-tab-shortcuts').click();
  await page.locator('#settings-close').focus();
  await page.keyboard.press('Space');await page.waitForFunction(()=>window.voidPlayer.getState().playing);
  assert.equal(await page.locator('#settings').evaluate(e=>e.open),true,'Space in dialog does not activate close');
  await page.keyboard.press('Space');await page.waitForFunction(()=>!window.voidPlayer.getState().playing);
  await page.locator('#settings-close').click();await page.waitForFunction(()=>!document.querySelector('#settings').open && document.activeElement===document.querySelector('#settings-open'));
  await page.locator('#position').fill('00:01.000');await page.keyboard.press('Space');
  assert.equal(await page.locator('#position').inputValue(),'00:01.000 ');assert.equal(await playing(),false);
  await page.keyboard.press('Escape');
  await page.locator('#toggle-sources').click();await page.locator('#sources-search-toggle').click();await page.locator('#source-search').fill('sample');
  await page.keyboard.press('Space');assert.equal(await page.locator('#source-search').inputValue(),'sample ');assert.equal(await playing(),false);
  await page.locator('#toggle-sources').click();
  await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });await page.keyboard.press('n');
  // Wait for the selected tool on the drawing layer as well as its button.
  // A visible toolbar alone does not establish that the drawing surface is ready.
  await page.locator('#drawing-A').waitFor({state:'visible'});
  await page.locator('[data-drawing-tool=text]').click();
  await page.waitForFunction(()=>document.querySelector('[data-drawing-tool=text]').getAttribute('aria-pressed')==='true'&&document.querySelector('#drawing-A').dataset.tool==='text');
  const drawing=page.locator('#drawing-A'), rect=await drawing.boundingBox();
  await drawing.click({position:{x:250-rect.x,y:240-rect.y}});
  const text=page.locator('[contenteditable=true]');await text.fill('hello');await page.keyboard.press('Space');await page.keyboard.type('world');
  assert.equal(await text.innerText(),'hello world');assert.equal(await playing(),false);
  await page.keyboard.press('Escape');await page.locator('[data-drawing-tool=rect]').focus();
  await page.keyboard.press('Space');await page.waitForFunction(()=>window.voidPlayer.getState().playing);
  assert.equal(await page.locator('#annotation-toolbar').isVisible(),false,'Space finishes annotation editing before play');
  await page.keyboard.press('Space');await page.waitForFunction(()=>!window.voidPlayer.getState().playing);
  assert.ok(await page.evaluate(()=>window.voidPlayer.getState().marks.some(m=>m.drawings.some(d=>d.text==='hello world'))),'annotation text is retained');
  assert.deepEqual(errors,[]);
  console.log(`PASS ${name}: global Space, button/menu/dialog/range focus, no native activation, no repeat toggle, text/IME input preserved, annotation saved before play`);
});
