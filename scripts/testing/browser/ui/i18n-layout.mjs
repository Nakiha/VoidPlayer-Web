import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {withBrowserFixture} from '../../browser-fixture.mjs';
const engine=process.argv[2]??'chromium',root=path.resolve(import.meta.dirname,'../../../..');
const pseudoDir=path.join(root,'.run/i18n-pseudo-dist');
execFileSync(process.execPath,['node_modules/vite/bin/vite.js','build','--outDir',pseudoDir],{cwd:root,env:{...process.env,VITE_I18N_PSEUDO:'1'},stdio:'pipe'});
await withBrowserFixture({caseName:'i18n-layout',engine,staticDir:pseudoDir,pageOptions:{locale:'en-US',reducedMotion:'reduce'}},async({page,url,artifact})=>{
 await page.goto(url+'?pseudo-locale');await page.waitForFunction(()=>window.voidPlayer);
 await page.locator('#settings-open').click();
 const checks=[];
 for(const width of [1280,600,390,320]){
  await page.setViewportSize({width,height:800});
  for(const pane of ['appearance','workspace','identity','shortcuts','logs','performance','about']){
   await page.locator(`#settings-tab-${pane}`).click();
   const layout=await page.locator(`#settings-pane-${pane}`).evaluate(el=>{
    const bounds=el.getBoundingClientRect(),errors=[];
    for(const control of el.querySelectorAll('button,input,textarea,h4')){
     if(!control.getClientRects().length)continue;const r=control.getBoundingClientRect(),style=getComputedStyle(control);
     if(r.left<bounds.left-1||r.right>bounds.right+1)errors.push({id:control.id,text:control.textContent,problem:'outside pane',width:r.width});
     if(control.tagName==='BUTTON' && style.textOverflow!=='ellipsis' && control.scrollWidth>control.clientWidth+2)errors.push({id:control.id,text:control.textContent,problem:'clipped text',scroll:control.scrollWidth,client:control.clientWidth});
    }
    return {pane:el.id,errors,font:getComputedStyle(el).fontFamily};
   });
   checks.push({width,...layout});
   if(width===1280&&pane==='appearance'||width===390&&pane==='performance')await page.screenshot({path:artifact(`pseudo-${pane}-${width}.png`)});
  }
 }
 assert.match(await page.locator('#settings-current-title').innerText(),/［/);
 await writeFile(artifact('report.json'),JSON.stringify({engine,checks},null,2));assert.deepEqual(checks.filter(c=>c.errors.length),[],`pseudo ${engine}: all settings widths`);console.log(`PASS ${engine}: expanded pseudo settings at 1280/600/390/320px`);
});
