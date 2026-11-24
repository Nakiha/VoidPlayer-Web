import assert from 'node:assert/strict';
import { withBrowserFixture } from '../../browser-fixture.mjs';
import { waitForDialogClosed } from '../../browser-contracts.mjs';
const name=process.argv[2]??'webkit';
await withBrowserFixture({ caseName: 'shortcuts', engine: name, pageOptions: {viewport:{width:1280,height:800}} }, async ({ page, ready, artifact }) => {
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(() => {
    // Headless pages cannot toggle the desktop app's native title bar.
    const matchMedia = window.matchMedia.bind(window);
    const media = '(display-mode: window-controls-overlay)';
    const overlay = matchMedia(media);
    let matches = overlay.matches;
    Object.defineProperty(overlay, 'matches', { get: () => matches });
    window.matchMedia = query => query === media ? overlay : matchMedia(query);
    window.setTestWindowControlsOverlay = enabled => {
      matches = enabled;
      overlay.dispatchEvent(new Event('change'));
    };
  });
  await ready();
  await page.waitForFunction(() => window.voidPlayer);
  await page.evaluate(async()=>{const tool=n=>window.voidPlayer.tools.find(t=>t.name===n);const lib=await tool('list_library').execute({});await tool('load_library_item').execute({slot:'A',id:lib.entries.find(e=>e.name==='av1_10s_1920x1080.webm').id});});
  const playing=()=>page.evaluate(()=>window.voidPlayer.getState().playing);
  const focused=()=>page.locator('#toggle-chrome').getAttribute('aria-pressed');
  const beforeFocus=await page.locator('#stage-A').boundingBox();
  const beforeView=await page.evaluate(()=>window.voidPlayer.getViewport());
  const topbar = page.locator('.topbar');
  const imageHeight = () => page.locator('#image-A').evaluate(image => image.getBoundingClientRect().height);
  const toolbarBottom = await topbar.evaluate(bar => bar.getBoundingClientRect().bottom);
  const waitForTopbar = collapsed => page.waitForFunction(({ collapsed, toolbarBottom }) => {
    const bar = document.querySelector('.topbar');
    return bar.inert === collapsed && bar.getBoundingClientRect().bottom === (collapsed ? 0 : toolbarBottom)
      && bar.getAnimations().every(animation => animation.playState !== 'running');
  }, { collapsed, toolbarBottom });
  const focusButton = page.locator('#toggle-chrome');
  const opacity = () => focusButton.evaluate(button => getComputedStyle(button).opacity);
  const dockMaterial = () => page.locator('.transport-dock').evaluate(dock => {
    const style = getComputedStyle(dock);
    return { background: style.backgroundColor, blur: style.getPropertyValue('backdrop-filter'), webkitBlur: style.getPropertyValue('-webkit-backdrop-filter') };
  });
  const normalMaterial = await dockMaterial();
  const assertFocusMaterial = async () => {
    const material = await dockMaterial();
    assert.equal(material.background, 'rgba(0, 0, 0, 0)', 'focus mode leaves no transport backing fill');
    assert.ok([material.blur, material.webkitBlur].every(value => !value || value === 'none'),
      `focus mode removes both supported backdrop filters: ${JSON.stringify(material)}`);
  };
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await focusButton.click();
  await assertFocusMaterial();
  assert.ok(await focusButton.evaluate(button => getComputedStyle(button).transitionProperty.split(',').some(value => value.trim() === 'opacity')),
    'focus exit animates opacity when motion is allowed');
  await page.waitForTimeout(1800);
  assert.equal(await opacity(), '1', 'focus exit stays visible during the two-second grace period');
  await page.waitForFunction(() => getComputedStyle(document.getElementById('toggle-chrome')).opacity === '0', null, { timeout: 5000 });
  assert.equal(await focused(), 'true', 'idle fade preserves focus mode');
  await assertFocusMaterial();
  assert.equal(await page.locator('#control-tooltip').isVisible(), false, 'idle button leaves no floating tooltip');
  const centerX = beforeFocus.x + beforeFocus.width / 2, centerY = beforeFocus.y + beforeFocus.height / 2;
  await page.mouse.move(centerX, centerY);
  await page.waitForFunction(() => getComputedStyle(document.getElementById('toggle-chrome')).opacity === '1');
  await page.waitForTimeout(1100);
  await page.mouse.move(centerX + 1, centerY);
  await page.waitForTimeout(1100);
  assert.equal(await opacity(), '1', 'movement elsewhere in the viewport restarts the focus button timer');
  await waitForTopbar(true);
  assert.ok(await topbar.evaluate(bar => parseFloat(getComputedStyle(bar).transitionDuration) > 0), 'the toolbar slides when motion is allowed');
  const expandedStage = await page.locator('#stage-A').boundingBox();
  const expandedImageHeight = await imageHeight();
  assert.equal(expandedStage.y, beforeFocus.y - toolbarBottom, 'the viewport reclaims the topbar space');
  assert.equal(expandedStage.height, beforeFocus.height + toolbarBottom, 'the viewport grows to fill that space');
  for (const [id, shortcut] of [['inspector', 'Backquote'], ['analysis', '1'], ['subtracks', '2'], ['sources', '3']]) {
    await page.keyboard.press(`Control+${shortcut}`);
    assert.equal(await page.locator(`#toggle-${id}`).getAttribute('aria-expanded'), 'true', `${id} opens while the toolbar is inert`);
    await waitForTopbar(false);
    if (id === 'sources') {
      await page.keyboard.press('Control+2');
      await page.locator('#toggle-sources').click();
      await waitForTopbar(false);
      assert.equal(await page.locator('#toggle-subtracks').getAttribute('aria-expanded'), 'true', 'an open panel keeps the toolbar visible');
      await page.locator('#toggle-subtracks').click();
    } else await page.locator(`#toggle-${id}`).click();
    await waitForTopbar(true);
    assert.equal(await focused(), 'true', 'panel actions preserve focus mode');
  }
  await page.mouse.move(0, 0);
  await page.waitForFunction(() => getComputedStyle(document.getElementById('toggle-chrome')).opacity === '0', null, { timeout: 5000 });
  // macOS WebKit uses Option+Tab to include buttons in keyboard navigation.
  await page.keyboard.press(name === 'webkit' ? 'Alt+Tab' : 'Tab');
  await focusButton.focus();
  assert.equal(await focusButton.evaluate(button => document.activeElement === button), true, 'keyboard focus can recover the faded button');
  await page.waitForTimeout(2300);
  assert.equal(await opacity(), '1', 'keyboard-focused exit remains visible');
  await page.keyboard.press('f');
  assert.equal(await focused(), 'false', 'keyboard shortcut exits after fading');
  assert.deepEqual(await dockMaterial(), normalMaterial, 'exiting focus mode restores the transport material');
  await waitForTopbar(false);
  assert.deepEqual(await page.locator('#stage-A').boundingBox(), beforeFocus, 'exit restores the original stage geometry');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.locator('#toggle-chrome').focus();
  await page.keyboard.down('f');
  assert.equal(await focused(),'true','F enters focus mode from a focused button');
  assert.equal(await focusButton.evaluate(button => getComputedStyle(button).transitionProperty), 'none', 'reduced motion skips the fade animation');
  assert.equal(await topbar.evaluate(bar => getComputedStyle(bar).transitionProperty), 'none', 'reduced motion skips the toolbar animation');
  await waitForTopbar(true);
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
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const setOverlay = enabled => page.evaluate(enabled => window.setTestWindowControlsOverlay(enabled), enabled);
  const sampleOverlaySwitch = enabled => page.evaluate(async enabled => {
    const bar = document.querySelector('.topbar'), stage = document.querySelector('#stage-A');
    const image = document.querySelector('#image-A');
    const sample = () => ({ bottom: bar.getBoundingClientRect().bottom, stageTop: stage.getBoundingClientRect().top,
      imageHeight: image.getBoundingClientRect().height });
    window.setTestWindowControlsOverlay(enabled);
    const frames = [sample()];
    for (let i = 0; i < 4; i++) {
      await new Promise(resolve => requestAnimationFrame(resolve));
      frames.push(sample());
    }
    return frames;
  }, enabled);
  await setOverlay(true);
  await page.keyboard.press('f');
  assert.equal(await focused(), 'true');
  assert.equal(await topbar.evaluate(bar => bar.inert), false, 'focus mode keeps the overlay toolbar interactive');
  await waitForTopbar(false);
  assert.deepEqual(await page.locator('#stage-A').boundingBox(), beforeFocus, 'focus mode keeps the overlay toolbar space');
  const normalImageHeight = await imageHeight();
  assert.equal(await page.locator('.transport').evaluate(bar => bar.inert), true, 'focus mode still hides playback controls');
  const settingsButton = page.locator('#settings-open');
  await settingsButton.focus();
  assert.equal(await settingsButton.evaluate(button => document.activeElement === button), true, 'overlay toolbar accepts keyboard focus');
  assert.deepEqual(await sampleOverlaySwitch(false), Array(5).fill({ bottom: 0, stageTop: expandedStage.y, imageHeight: expandedImageHeight }),
    'showing Chrome’s title bar collapses the app toolbar and fits the image before the first frame');
  await waitForTopbar(true);
  assert.equal(await focusButton.evaluate(button => document.activeElement === button), true, 'collapsing returns focus to the exit button');
  const firstOverlayLayout = { bottom: toolbarBottom, stageTop: beforeFocus.y, imageHeight: normalImageHeight };
  assert.deepEqual(await sampleOverlaySwitch(true), Array(5).fill(firstOverlayLayout),
    'hiding Chrome’s title bar restores the app toolbar and fits the image before the first frame');
  await waitForTopbar(false);
  assert.equal(await focused(), 'true', 'switching the overlay preserves focus mode');
  await page.keyboard.press('f');
  await setOverlay(false);
  await waitForTopbar(false);
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
  for (const id of ['previous','next','arrangement']) {
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
  for (const id of ['toggle-sources', 'toggle-annotations', 'settings-open']) {
    const button = page.locator(`#${id}`), expanded = await button.getAttribute('aria-expanded');
    await button.focus();
    const before = await page.evaluate(() => window.voidPlayer.getState().positionUs);
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(before => !window.voidPlayer.getState().busy && window.voidPlayer.getState().positionUs > before,
      before, { timeout: 5000 });
    const after = await page.evaluate(() => window.voidPlayer.getState().positionUs);
    await page.keyboard.press('ArrowLeft');
    await page.waitForFunction(after => !window.voidPlayer.getState().busy && window.voidPlayer.getState().positionUs < after, after);
    assert.equal(await button.evaluate(button => document.activeElement === button), true, `${id}: frame stepping retains button focus`);
    assert.equal(await button.getAttribute('aria-expanded'), expanded, `${id}: frame keys do not activate the focused action`);
    assert.equal(await page.locator('html').getAttribute('data-keyboard-navigation'), null, `${id}: frame keys do not create a focus ring`);
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
  const menuPosition = await page.evaluate(() => window.voidPlayer.getState().positionUs);
  for (const key of ['ArrowRight', 'ArrowLeft']) {
    await page.keyboard.press(key); await page.waitForFunction(() => !window.voidPlayer.getState().busy);
    assert.equal(await page.evaluate(() => window.voidPlayer.getState().positionUs), menuPosition, 'open menu owns frame-direction keys');
  }
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
  const dialogPosition = await page.evaluate(() => window.voidPlayer.getState().positionUs);
  for (const key of ['ArrowRight', 'ArrowLeft']) {
    await page.keyboard.press(key); await page.waitForFunction(() => !window.voidPlayer.getState().busy);
    assert.equal(await page.evaluate(() => window.voidPlayer.getState().positionUs), dialogPosition, 'dialog buttons do not step frames');
  }
  await page.locator('#settings-close').focus();
  await page.keyboard.press('Space');await page.waitForFunction(()=>window.voidPlayer.getState().playing);
  assert.equal(await page.locator('#settings').evaluate(e=>e.open),true,'Space in dialog does not activate close');
  await page.keyboard.press('Space');await page.waitForFunction(()=>!window.voidPlayer.getState().playing);
  await page.locator('#settings-close').click();await waitForDialogClosed(page);
  await page.locator('#position').fill('00:01.000');await page.keyboard.press('Space');
  assert.equal(await page.locator('#position').inputValue(),'00:01.000 ');assert.equal(await playing(),false);
  await page.keyboard.press('Escape');
  await page.locator('#toggle-sources').click();await page.locator('#library-location').focus();await page.locator('#library-location').fill('sample');
  const searchPosition = await page.evaluate(() => window.voidPlayer.getState().positionUs);
  await page.keyboard.press('ArrowLeft');
  await page.waitForFunction(() => !window.voidPlayer.getState().busy);
  assert.equal(await page.locator('#library-location').evaluate(input => input.selectionStart), 5, 'text inputs retain caret navigation');
  assert.equal(await page.evaluate(() => window.voidPlayer.getState().positionUs), searchPosition, 'text arrows do not step frames');
  await page.keyboard.press('ArrowRight'); await page.waitForFunction(() => !window.voidPlayer.getState().busy);
  assert.equal(await page.evaluate(() => window.voidPlayer.getState().positionUs), searchPosition, 'text arrows never trigger frame stepping');
  await page.keyboard.press('f');
  assert.equal(await page.locator('#library-location').inputValue(),'samplef');assert.equal(await focused(),'false','typing F in search does not toggle focus mode');
  await page.locator('#library-location').fill('sample');
  await page.keyboard.press('Space');assert.equal(await page.locator('#library-location').inputValue(),'sample ');assert.equal(await playing(),false);
  await page.keyboard.press('Escape'); await page.mouse.move(0,0);
  assert.equal(await page.locator('#library-location').inputValue(),'媒体库');
  await page.keyboard.press('Space');await page.waitForFunction(()=>window.voidPlayer.getState().playing);
  await page.keyboard.press('Space');await page.waitForFunction(()=>!window.voidPlayer.getState().playing);
  assert.equal(await page.locator('#library-location').inputValue(),'媒体库','global Space leaves the folder label intact');
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
