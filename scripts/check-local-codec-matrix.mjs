// Local, serial codec/path smoke and playback matrix. No uploads or persistent service changes.
import {chromium,webkit} from 'playwright';
import {createMediaServer} from '../server/app.ts';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const source=process.argv[2];if(!source)throw Error('Usage: node scripts/check-local-codec-matrix.mjs /path/to/video [report-directory]');
const out=path.resolve(process.argv[3]??'artifacts/local-codecs');await mkdir(out,{recursive:true});
const available=['h264_9s_1920x1080.mp4','h264_high422p_1s_320x180.mp4','h265_10s_1920x1080.mp4','mhw_hevc_fullrange_bt709_3s.mp4','mhw_x265_aq_qg16_4s_1920x1080.mkv','h266_10s_1920x1080.mp4','vp9_10s_1920x1080.webm','av1_10s_1920x1080.webm','mpeg2_10s_1280x720.ts','ffv1_yuv422p_8bit.mkv','ffv1_yuv422p10le.mkv','ffv1_yuv444p10le.mkv'];
const selected=(process.env.CODEC_FILES?process.env.CODEC_FILES.split(','):available).flatMap(name=>Array.from({length:Number(process.env.CODEC_REPEATS??1)},()=>name));
const modes=[['browser','software'],['reference','software'],['reference','hardware']].filter(pair=>!process.env.CODEC_MODE||pair.join('/')===process.env.CODEC_MODE);
const engines=[['chromium',chromium],['webkit',webkit]].filter(([name])=>!process.env.CODEC_BROWSER||name===process.env.CODEC_BROWSER);
const total=selected.length*modes.length*engines.length;
if(!total)throw Error('No matching cases');
const report={date:new Date().toISOString(),source:path.resolve(source),environment:{platform:os.platform(),release:os.release(),arch:os.arch(),cpu:os.cpus()[0]?.model},headless:false,results:[]};
const server=createMediaServer({roots:[path.resolve(source)],staticDir:path.resolve('dist'),onLog(){}});await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${server.address().port}`;
try{
 for(const [engineName,engine] of engines){
  const browser=await engine.launch({headless:false});
  try{for(const name of selected)for(const [mode,decoder]of modes){
   const page=await browser.newPage({viewport:{width:1280,height:800}}),errors=[];
   page.on('pageerror',e=>errors.push(e.message));
   await page.addInitScript(({mode,decoder})=>{localStorage.setItem('voidplayer.color-mode',mode);localStorage.setItem('voidplayer.reference-decode',JSON.stringify({decoder,depth:2}));},{mode,decoder});
   const row={browser:engineName,version:browser.version(),name,mode,preference:decoder};let timer;
   try{
    await Promise.race([(async()=>{
     await page.goto(base);await page.bringToFront();await page.waitForFunction(()=>window.voidPlayer);
     const result=await page.evaluate(async(name)=>{
      const call=(n,args={})=>window.voidPlayer.tools.find(t=>t.name===n).execute(args);
      const library=await call('list_library'),item=library.entries?.find(e=>e.name===name);if(!item)throw Error('Missing sample');
      const started=performance.now();await call('load_library_item',{id:item.id,slot:'A'});
      const initial=await call('get_review_session'),duration=initial.durationUs,seeks=[];
      const loadMs=performance.now()-started;
      for(const ratio of [.65,.15]){
       const ptsUs=Math.floor(duration*ratio);await call('seek_review',{ptsUs});
       const state=await call('get_review_session');const frame=state.tracks[0]?.frame;
       if(state.error||!frame)throw Error(state.error??'Seek produced no frame');
       if(Math.abs(frame.ptsUs-ptsUs)>Math.max(100000,frame.durationUs??0))throw Error(`Seek mismatch ${ptsUs}/${frame.ptsUs}`);
       seeks.push({requested:ptsUs,frame:frame.ptsUs});
      }
      const benchmark=duration>=1200000?await call('benchmark_review',{durationMs:1500}):null;
      const logs=await call('get_review_logs');
      return {loadMs,initial,seeks,benchmark,decisions:logs.events.filter(e=>/回退|不可用|失败|核对|WebCodecs/.test(e.msg)).map(e=>({msg:e.msg,data:e.data}))};
     },name);
     Object.assign(row,result);row.functional=true;
     if(name==='h264_9s_1920x1080.mp4'&&mode==='browser')await page.locator('.screens').screenshot({path:path.join(out,`${engineName}-h264.png`)});
    })(),new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('Case timed out after 60 seconds')),60000))]);
   }catch(e){row.functional=false;row.error=String(e.message??e);}
   finally{clearTimeout(timer);row.pageErrors=errors;await page.close();}
   report.results.push(row);await writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));
   console.log(`${report.results.length}/${total} ${engineName} ${name} ${mode}/${decoder}: ${row.functional?'LOAD+SEEK OK':'FAIL '+row.error} ${row.initial?.tracks[0]?.decoder??''} ${row.benchmark?`play=${row.benchmark.passed?'PASS':'FAIL'} speed=${row.benchmark.measurements?.speed?.toFixed(2)} ${row.benchmark.failures?.join(',')}`:''}`);
  }}finally{await browser.close();}
 }
}finally{await new Promise(r=>server.close(r));}
console.log(`Report: ${out}/report.json`);
