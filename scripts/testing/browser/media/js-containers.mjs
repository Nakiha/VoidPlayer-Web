import assert from 'node:assert/strict';
import path from 'node:path';
import {writeFile} from 'node:fs/promises';
import {withBrowserFixture} from '../../browser-fixture.mjs';
import {repositoryRoot} from '../../manifest.mjs';
import {verifyPlaybackPresentation} from '../../playback-presentation.mjs';

const engine=process.argv[2]??'webkit';
const filter=process.argv.find(x=>x.startsWith('--fixture='))?.slice('--fixture='.length);
const names=['h264.ts','hevc.ts','h264.mkv','hevc.mkv','hevc10.ts','hevc10.mkv','hevc-audio.mkv','vp8.webm','vp9.webm'];
assert.ok(!filter||names.includes(filter),'known focused fixture');
await withBrowserFixture({caseName:'js-containers',engine,timeoutMs:600000,roots:[path.join(repositoryRoot,'fixtures/js-container')]},async({page,ready,artifact})=>{
 const rows=[],errors=[],requests=[];page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>requests.push({url:r.url(),method:r.method()}));
 await page.addInitScript(()=>{window.__vpAnalysisQA=true;});
 // Product packet decoding must never reach any container-WASM open ABI,
 // including after native decode is unavailable. The independent Node oracle
 // is outside this browser path.
 await page.route('**/vendor/voidplayer-core/*.js*',async route=>{
  const response=await route.fetch(),body=await response.text();let changed=false;
  const wrapped=body.replace(/export\s+default\s+([\w$]+)\s*;/,(_,name)=>{changed=true;return `const originalDefault=${name};export default async options=>{const core=await originalDefault(options);for(const name of ['_vp_open','_vp_open_blob','_vp_open_range'])core[name]=()=>{throw new Error('Container WASM forbidden in admitted JS product route');};return core;};`;});
  assert.ok(changed,'actual core glue export is guarded');await route.fulfill({response,body:wrapped});
 });
 await ready();page.setDefaultTimeout(30000);
 if(await page.locator('#identity-welcome').isVisible().catch(()=>false))await page.locator('#identity-welcome [data-guest]').click();
 const call=(name,params={})=>page.evaluate(async({name,params})=>window.voidPlayer.tools.find(t=>t.name===name).execute(params),{name,params});
 const stable=()=>page.waitForFunction(()=>{const s=window.voidPlayer.getState();return !s.busy&&s.tracks.length&&s.tracks.every(t=>t.frame&&!t.failure);});
 const library=await call('list_library');const localPictures=new Map();
 for(const name of names.filter(n=>!filter||n===filter))for(const input of ['local','library'])for(const policy of ['software','browser']){
  if((await call('get_review_session')).tracks.length)await call('remove_review_track',{slot:'A'});
  await call('set_review_color_mode',{mode:policy==='software'?'reference':'browser'});
  if(policy==='software')await call('set_reference_decode',{decoder:'software',depth:2});
  const start=requests.length;
  if(input==='local')await page.locator('#file-A').setInputFiles(path.join(repositoryRoot,'fixtures/js-container',name));
  else {const entry=library.entries.find(e=>e.name===name);assert.ok(entry,`${name} indexed in media library`);await call('load_library_item',{id:entry.id,slot:'A'});}
  await stable();const state=await call('get_review_session'),track=state.tracks[0];assert.equal(state.error,null);assert.equal(track.indexKind,'packet-locators');
  assert.equal(track.indexIntegrity,'complete');assert.equal(track.codec,name.startsWith('hevc')?'hevc':name.split('.')[0]);
  if(policy==='software')assert.equal(track.decoder,'ffmpeg-wasm');
  if(input==='library'||policy==='browser'){assert.equal(track.jsIndexReused,true,'independent Worker reuses authenticated complete metadata');assert.equal(track.jsIndexPacketsScanned,0);}
  else {assert.equal(track.jsIndexReused,false);assert.equal(track.jsIndexPacketsScanned,600);}
  const first=await call('get_presented_frame',{slot:'A'});assert.ok(first.picture);assert.match(first.picture.stream,/mediabunny-1\.55\.7-(?:ts|matroska)-packets/);
  if(input==='local'){if(localPictures.has(name))assert.deepEqual(first.picture,localPictures.get(name),'decode backend changes preserve source/config/AU identity');else localPictures.set(name,first.picture);}
  await call('seek_review',{ptsUs:18_666_667});const token=await call('get_presented_frame',{slot:'A'});assert.ok(token.picture);assert.ok(token.normalizedMediaUs>18_000_000);
  const before=await call('get_review_session');let analysis;
  if(name.startsWith('h264')||name.startsWith('hevc')){
   analysis=await call('request_bitstream_analysis',{slot:'A'});assert.equal(analysis.confidence,'exact');assert.deepEqual(analysis.picture,token.picture);
  }else{
   try{await call('request_bitstream_analysis',{slot:'A'});}catch{}
   const unsupported=await call('get_bitstream_analysis_state',{slot:'A'});assert.equal(unsupported.reason?.code,'unsupported-codec');analysis={state:unsupported.state,reason:unsupported.reason};
  }
  const after=await call('get_review_session');assert.equal(after.positionUs,before.positionUs);assert.deepEqual((await call('get_presented_frame',{slot:'A'})).picture,token.picture,'analysis neither seeks nor changes the presented frame');
  if(name==='hevc.mkv'&&policy==='software'){
   const pending=await page.evaluate(async()=>{const tool=window.voidPlayer.tools.find(t=>t.name==='request_bitstream_range');window.__rangeSettled=false;window.__rangePromise=tool.execute({slot:'A',startUs:17_000_000,endUs:17_500_000}).catch(()=>null).finally(()=>window.__rangeSettled=true);await new Promise(resolve=>setTimeout(resolve,0));return !window.__rangeSettled;});
   assert.equal(pending,true,'cancel exercises an actually pending independent range');
   await call('cancel_bitstream_analysis',{slot:'A'});await page.evaluate(()=>window.__rangePromise);
   assert.equal((await call('get_review_session')).positionUs,before.positionUs);assert.deepEqual((await call('get_presented_frame',{slot:'A'})).picture,token.picture,'cancel cannot change playback cursor or committed frame');
  }
  if(input==='local')assert.equal(requests.slice(start).some(r=>r.method==='POST'&&/bitstream-analysis/.test(r.url)),false,'local analysis never uploads media');
  await call('seek_review',{ptsUs:0});const presentation=await verifyPlaybackPresentation(page,{}, {engine,caseName:`js-${name}-${input}-${policy}`,targetPtsUs:0});
  rows.push({name,input,policy,decoder:track.decoder,hardwareAcceleration:track.hardwareAcceleration,hardwareUseVerified:false,indexSource:track.indexSource,indexReused:track.jsIndexReused,indexPacketsScanned:track.jsIndexPacketsScanned,picture:token.picture,analysis,presentation});
  await writeFile(artifact('matrix.json'),JSON.stringify({engine,rows,errors},null,2));
 }
 // Persisted receipt validation runs in a new source Worker after a full page
 // reload. A self-consistent dropped/renumbered row cannot authorize reuse.
 const name=filter??'hevc.mkv';
 await call('remove_review_track',{slot:'A'});
 await page.evaluate(async()=>{const db=await new Promise((ok,bad)=>{const r=indexedDB.open('voidplayer-js-packet-index-v1',1);r.onsuccess=()=>ok(r.result);r.onerror=()=>bad(r.error);});
  try{await new Promise((ok,bad)=>{const tx=db.transaction('indexes','readwrite'),s=tx.objectStore('indexes'),cursor=s.openCursor();cursor.onsuccess=()=>{const c=cursor.result;if(!c)return;const record=c.value,d=JSON.parse(record.payload);d.packets.splice(2,1);d.packets.forEach((p,i)=>p.au=i);d.completeness.packets=d.packets.length;record.payload=JSON.stringify(d);c.update(record);c.continue();};tx.oncomplete=ok;tx.onerror=()=>bad(tx.error);});}finally{db.close();}});
 await page.reload();await page.waitForFunction(()=>window.voidPlayer?.tools);
 await page.locator('#file-A').setInputFiles(path.join(repositoryRoot,'fixtures/js-container',name));await stable();
 let restored=(await call('get_review_session')).tracks[0];assert.equal(restored.jsIndexReused,false);assert.equal(restored.jsIndexPacketsScanned,600,'invalid persisted receipt rebuilds actual EOF coverage');
 await call('remove_review_track',{slot:'A'});await page.reload();await page.waitForFunction(()=>window.voidPlayer?.tools);
 await page.locator('#file-A').setInputFiles(path.join(repositoryRoot,'fixtures/js-container',name));await stable();restored=(await call('get_review_session')).tracks[0];assert.equal(restored.jsIndexReused,true);assert.equal(restored.jsIndexPacketsScanned,0,'complete rebuilt index survives page and Worker restarts');
 assert.deepEqual(errors,[]);await writeFile(artifact('matrix.json'),JSON.stringify({engine,rows,errors,persistence:{corruptRebuilt:true,freshRuntimeReused:true}},null,2));
 console.log(`PASS ${engine}: ${rows.length} actual JS-container local/library decoder/analysis cases plus corrupt-cache rebuild and fresh-runtime reuse; hardware use not inferred`);
});
