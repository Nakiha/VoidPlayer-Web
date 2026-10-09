import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { withBrowserFixture } from '../../browser-fixture.mjs';
import { repositoryRoot } from '../../manifest.mjs';

const engine=process.argv[2]??'webkit';
await mkdir(path.join(repositoryRoot,'.run'),{recursive:true});
const root=await mkdtemp(path.join(repositoryRoot,'.run/hdr-playback-fixtures-'));
try{
for(const [name,transfer] of [['pq',16],['hlg',18],['sdr',1]]){
 const hdr=name!=='sdr',file=path.join(root,`${name}.mp4`);
 execFileSync('ffmpeg',['-y','-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=128x72:rate=30:duration=2',
   '-an','-c:v',hdr?'libx265':'libx264','-pix_fmt',hdr?'yuv420p10le':'yuv420p','-g','30',
   ...(hdr?['-x265-params',`pools=1:frame-threads=1:log-level=error:colorprim=9:transfer=${transfer}:colormatrix=9:range=limited`]:['-x264-params','colorprim=bt709:transfer=bt709:colormatrix=bt709']),file]);
 const info=JSON.parse(execFileSync('ffprobe',['-v','error','-select_streams','v:0','-show_entries','stream=pix_fmt,color_transfer,color_space,color_primaries','-of','json',file],{encoding:'utf8'})).streams[0];
 assert.equal(info.color_transfer,hdr?(name==='pq'?'smpte2084':'arib-std-b67'):'bt709');
 if(hdr){assert.equal(info.pix_fmt,'yuv420p10le');assert.equal(info.color_space,'bt2020nc');}
}
await withBrowserFixture({caseName:'hdr-playback',engine,roots:[root]},async({page,ready,artifact})=>{
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{
   localStorage.setItem('voidplayer.color-mode','reference');
   localStorage.setItem('voidplayer.reference-decode',JSON.stringify({decoder:'software',depth:2}));
 });
 await ready();
 const call=(name,params={})=>page.evaluate(async({name,params})=>window.voidPlayer.tools.find(t=>t.name===name).execute(params),{name,params});
 const state=()=>call('get_review_session');
 const stable=async()=>{await page.waitForFunction(()=>{const s=window.voidPlayer.tools.find(t=>t.name==='get_review_session').execute({});return !s.busy&&s.tracks.length>0&&s.tracks.every(t=>t.frame&&!t.failure);});};
 let pictureIndex=0;
 const picture=async()=>{await stable();await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));const box=await page.locator('#stage-A').boundingBox();// Crop out overlay controls: their antialiased progress pixels can change while paused.
 const bytes=await page.screenshot({animations:'disabled',clip:{x:box.x+16,y:box.y+64,width:box.width-32,height:box.height-128}});await writeFile(artifact(`picture-${++pictureIndex}.png`),bytes);await writeFile(artifact(`picture-${pictureIndex}.json`),JSON.stringify({state:await state(),box:await page.locator('#stage-A').boundingBox()},null,2));return createHash('sha256').update(bytes).digest('hex');};
 const rows=[];
 // The file chooser exercises the local MP4 packet path independently of library Range.
 for(const transfer of ['pq','hlg']){
   await page.locator('#file-A').setInputFiles(path.join(root,`${transfer}.mp4`));await stable();
   // Complete the asynchronous GPU startup before comparing repeatable viewport pixels.
   await call('set_review_color_output',{target:'hdr',peakNits:1000});await call('set_review_color_output',{target:'sdr',peakNits:1000});
   let s=await state(),track=s.tracks[0];assert.equal(track.decoder,'ffmpeg-wasm');assert.equal(track.output.yuv.bitDepth,10);
   assert.ok(['pq','smpte2084','hlg','arib-std-b67'].includes(track.output.color.transfer));
   assert.equal(track.presentation.actualTarget,'sdr');assert.equal(track.presentation.captureTarget,'sdr');
   await call('seek_review',{ptsUs:0});const baseline=await picture();await call('seek_review',{ptsUs:1000000});const later=await picture();assert.notEqual(later,baseline,'changing decoded pictures reach the presenter');
   await call('step_review',{direction:1});const stepped=(await state()).tracks[0].frame.ptsUs;assert.ok(stepped>1000000);
   await call('seek_review',{ptsUs:0});assert.equal(await picture(),baseline,'seek restores the same HDR preview pixels');
   await call('set_review_color_output',{target:'sdr',peakNits:4000});const remapped=await picture();assert.notEqual(remapped,baseline,'explicit peak changes actual preview pixels');
   await call('set_review_color_output',{target:'sdr',peakNits:1000});assert.equal(await picture(),baseline,'restoring policy restores pixels');
   const report=await call('benchmark_review',{durationMs:1000});assert.equal(report.error,null);assert.equal(report.staleAfterPause,false);assert.ok(report.measurements.tracks.A.drawn>0,'playback draws real frames');
   await call('seek_review',{ptsUs:1999999});assert.ok((await state()).tracks[0].frame.ptsUs>1800000,'tail remains readable');
   rows.push({transfer,baseline,stepped,report});
 }
 // Mixed HDR/SDR library tracks, saved comparison conditions, and transactional restore.
 await call('remove_review_track',{slot:'A'});
 const lib=await call('list_library');
 for(const [slot,name] of [['A','pq.mp4'],['B','sdr.mp4']])await call('load_library_item',{slot,id:lib.entries.find(e=>e.name===name).id});
 await stable();await call('seek_review',{ptsUs:500000});
 await call('set_review_color_output',{target:'hdr',peakNits:2000,hdrWhiteNits:250});
 const snapshot=await call('export_workspace');assert.equal(snapshot.comparison.version,2);assert.equal(snapshot.comparison.colorOutput.hdrWhiteNits,250);
 const before=(await state()).tracks.map(t=>({id:t.id,frame:t.frame}));
 await call('set_review_color_output',{target:'sdr',peakNits:1000});await call('import_workspace',{document:snapshot});await stable();
 const restored=await state();assert.deepEqual(restored.tracks.map(t=>({id:t.id,frame:t.frame})),before);assert.deepEqual(restored.colorOutput,snapshot.comparison.colorOutput);
 // Request is retained even when this headless SDR environment cannot activate extended output.
 assert.ok(restored.tracks.every(t=>t.presentation.requestedTarget==='hdr'&&t.presentation.captureTarget==='sdr'));
 await call('set_reference_decode',{decoder:'hardware',depth:2});const hardware=await state();for(const track of hardware.tracks.filter(t=>t.color.transfer==='pq')){assert.ok(track.output.yuv.bitDepth>=10);assert.equal(track.output.color.primaries,'bt2020');assert.ok(['webcodecs','ffmpeg-wasm'].includes(track.decoder));}
 await call('set_review_color_mode',{mode:'browser'});const browser=await state();for(const track of browser.tracks){assert.equal(track.presentation.captureTarget,'sdr');if(['pq','smpte2084','hlg','arib-std-b67'].includes(track.color?.transfer)&&!['pq','smpte2084','hlg','arib-std-b67'].includes(track.output.color.transfer)&&!track.output.yuv){assert.equal(track.presentation.actualTarget,'sdr');assert.equal(track.presentation.fallbackReason,'native-hdr-resource-unverified');}}
 await page.locator('#settings-open').click();await page.locator('#settings-tab-performance').click();assert.match(await page.locator('#color-output-description').innerText(),/SDR.*(自有色彩|HDR 显示目标)/);
 assert.deepEqual(errors,[]);
 await writeFile(artifact('hdr-playback.json'),JSON.stringify({engine,rows,comparison:snapshot.comparison,actualTargets:restored.tracks.map(t=>t.presentation),hardware:hardware.tracks.map(t=>({decoder:t.decoder,output:t.output,presentation:t.presentation}))},null,2));
 console.log(`PASS ${engine}: real PQ/HLG 10-bit local and Range decode, seek/step/tail, peak changes, mixed SDR, playback, v2 workspace restore and browser downgrade`);
});

}finally{await rm(root,{recursive:true,force:true});}
