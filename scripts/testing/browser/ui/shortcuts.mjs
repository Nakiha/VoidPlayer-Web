import assert from 'node:assert/strict';
import { withBrowserFixture } from '../../browser-fixture.mjs';
const name=process.argv[2]??'webkit';
await withBrowserFixture({ caseName: 'shortcuts', engine: name, pageOptions: {viewport:{width:1280,height:800}} }, async ({ page, ready, artifact }) => {
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await ready();
  await page.waitForFunction(() => window.voidPlayer);
  await page.evaluate(async()=>{const tool=n=>window.voidPlayer.tools.find(t=>t.name===n);const lib=await tool('list_library').execute({});await tool('load_library_item').execute({slot:'A',id:lib.entries.find(e=>e.name==='av1_10s_1920x1080.webm').id});});
  const playing=()=>page.evaluate(()=>window.voidPlayer.getState().playing);
  const focused=()=>page.locator('#toggle-chrome').getAttribute('aria-pressed');
  const beforeFocus=await page.locator('#stage-A').boundingBox();
  const beforeView=await page.evaluate(()=>window.voidPlayer.getViewport());
  await page.locator('#toggle-chrome').focus();
  await page.keyboard.down('f');
  assert.equal(await focused(),'true','F enters focus mode from a focused button');
  await page.keyboard.down('f');
  assert.equal(await focused(),'true','holding F does not toggle repeatedly');
  await page.keyboard.up('f');await page.keyboard.press('f');
  assert.equal(await focused(),'false','F exits focus mode while transport is inert');
  assert.deepEqual(await page.locator('#stage-A').boundingBox(),beforeFocus);
  assert.deepEqual(await page.evaluate(()=>window.voidPlayer.getViewport()),beforeView);
  assert.equal(await playing(),false,'focus mode preserves playback');
  await page.locator('#toggle-chrome').dispatchEvent('keydown',{key:'f',code:'KeyF',isComposing:true});
  await page.keyboard.press('Control+f');
  assert.equal(await focused(),'false','IME and modified F do not toggle focus mode');
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
  // Pointer focus followed by a global shortcut must not acquire the shared
  // keyboard-navigation fill, even if the browser now matches :focus-visible.
  // WebKit can serialize the same resting color as rgba or oklab after a
  // transition. Compare resolved pixels instead of the CSS spelling.
  const fill = id => page.locator(`#${id}`).evaluate(e=>{
    const canvas=document.createElement('canvas');canvas.width=canvas.height=1;
    const context=canvas.getContext('2d');context.fillStyle=getComputedStyle(e).backgroundColor;
    context.fillRect(0,0,1,1);return Array.from(context.getImageData(0,0,1,1).data);
  });
  for (const id of ['previous','next','reset-view']) {
    await page.locator(`#${id}`).click();
    await page.waitForFunction(()=>!window.voidPlayer.getState().busy);
    // macOS WebKit does not focus every button on pointer clicks. Reproduce
    // the retained pointer-origin focus explicitly on that platform as well.
    await page.locator(`#${id}`).focus();
    await page.mouse.move(0,0);
    await page.waitForTimeout(300);
    const resting = await fill(id);
    await page.keyboard.press('Space');await page.waitForFunction(()=>window.voidPlayer.getState().playing);
    await page.keyboard.press('Space');await page.waitForFunction(()=>!window.voidPlayer.getState().playing);
    assert.equal(await page.locator(`#${id}`).evaluate(e=>document.activeElement===e),true,'shortcut retains pointer-focused control');
    await page.waitForTimeout(300);
    assert.deepEqual(await fill(id),resting,`${id}: shortcut does not tint the previously clicked control`);
    assert.equal(await page.locator('html').getAttribute('data-keyboard-navigation'),null);
  }
  await page.locator('#previous').click();await page.waitForFunction(()=>!window.voidPlayer.getState().busy);
  await page.locator('#previous').focus();await page.keyboard.press(name === 'webkit' ? 'Alt+Tab' : 'Tab');
  await page.waitForFunction(()=>document.documentElement.hasAttribute('data-keyboard-navigation'));
  assert.equal(await page.locator('html').getAttribute('data-keyboard-navigation'),'','Tab enables keyboard navigation feedback');
  assert.equal(await page.evaluate(()=>document.activeElement.matches(':focus-visible')),true);
  await page.locator('#previous').click();
  await page.waitForFunction(()=>!window.voidPlayer.getState().busy);
  assert.equal(await page.locator('html').getAttribute('data-keyboard-navigation'),null,'pointer resumes without clearing DOM focus');
  await page.keyboard.press('ArrowRight');await page.waitForFunction(()=>!window.voidPlayer.getState().busy);
  assert.equal(await page.locator('html').getAttribute('data-keyboard-navigation'),null,'frame-step shortcut does not enable navigation feedback');
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
  await page.waitForFunction(()=>document.documentElement.hasAttribute('data-keyboard-navigation'));
  assert.equal(await page.locator('html').getAttribute('data-keyboard-navigation'),'','menu arrow navigation enables focus feedback');
  const pixelMode=await page.evaluate(()=>window.voidPlayer.getViewport().pixelSize);
  await page.keyboard.press('Space');await page.waitForFunction(()=>window.voidPlayer.getState().playing);
  assert.equal(await page.evaluate(()=>window.voidPlayer.getViewport().pixelSize),pixelMode);
  await page.keyboard.press('Space');await page.waitForFunction(()=>!window.voidPlayer.getState().playing);
  await page.keyboard.press('Escape');
  await page.locator('#settings-open').click();await page.locator('#settings-tab-shortcuts').click();
  assert.equal(await page.locator('#settings-pane-shortcuts .shortcut-row').filter({hasText:'专注模式'}).locator('kbd').textContent(),'F');
  await page.keyboard.press('f');assert.equal(await focused(),'false','F is inactive in dialogs');
  await page.locator('#settings-close').focus();
  await page.keyboard.press('Space');await page.waitForFunction(()=>window.voidPlayer.getState().playing);
  assert.equal(await page.locator('#settings').evaluate(e=>e.open),true,'Space in dialog does not activate close');
  await page.keyboard.press('Space');await page.waitForFunction(()=>!window.voidPlayer.getState().playing);
  await page.locator('#settings-close').click();await page.waitForFunction(()=>!document.querySelector('#settings').open && document.activeElement===document.querySelector('#settings-open'));
  await page.locator('#position').fill('00:01.000');await page.keyboard.press('Space');
  assert.equal(await page.locator('#position').inputValue(),'00:01.000 ');assert.equal(await playing(),false);
  await page.keyboard.press('Escape');
  await page.locator('#toggle-sources').click();await page.locator('#sources-search-toggle').click();await page.locator('#source-search').fill('sample');
  await page.keyboard.press('f');
  assert.equal(await page.locator('#source-search').inputValue(),'samplef');assert.equal(await focused(),'false','typing F in search does not toggle focus mode');
  await page.locator('#source-search').fill('sample');
  await page.keyboard.press('Space');assert.equal(await page.locator('#source-search').inputValue(),'sample ');assert.equal(await playing(),false);
  await page.locator('#sources-search-toggle').click();await page.mouse.move(0,0);await page.waitForTimeout(300);
  const searchResting = await fill('sources-search-toggle');
  await page.keyboard.press('Space');await page.waitForFunction(()=>window.voidPlayer.getState().playing);
  await page.keyboard.press('Space');await page.waitForFunction(()=>!window.voidPlayer.getState().playing);
  await page.waitForTimeout(300);
  assert.deepEqual(await fill('sources-search-toggle'),searchResting,'closed search stays untinted after global Space');
  assert.equal(await page.locator('#sources-search-toggle').getAttribute('aria-expanded'),'false','Space does not reopen search');
  await page.screenshot({path:artifact(`shortcuts-pointer-space-${name}.png`)});
  await page.locator('#toggle-sources').click();
  await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });await page.keyboard.press('n');
  // Wait for the selected tool on the drawing layer as well as its button.
  // A visible toolbar alone does not establish that the drawing surface is ready.
  await page.locator('#drawing-A').waitFor({state:'visible'});
  await page.keyboard.press('f');assert.equal(await focused(),'false','F does not hide the annotation editor');
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
  console.log(`PASS ${name}: focus-mode F toggle and help, repeat/dialog/editor/input guards, global Space, no native activation, annotation saved before play`);
});
