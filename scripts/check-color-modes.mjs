import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {mkdir,writeFile} from 'node:fs/promises';
const reports=[];
for(const channel of ['chrome','msedge']){
 const browser=await chromium.launch({headless:false,...(channel==='chrome'&&process.env.CHROME_EXECUTABLE_PATH?{executablePath:process.env.CHROME_EXECUTABLE_PATH}:{channel})});
 try{
  const page=await browser.newPage();await page.addInitScript(()=>{if(localStorage.getItem('voidplayer.color-mode')===null)localStorage.setItem('voidplayer.color-mode','reference');});await page.goto(process.env.BASE_URL??'http://127.0.0.1:5193/');await page.waitForFunction(()=>window.voidPlayer);
  await page.locator('#identity-welcome [data-guest]').click();
  const result=await page.evaluate(async()=>{
   const call=(name,args={})=>window.voidPlayer.tools.find(t=>t.name===name).execute(args);
   const library=await call('list_library'),item=library.entries.find(e=>e.name==='mhw_hevc_fullrange_bt709_3s.mp4');
   await call('load_library_item',{id:item.id,slot:'A'});
   await call('seek_review',{ptsUs:1000000});
   const before=await call('get_review_session');
   await call('set_review_color_mode',{mode:'browser'});const matched=await call('get_review_session');
   await call('set_review_color_mode',{mode:'reference'});const after=await call('get_review_session');
   return {before,matched,after};
  });
  assert.equal(result.before.colorMode,'reference');assert.equal(result.before.tracks[0].decoder,'ffmpeg-wasm');
  assert.equal(result.matched.colorMode,'browser');assert.equal(result.matched.tracks[0].decoder,'webcodecs');
  assert.equal(result.after.tracks[0].decoder,'ffmpeg-wasm');
  const hardware=await page.evaluate(async()=>{
    const call=(name,args={})=>window.voidPlayer.tools.find(t=>t.name===name).execute(args);
    const states=[];
    for(const depth of [1,2,4,8]){
      await call('set_reference_decode',{decoder:'hardware',depth});
      for(const ptsUs of [2000000,100000,1000000])await call('seek_review',{ptsUs});
      states.push(await call('get_review_session'));
    }
    await call('set_reference_decode',{decoder:'software',depth:2});return states;
  });
  await writeFile(`artifacts/color/hardware-states-${channel}.json`,JSON.stringify({hardware,logs:await page.evaluate(()=>window.voidPlayer.tools.find(t=>t.name==='get_review_logs').execute({}))},null,2));
  for(const state of hardware){assert.equal(state.tracks[0].decoder,'webcodecs');assert.equal(state.positionUs,1000000);}
  const fallback=await page.evaluate(async()=>{
    const decoder=globalThis.VideoDecoder;globalThis.VideoDecoder=undefined;
    try{return await window.voidPlayer.tools.find(t=>t.name==='set_reference_decode').execute({decoder:'hardware',depth:2});}
    finally{globalThis.VideoDecoder=decoder;}
  });
  assert.equal(fallback.tracks[0].decoder,'ffmpeg-wasm');
  await page.evaluate(()=>window.voidPlayer.tools.find(t=>t.name==='set_reference_decode').execute({decoder:'software',depth:2}));
  for(const state of [result.matched,result.after]){assert.equal(state.positionUs,result.before.positionUs);assert.equal(state.tracks[0].id,result.before.tracks[0].id);assert.deepEqual(state.marks,result.before.marks);assert.equal(state.playing,false);}
  await page.locator('#settings-open').click();await page.locator('#settings-tab-performance').click();
  await page.locator('[data-reference-decoder=hardware]').click();
  await page.waitForFunction(()=>!document.querySelector('#hardware-buffer-depth').disabled&&getComputedStyle(document.querySelector('#hardware-depth-row')).visibility==='visible');
  await page.locator('#hardware-buffer-depth').click();
  await page.locator('#hardware-buffer-depth-menu').getByRole('menuitemradio',{name:'4 帧',exact:true}).click();
  await page.waitForFunction(()=>localStorage.getItem('voidplayer.reference-decode')===JSON.stringify({decoder:'hardware',depth:4}));
  await page.screenshot({path:`artifacts/color/hardware-settings-${channel}.png`});
  await page.locator('[data-color-mode=browser]').click();
  await page.waitForFunction(()=>document.querySelector('[data-color-mode=browser]')?.disabled===false&&document.querySelector('[data-color-mode=browser]')?.getAttribute('aria-pressed')==='true');
  await page.waitForFunction(async()=>{const t=window.voidPlayer.tools.find(t=>t.name==='get_review_session');return (await t.execute({})).colorMode==='browser';});
  await mkdir('artifacts/color',{recursive:true});await page.screenshot({path:`artifacts/color/modes-${channel}.png`});
  await page.reload();await page.waitForFunction(()=>window.voidPlayer);
  assert.equal(await page.evaluate(()=>window.voidPlayer.tools.find(t=>t.name==='get_review_session').execute({}).colorMode),'browser');
  assert.deepEqual(await page.evaluate(()=>window.voidPlayer.tools.find(t=>t.name==='get_review_session').execute({}).referenceDecode),{decoder:'hardware',depth:4});
  reports.push({channel,version:browser.version(),result});console.log(`PASS ${channel}: actual WASM/native mode switching, time/identity preservation, UI, persistence`);
 }finally{await browser.close();}
}
await writeFile('artifacts/color/modes-report.json',JSON.stringify(reports,null,2));
