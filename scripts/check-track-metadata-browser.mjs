import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, webkit } from 'playwright';
import { createMediaServer } from '../server/app.ts';
import { MediaLibraryIndex } from '../server/library.ts';
import { saveBrowserFailure, recordBrowserEvidence } from './browser-failure-evidence.mjs';
const root=path.resolve(import.meta.dirname,'..'), engine=process.argv[2]??'chromium';
const temporary=await mkdtemp(path.join(tmpdir(),'voidplayer-track-metadata-')), media=path.join(temporary,'media');await mkdir(media);
const artifacts=path.join(root,'.run/track-metadata',engine);await mkdir(artifacts,{recursive:true});
const fixtures=[
 {name:'audio.mp4',format:'MP4',presence:'present',codec:'AAC-LC',channels:1,rate:48000},
 {name:'silent.mp4',format:'MP4',presence:'absent'},
 {name:'surround.mp4',format:'MP4',presence:'present',codec:'AAC-LC',channels:6,rate:48000},
 {name:'unsupported.mkv',format:'Matroska',presence:'present',codec:'AC-3',channels:1,rate:48000},
 {name:'audio.flv',format:'FLV',presence:'present',codec:'AAC-LC',channels:1,rate:48000},
 {name:'audio.ts',format:'MPEG-TS',presence:'present',codec:'AAC-LC',channels:1,rate:48000},
 {name:'audio.webm',format:'WebM',presence:'present',codec:'Opus',channels:1,rate:48000},
];
let browser,library,server,activePage,evidence;const reports=[];
try {
 for(const f of fixtures) execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=320x180:rate=30',
  ...(f.presence==='absent'?[]:['-f','lavfi','-i','sine=frequency=440:sample_rate=48000']),'-t','2',
  ...(f.name.endsWith('webm')?['-c:v','libvpx-vp9','-deadline','realtime','-cpu-used','8','-c:a','libopus']:['-c:v','libx264','-preset','ultrafast','-g','30','-bf','0','-c:a',f.name.startsWith('unsupported')?'ac3':'aac']),
  ...(f.channels===6?['-ac','6']:[]),'-y',path.join(media,f.name)]);
 library=new MediaLibraryIndex([media],{database:path.join(temporary,'library.sqlite'),watch:false});const listing=await library.list();
 let traffic=[];
 server=createMediaServer({roots:library.roots,library,staticDir:path.join(root,'dist'),onLog(){}});
 server.on('request',(req,res)=>{if(/^\/api\/media\/[a-f0-9]+(?:\?|$)/.test(req.url)&&!req.url.includes('index'))res.on('finish',()=>traffic.push({range:req.headers.range,bytes:Number(res.getHeader('content-length'))}));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.address().port}`;
 browser=await (engine==='webkit'?webkit:chromium).launch({headless:true,...(engine==='chromium'?{args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']}: {})});
 const tool=(page,name,input={})=>page.evaluate(({name,input})=>window.voidPlayer.tools.find(t=>t.name===name).execute(input),{name,input});
 for(const f of fixtures) for(const local of [false,true]) {
  const pair=[];
  // Warm the server-owned index before either measured run. A cold background
  // FLV index and its later cache hit are different video read plans.
  if (!local) {
    const warm=await browser.newPage();await warm.addInitScript(()=>localStorage.setItem('voidplayer.color-mode','browser'));
    await warm.goto(url);await warm.waitForFunction(()=>window.voidPlayer);
    await tool(warm,'load_library_item',{slot:'A',id:listing.entries.find(e=>e.name===f.name).id});
    await tool(warm,'seek_review',{ptsUs:1900000});
    await warm.waitForFunction(()=>window.voidPlayer.getState().tracks[0].indexState!=='building');await warm.close();
  }
  for(const open of [false,true]) {
   const context=await browser.newContext({viewport:{width:900,height:760},deviceScaleFactor:1,locale:'zh-CN',reducedMotion:'reduce'});const page=await context.newPage();activePage=page;evidence=recordBrowserEvidence(page);const errors=[];page.on('pageerror',e=>errors.push(e.message));
   await page.addInitScript(()=>{
    localStorage.setItem('voidplayer.color-mode','browser');localStorage.setItem('voidplayer.language','zh-CN');
    window.metadataEvidence={contexts:0,decoders:0,workers:0,workerUrls:[],blobReads:[]};
    for(const [key,counter] of [['AudioContext','contexts'],['AudioDecoder','decoders']])if(window[key]){const Native=window[key];window[key]=class extends Native{constructor(...args){super(...args);window.metadataEvidence[counter]++;}};}
    const NativeWorker=Worker;window.Worker=class extends NativeWorker{constructor(...args){super(...args);window.metadataEvidence.workers++;window.metadataEvidence.workerUrls.push(String(args[0]));this.addEventListener('message',e=>{if(e.data.type==='metadata-test-read')window.metadataEvidence.blobReads.push(e.data.read);});}};
   });
   await page.context().route(/\/assets\/(?:ffmpeg|packet)-worker-[^/]+\.js$/,async route=>{
    const response=await route.fetch();const prefix=`const spans=new WeakMap();const slice=Blob.prototype.slice;Blob.prototype.slice=function(start=0,end=this.size,...args){const part=slice.call(this,start,end,...args);spans.set(part,{offset:(spans.get(this)?.offset??0)+(start<0?Math.max(0,this.size+start):start),length:part.size});return part;};const report=blob=>self.postMessage({type:'metadata-test-read',read:spans.get(blob)??{offset:0,length:blob.size}});if(typeof FileReaderSync!=='undefined'){const Native=FileReaderSync;self.FileReaderSync=class extends Native{readAsArrayBuffer(blob){report(blob);return super.readAsArrayBuffer(blob);}}}const arrayBuffer=Blob.prototype.arrayBuffer;Blob.prototype.arrayBuffer=function(){report(this);return arrayBuffer.call(this);};\n`;
    await route.fulfill({response,body:prefix+await response.text()});
   });
   traffic=[];await page.goto(url);await page.waitForFunction(()=>window.voidPlayer);
   if(local){await page.locator('#file-A').setInputFiles(path.join(media,f.name));await page.waitForFunction(()=>window.voidPlayer.getState().tracks.length===1&&!window.voidPlayer.getState().busy);}
   else await tool(page,'load_library_item',{slot:'A',id:listing.entries.find(e=>e.name===f.name).id});
   await page.waitForFunction(()=>window.voidPlayer.getState().tracks[0].indexState!=='building');
   await page.locator('#toggle-subtracks').click();
   if(open){
    await page.evaluate(()=>{window.metadataDock={nodes:[...document.querySelectorAll('#subtrack-list *, #subtrack-ruler *')],offset:document.querySelector('.track-offset'),value:document.querySelector('.track-offset').value};window.metadataDock.offset.value='pending edit';});
    await page.locator('#toggle-inspector').click();
    await page.waitForFunction(({presence,channels,codec})=>{const m=window.voidPlayer.getState().tracks[0].trackMetadata;return m?.audio.presence===presence&&(!channels||m.audio.tracks[0]?.channels===channels)&&(!codec||m.audio.tracks[0]?.codec===codec);},f);
    assert.deepEqual(await page.evaluate(()=>({connected:window.metadataDock.nodes.every(n=>n.isConnected),sameInput:window.metadataDock.offset===document.querySelector('.track-offset'),value:window.metadataDock.offset.value})),{connected:true,sameInput:true,value:'pending edit'},'cached metadata preserves dock nodes and uncommitted input');
    await page.evaluate(()=>{window.metadataDock.offset.value=window.metadataDock.value;});
    const metadata=await page.evaluate(()=>window.voidPlayer.getState().tracks[0].trackMetadata);
    assert.equal(metadata.container,f.format);if(f.rate)assert.equal(metadata.audio.tracks[0].sampleRate,f.rate);
    assert.deepEqual(await page.locator('[data-metadata-group] h3').allTextContents(),['封装','视频','音频']);
    assert.equal(await page.locator('[data-frame-timing] dt').count(),4);
    if(f.channels===6)assert.match(await page.locator('[data-metadata-group=audio]').innerText(),/当前播放路径不支持/);
    const before=await page.evaluate(()=>({reads:window.metadataEvidence.blobReads,workers:window.metadataEvidence.workers,track:window.voidPlayer.getState().tracks[0].sourceGen})),beforeTraffic=structuredClone(traffic);
    await page.evaluate(()=>{window.metadataNodes=[...document.querySelectorAll('[data-metadata-group] dl')];});
    // A real peer-tab preference change must relabel the existing grouped nodes.
    const peer=await page.context().newPage();await peer.goto(url);await peer.evaluate(()=>localStorage.setItem('voidplayer.language','en'));await page.waitForFunction(()=>document.documentElement.lang==='en');
    assert.deepEqual(await page.locator('[data-metadata-group] h3').allTextContents(),['Container','Video','Audio']);
    assert.deepEqual(await page.locator('[data-frame-timing] dt').allTextContents(),['Clip PTS','Source PTS','Frame duration','Relative to playhead']);
    assert.equal(await page.evaluate(()=>window.metadataNodes.every((n,i)=>n===[...document.querySelectorAll('[data-metadata-group] dl')][i])),true);
    if(f.name==='surround.mp4'&&!local){await page.locator('#inspector-panel').screenshot({path:path.join(artifacts,'panel-en.png')});await page.locator('[data-metadata-group=audio]').scrollIntoViewIfNeeded();await page.locator('#inspector-panel').screenshot({path:path.join(artifacts,'panel-en-audio.png')});}
    await peer.evaluate(()=>localStorage.setItem('voidplayer.language','zh-CN'));await page.waitForFunction(()=>document.documentElement.lang==='zh-CN');await peer.close();
    for(let n=0;n<2;n++){await page.locator('#toggle-inspector').click();await page.locator('#toggle-inspector').click();}
    assert.deepEqual(await page.evaluate(()=>({reads:window.metadataEvidence.blobReads,workers:window.metadataEvidence.workers,track:window.voidPlayer.getState().tracks[0].sourceGen})),before);
    assert.deepEqual(traffic,beforeTraffic,'opening/closing/localizing metadata cannot read media');
    if(f.name==='surround.mp4'&&!local)await page.locator('#inspector-panel').screenshot({path:path.join(artifacts,'panel-zh.png')});
   }
   for(const ptsUs of [1000000,0,500000,1900000])await tool(page,'seek_review',{ptsUs});
   await tool(page,'seek_review',{ptsUs:0});await page.locator('#play').click();
   await page.waitForFunction(()=>{const s=window.voidPlayer.getState();return !s.playing&&s.positionUs>1800000;});
   const state=await tool(page,'get_review_session');assert.equal(state.audioSlot,null);assert.equal(state.error,null);assert.ok(state.tracks[0].frame,'actual decoded frame survives inspection and seeks');
   const observed=await page.evaluate(()=>window.metadataEvidence);assert.equal(observed.contexts,0);assert.equal(observed.decoders,0);assert.ok(observed.workerUrls.every(url=>!url.includes('cached-audio')&&!url.includes('metadata')),'no audio/metadata parser workers');assert.deepEqual(errors,[]);
   pair.push({open,traffic:structuredClone(traffic),...observed,metadata:state.tracks[0].trackMetadata});await context.close();
  }
  assert.deepEqual(pair[1].workerUrls,pair[0].workerUrls,'inspection preserves worker creation');
  assert.deepEqual(pair[1].traffic,pair[0].traffic,`${f.name}/${local}: HTTP read sequence`);assert.deepEqual(pair[1].blobReads,pair[0].blobReads,`${f.name}/${local}: Blob offset/length sequence`);
  assert.ok(local?pair[0].blobReads.length:pair[0].traffic.length,'real reads measured');reports.push({fixture:f.name,local,pair});console.log(`PASS ${engine} ${f.name} ${local?'local':'remote'}: metadata, mute, IO, workers, seek, reopen, i18n`);
 }
 await writeFile(path.join(artifacts,'results.json'),JSON.stringify(reports,null,2));
} catch(error){if(activePage)await saveBrowserFailure({page:activePage,directory:artifacts,name:engine,error,evidence});throw error;}
finally{await browser?.close();await new Promise(r=>server?server.close(r):r());library?.close();await rm(temporary,{recursive:true,force:true});}
