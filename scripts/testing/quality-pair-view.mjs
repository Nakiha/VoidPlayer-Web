import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
export async function checkQualityPairView(linked,{space,annotationId,evidence,engine,sample}) {
 if(await linked.locator('#subtracks-panel').isHidden())await linked.locator('#toggle-subtracks').click();
 if(await linked.locator('#toggle-marks').getAttribute('aria-expanded')==='false')await linked.locator('#toggle-marks').click();
 await linked.locator(`[data-mark-id="${annotationId}"] .annotation-psnr-evidence`).click();
 const dialog=linked.getByRole('dialog',{name:'PSNR evidence',exact:true}),link=dialog.locator('.quality-pair-open').first();
 const href=await link.getAttribute('href');
 const agent=await linked.evaluate(async input=>window.voidPlayer.tools.find(t=>t.name==='get_annotation_pair_view').execute(input),{space,annotationId,evidenceId:evidence.id});assert.equal(agent.url,href,'GUI/Agent use the same explicit reference URL');
 const requests=[],observe=request=>requests.push({url:request.url(),method:request.method()});linked.context().on('request',observe);
 await linked.context().addInitScript(()=>{
  const NativeWorker=window.Worker;
  window.Worker=class extends NativeWorker {
   constructor(...args){super(...args);this.addEventListener('message',({data})=>{
    if(data?.ok&&data.result?.frames)window.__pairRaw=Promise.all(data.result.frames.map(async frame=>{
     const d=frame.description,bytes=d.yuv.bitDepth>8?2:1,rows=[];
     for(const p of d.yuv.planes)for(let y=0;y<p.height;y++)rows.push(frame.pixels.subarray(p.offset+y*p.stride,p.offset+y*p.stride+p.width*bytes));
     const packed=new Uint8Array(rows.reduce((n,row)=>n+row.length,0));let at=0;for(const row of rows){packed.set(row,at);at+=row.length;}
     return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',packed)),b=>b.toString(16).padStart(2,'0')).join('');
    }));
   });}
  };
 });
 const [page]=await Promise.all([linked.waitForEvent('popup'),link.click()]);
 await page.waitForFunction(()=>window.voidPlayerQualityPair?.getState().state==='ready'||window.voidPlayerQualityPair?.getState().state==='failed');
 const native=Buffer.from(sample.native,'base64'),frameBytes=native.length/2;
 const hashes=await page.evaluate(()=>window.__pairRaw);assert.deepEqual(hashes,[0,1].map(i=>createHash('sha256').update(native.subarray(i*frameBytes,(i+1)*frameBytes)).digest('hex')),'actual Worker original planes equal independently committed native FFmpeg frames');
 const state=await page.evaluate(()=>window.voidPlayerQualityPair.getState());assert.equal(state.state,'ready',JSON.stringify(state));
 linked.context().off('request',observe);
 assert.deepEqual(requests.filter(r=>new URL(r.url).pathname.startsWith('/api/quality/')),[],'view never reads a job or computes a score');
 assert.deepEqual(requests.filter(r=>new URL(r.url).pathname.endsWith('/frame-index')&&(r.method!=='GET'||new URL(r.url).searchParams.has('build'))),[],'view never builds or uploads an index');
 assert.deepEqual(requests.filter(r=>new URL(r.url).pathname.startsWith('/api/annotations/')&&r.method!=='GET'),[],'view never writes annotations');
 assert.deepEqual(state.evidence,evidence);assert.equal(state.presented.reference.sourceBinding.mediaId,state.presented.distorted.sourceBinding.mediaId,'same source retains two independent AUs');
 assert.notEqual(state.presented.reference.picture.au,state.presented.distorted.picture.au);assert.notEqual(state.presented.reference.sourcePtsUs,state.presented.distorted.sourcePtsUs);
 assert.ok(state.presented.reference.sourcePtsUs>0);assert.equal(state.presented.reference.sourcePtsUs,evidence.value.result.provenance.reference.sourcePtsUs);
 for(const side of ['reference','distorted']) {
  const p=evidence.value.result.provenance[side],actual=state.presented[side];assert.deepEqual(actual.picture,p.picture);assert.equal(actual.sourceBinding.indexBuildId,p.indexBuildId);assert.deepEqual(actual.sourceBinding.indexIdentity,p.indexIdentity);
 }
 async function checkRoi() {
  const result=await page.evaluate(()=>['reference','distorted'].map(side=>{
   const stage=document.querySelector(`[data-side=${side}]`),svg=stage.querySelector('svg'),rect=svg.querySelector('rect'),state=window.voidPlayerQualityPair.getState(),d=state.evidence.value.result.provenance[side].decoded.description,roi=state.evidence.value.result.metric.roi;
   const scale=Math.min(stage.clientWidth/d.width,stage.clientHeight/d.height),x=(stage.clientWidth-d.width*scale)/2+roi.x*scale,y=(stage.clientHeight-d.height*scale)/2+roi.y*scale;
   return {side,expected:{x,y,width:roi.width*scale,height:roi.height*scale},actual:Object.fromEntries(['x','y','width','height'].map(k=>[k,Number(rect.getAttribute(k))])),dpr:devicePixelRatio,surface:[...stage.querySelectorAll('canvas')].find(c=>c.classList.contains('frame-presentation'))?.width,cssWidth:stage.clientWidth};
  }));
  for(const r of result){for(const k of ['x','y','width','height'])assert.ok(Math.abs(r.actual[k]-r.expected[k])<.001,`${r.side} ROI ${k}`);assert.equal(r.surface,Math.round(r.cssWidth*r.dpr));}
 }
 await checkRoi();await page.setViewportSize({width:600,height:900});await page.waitForFunction(()=>document.querySelector('.quality-pair-views').clientWidth<600);await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));await checkRoi();
 await page.screenshot({path:`${process.env.VOIDPLAYER_TEST_ARTIFACTS??'.run/quality-annotation'}/pair-view-${engine}.png`});
 const resources=await page.evaluate(()=>window.voidPlayerQualityPair.resources());assert.ok(resources.totalBytes>0);assert.equal(resources.overBudgetBytes,0);
 await dialog.getByRole('button',{name:'Close',exact:true}).click();
 console.log(`PASS ${engine}: explicit shared-evidence pair viewer, actual unequal source PTS, same source/different AU, cache namespace/build, ROI/DPR/resize and GUI/Agent URL`);
 return {page,reference:{space,annotationId,evidenceId:evidence.id}};
}
export async function checkQualityPairFailures(pair,{base,headers,entry,service,mediaPath,writeFile}) {
 const {page,reference}=pair;
 const path=`**/api/annotations/spaces/${reference.space}/${reference.annotationId}`;
 let entered;const started=new Promise(r=>entered=r);let release;const gate=new Promise(r=>release=r);
 await page.route(path,async route=>{entered();await gate;await route.continue();});
 await page.evaluate(reference=>{window.__pairOpen=window.voidPlayerQualityPair.open(reference).then(()=>({ok:true}),error=>({ok:false,message:error.message}));},reference);await started;
 await page.getByRole('button',{name:'Cancel and release snapshots',exact:true}).click();release();
 const cancelled=await page.evaluate(()=>window.__pairOpen);assert.equal(cancelled.ok,false);assert.equal((await page.evaluate(()=>window.voidPlayerQualityPair.getState())).state,'cancelled');assert.equal((await page.evaluate(()=>window.voidPlayerQualityPair.resources())).totalBytes,0);await page.unroute(path);
 const clear=await fetch(base+'/api/admin/frame-indexes',{method:'DELETE',headers:{...headers,'x-voidplayer-action':'admin'}});assert.equal(clear.status,200);
 const missing=await page.evaluate(async r=>{try{await window.voidPlayerQualityPair.open(r);return null;}catch(error){return error.message;}},reference);assert.ok(missing);assert.equal((await page.evaluate(()=>window.voidPlayerQualityPair.getState())).state,'failed');assert.equal(await page.locator('.quality-pair-roi rect').count(),0);
 const index=await fetch(`${base}/api/media/${entry.id}/frame-index?v=${entry.version}`).then(r=>r.json());assert.equal(index.index,null,'viewer never rebuilds a missing cache');
 const built=await fetch(`${base}/api/media/${entry.id}/frame-index?v=${entry.version}&build=1`).then(r=>r.json());assert.ok(built.index,'test explicitly builds a replacement cache');
 const changed=await page.evaluate(async r=>{try{await window.voidPlayerQualityPair.open(r);return null;}catch(error){return error.message;}},reference);assert.match(changed,/changed/i);
 await writeFile(mediaPath,Buffer.from('source replaced'));await service.library.refresh();
 const version=await page.evaluate(async r=>{try{await window.voidPlayerQualityPair.open(r);return null;}catch(error){return error.message;}},reference);assert.ok(version);assert.equal((await page.evaluate(()=>window.voidPlayerQualityPair.getState())).state,'failed');assert.equal((await page.evaluate(()=>window.voidPlayerQualityPair.resources())).totalBytes,0);
 await page.close();console.log('PASS pair viewer: cancellation releases memory; missing/rebuilt cache and changed source version fail without old ROI or automatic rebuild');
}
