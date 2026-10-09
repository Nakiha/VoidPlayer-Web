import assert from 'node:assert/strict';
import { withBrowserFixture } from '../../browser-fixture.mjs';
const name = 'webkit';
await withBrowserFixture({ caseName: 'color-settings', engine: name, pageOptions: {"viewport": {"width": 1280, "height": 850}, "colorScheme": "dark"} }, async ({ page, ready, artifact }) => {
 const errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await ready();
 await page.locator('#settings-open').click();await page.locator('#settings-tab-performance').click();
 const pane=page.locator('#settings-pane-performance');
 await page.locator('#settings').evaluate(e=>Promise.all(e.getAnimations().map(a=>a.finished)));
 assert.equal(await page.locator('#settings-tab-performance').innerText(),'色彩与解码');
 assert.equal(await pane.locator('select,details,summary').count(),0);
 assert.equal(await page.locator('#color-mode').evaluate(el=>getComputedStyle(el).backgroundColor),await page.locator('#layout-mode').evaluate(el=>getComputedStyle(el).backgroundColor),'color choices use the toolbar segment group surface');
 assert.equal(await page.locator('[data-color-mode=browser]').getAttribute('aria-pressed'),'true','fresh profiles default to browser color');
 assert.equal(await page.locator('[data-color-mode=browser]').evaluate(el=>getComputedStyle(el).backgroundColor),await page.locator('#layout-mode [aria-pressed=true]').evaluate(el=>getComputedStyle(el).backgroundColor),'selected color mode uses the toolbar segment fill');
 assert.equal(await pane.locator('.color-flow-lane').count(),2);
 await page.evaluate(()=>{
   window.colorControlDisabledChanges=[];
   new MutationObserver(records=>window.colorControlDisabledChanges.push(...records.map(record=>record.target.getAttribute('disabled'))))
     .observe(document.querySelector('#color-mode'),{subtree:true,attributes:true,attributeFilter:['disabled']});
 });
 await page.locator('[data-color-mode=reference]').click();
 await page.waitForFunction(()=>localStorage.getItem('voidplayer.color-mode')==='reference');
 assert.deepEqual(await page.evaluate(()=>window.colorControlDisabledChanges),[],'switching modes does not dim the segment controls');
 assert.equal(await page.locator('[data-color-mode=reference]').evaluate(el=>getComputedStyle(el).opacity),'1');
 assert.equal(await pane.locator('.color-flow-lane').count(),1);
 const stable = await page.locator('#color-flow-diagram .color-flow-lane').elementHandle();
 const memory = await page.locator('#color-flow-diagram .color-flow-unit').nth(1).elementHandle();
 const before = await page.locator('.color-settings-card').boundingBox();
 await page.locator('[data-reference-decoder=hardware]').click();
 await page.waitForFunction(()=>document.querySelector('[data-reference-decoder=hardware]').getAttribute('aria-pressed')==='true');
 assert.match(await page.locator('#color-flow-diagram').innerText(),/读回/);
 assert.equal(await stable.evaluate(e=>e.isConnected),true,'decoder switch preserves the lane');
 assert.equal(await memory.evaluate(e=>e.isConnected),true,'unchanged units stay mounted');
 assert.deepEqual(await page.locator('.color-settings-card').boundingBox(),before,'decoder switch preserves card geometry');
 assert.equal(await stable.evaluate(e=>getComputedStyle(e).opacity),'1','lane never fades');
 const stroke=await page.locator('.color-flow-connector path').first().evaluate(e=>({stroke:getComputedStyle(e).stroke,width:getComputedStyle(e).strokeWidth,vectorEffect:getComputedStyle(e).vectorEffect,parent:getComputedStyle(e.closest('.color-flow-link')).color}));
 // The responsive connector redesign uses a fixed 1.25px non-scaling stroke,
 // independent of the node icon size (formerly the 36px icon's 2.25px outline).
 assert.equal(stroke.stroke,stroke.parent);assert.equal(stroke.width,'1.25px');assert.equal(stroke.vectorEffect,'non-scaling-stroke');
 assert.equal(await pane.locator('[data-icon=arrowRight]').count(),0);
 await page.locator('#hardware-buffer-depth').click();
 await page.locator('#hardware-buffer-depth-menu').getByRole('menuitemradio',{name:'4 帧',exact:true}).click();
 await page.waitForFunction(()=>JSON.parse(localStorage.getItem('voidplayer.reference-decode')).depth===4);
 await page.locator('#settings').screenshot({animations:'disabled',path:artifact('vp-color-settings-hardware.png')});
 await page.locator('[data-color-mode=browser]').click();
 await page.waitForFunction(()=>localStorage.getItem('voidplayer.color-mode')==='browser');
 assert.equal(await page.locator('#reference-decode-settings').isVisible(),false);
 assert.equal(await pane.locator('.color-flow-lane').count(),2);
 await page.locator('#settings').screenshot({animations:'disabled',path:artifact('vp-color-settings-browser.png')});
 await page.locator('[data-color-mode=reference]').click();await page.locator('[data-reference-decoder=software]').click();
 await page.waitForFunction(()=>JSON.parse(localStorage.getItem('voidplayer.reference-decode')).decoder==='software');
 assert.equal(await page.locator('#hardware-depth-row').isVisible(),false);
 await page.locator('#settings').screenshot({animations:'disabled',path:artifact('vp-color-settings-software.png')});
 await page.emulateMedia({colorScheme:'light'});await page.locator('#settings').screenshot({animations:'disabled',path:artifact('vp-color-settings-light.png')});
 for(const width of [600,460,390]){
   await page.setViewportSize({width,height:760});
   await page.locator('#settings').screenshot({animations:'disabled',path:artifact(`vp-color-settings-narrow-${width}.png`)});
   assert.equal(await pane.evaluate(e=>e.scrollWidth<=e.clientWidth+1),true,'no horizontal pane overflow');
   const alignment=await pane.locator('.color-flow-lane').evaluateAll(lanes=>lanes.flatMap(lane=>{
     const units=[...lane.querySelectorAll('.color-flow-unit > svg')].map(e=>e.getBoundingClientRect());
     const vertical=lane.closest('.color-flow').getBoundingClientRect().width<=460;
     return [...lane.querySelectorAll('.color-flow-link')].map((e,i)=>{
       const active=e.querySelector(vertical?'.color-flow-connector-vertical':'.color-flow-connector-horizontal');
       const inactive=e.querySelector(vertical?'.color-flow-connector-horizontal':'.color-flow-connector-vertical');
       const r=active.getBoundingClientRect(),label=e.querySelector('span').getBoundingClientRect(),center=r.x+r.width/2;
       return {vertical,visible:r.width>0&&r.height>0,inactive:getComputedStyle(inactive).display,stroke:getComputedStyle(active.querySelector('path')).strokeWidth,
         x:vertical?Math.max(Math.abs(center-units[i].x-units[i].width/2),Math.abs(center-units[i+1].x-units[i+1].width/2)):Math.abs(center-(units[i].x+units[i].width/2+units[i+1].x+units[i+1].width/2)/2),
         y:vertical?Math.abs(label.y+label.height/2-r.y-r.height/2):Math.abs(r.y+r.height/2-units[i].y-units[i].height/2),
         between:!vertical||(r.y>=units[i].bottom&&r.bottom<=units[i+1].top),
         label:vertical?label.left>=r.right+9:Math.abs(label.x+label.width/2-center)<1};
     });
   }));
   assert.ok(alignment.length>0);
   for(const a of alignment){assert.equal(a.visible,true);assert.equal(a.inactive,'none');assert.equal(a.stroke,'1.25px');assert.ok(a.x<1,JSON.stringify(a));assert.ok(a.y<1,JSON.stringify(a));assert.equal(a.between,true);assert.equal(a.label,true);}
 }
 await page.locator('[data-color-target=hdr]').click();await page.waitForFunction(()=>JSON.parse(localStorage.getItem('voidplayer.color-output')).target==='hdr');
 await page.locator('#hdr-source-peak').click();await page.locator('#hdr-source-peak-menu').getByRole('menuitemradio',{name:'4000 nits',exact:true}).click();await page.waitForFunction(()=>JSON.parse(localStorage.getItem('voidplayer.color-output')).preview.sourcePeakNits===4000);
 await page.reload();await page.waitForFunction(()=>window.voidPlayer);
 assert.equal(await page.evaluate(()=>window.voidPlayer.tools.find(t=>t.name==='get_review_session').execute({}).colorMode),'reference','saved explicit choice survives reload');
 assert.equal(await page.locator('[data-color-target=hdr]').getAttribute('aria-pressed'),'true');assert.match(await page.locator('#hdr-source-peak').innerText(),/4000/);
 assert.deepEqual(errors,[]);
 console.log('PASS color settings: custom controls, diagram changes, persisted decoder/depth/mode, light/dark and narrow layout');
});
