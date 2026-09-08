// Exploratory compatibility audit. Failures remain failures in the report;
// --report-only records known design gaps without treating them as passes.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createServer} from 'vite';
import {webkit,chromium} from 'playwright';
import {openFFmpegMedia} from '../src/ffmpeg-media.ts';
import {pixelSignature,checkSequence,checkFrame,expectedAt} from './fate-oracle.ts';
const official=JSON.parse(await readFile(new URL('./fate-timestamp-samples.json',import.meta.url)));
const derived=JSON.parse(await readFile(new URL('../fixtures/fate/timestamps/manifest.json',import.meta.url)));
const report={method:'Native FFmpeg display-order frames and RGB regional means; raw timing retained, faults never auto-relabelled as passes',samples:[],runs:[]};
const data=new Map(),refs=new Map();
await mkdir('.run/playback-reports',{recursive:true});
const save=()=>writeFile('.run/playback-reports/timestamp-corpus.json',JSON.stringify(report,null,2)+'\n');
for(const item of [...official,...derived]){
  const path=new URL('../fixtures/fate/'+item.file,import.meta.url),bytes=await readFile(path);
  if(createHash('sha256').update(bytes).digest('hex')!==item.sha256)throw Error('Fixture checksum mismatch: '+item.file);
  data.set('/timestamp-fixture/'+item.file,bytes);
  const native=JSON.parse(execFileSync('ffprobe',['-v','quiet','-select_streams','v:0','-show_frames','-show_packets','-show_entries','packet=pts_time,dts_time:frame=best_effort_timestamp_time,width,height','-of','json',path.pathname],{maxBuffer:16*1024*1024}));
  const frames=native.packets_and_frames.filter(f=>f.type==='frame'),packets=native.packets_and_frames.filter(f=>f.type==='packet');
  const first=frames.length?Math.round(Number(frames[0].best_effort_timestamp_time)*1e6):0;
  let rgb=Buffer.alloc(0),referenceError;
  if(frames.length)try{rgb=execFileSync('ffmpeg',['-v','fatal','-i',path.pathname,'-map','0:v:0','-vf','scale=64:64:flags=area','-fps_mode','passthrough','-pix_fmt','rgb24','-f','rawvideo','pipe:1'],{maxBuffer:32*1024*1024});}catch(e){referenceError=String(e.message);}
  const reference=frames.map((f,i)=>({ptsUs:Math.round(Number(f.best_effort_timestamp_time)*1e6)-first,width:f.width,height:f.height,
    ...(rgb.length===frames.length*64*64*3?{signature:pixelSignature(rgb.subarray(i*64*64*3,(i+1)*64*64*3),64,64,3)}:{})}));
  refs.set(item.file,reference);
  report.samples.push({...item,referenceError,referenceFrames:frames.length,referencePixels:rgb.length===frames.length*64*64*3&&frames.length>0,
    packetDtsRegressions:packets.filter((p,i)=>i&&Number(p.dts_time)<Number(packets[i-1].dts_time)).length,
    outputRegressions:reference.filter((f,i)=>i&&f.ptsUs<=reference[i-1].ptsUs).length,
    outputMaxGapUs:reference.length>1?Math.max(...reference.slice(1).map((f,i)=>f.ptsUs-reference[i].ptsUs)):null});
}
const deps={glueURL:new URL('../public/vendor/voidplayer-core/voidplayer-core.js',import.meta.url).href,wasmBinary:await readFile(new URL('../public/vendor/voidplayer-core/voidplayer-core.wasm',import.meta.url))};
for(const item of [...official,...derived]){
  const row={file:item.file,backend:'node-wasm-container',frames:[],failures:[],phase:'open'},ref=refs.get(item.file);let source;
  const observe=f=>({ptsUs:f.ptsUs,width:f.width,height:f.height,signature:pixelSignature(f.pixels,f.width,f.height)});
  try{
    source=await openFFmpegMedia(new File([data.get('/timestamp-fixture/'+item.file)],item.file),deps);row.info=structuredClone(source.info);row.phase='play';
    for await(const frame of source.framesFrom(0)){try{row.frames.push(observe(frame));}finally{frame.close();}if(row.frames.length>1000)throw Error('frame bound exceeded');}
    row.failures.push(...checkSequence(row.frames,ref));row.phase='seek';
    if(ref.length)for(const time of [0,Math.floor(source.info.durationUs/2),source.info.durationUs-1,0]){const f=await source.frameAt(time);try{row.failures.push(...checkFrame(observe(f),expectedAt(ref,time),'seek'));}finally{f.close();}}
    row.phase='complete';
  }catch(e){row.failures.push({code:`${row.phase}:${e.stage??'decode'}`,detail:e.message});}finally{source?.dispose();}
  row.status=row.failures.length?'fail':'pass';report.runs.push(row);console.log(JSON.stringify({file:row.file,backend:row.backend,status:row.status,count:row.frames.length,failures:row.failures.slice(0,3)}));await save();
}
if(!process.argv.includes('--node-only')){
const server=await createServer({plugins:[{name:'timestamp-fixtures',configureServer(server){server.middlewares.use((req,res,next)=>{
  const bytes=data.get(req.url?.split('?')[0]);if(!bytes)return next();const range=/^bytes=(\d+)-(\d*)$/.exec(req.headers.range??'');
  const start=range?Number(range[1]):0,end=range?Math.min(Number(range[2]||bytes.length-1),bytes.length-1):bytes.length-1;
  if(start>end||start>=bytes.length){res.statusCode=416;res.end();return;}
  res.statusCode=range?206:200;res.setHeader('Content-Type','video/mp2t');res.setHeader('Accept-Ranges','bytes');res.setHeader('Content-Length',end-start+1);
  if(range)res.setHeader('Content-Range',`bytes ${start}-${end}/${bytes.length}`);res.end(bytes.subarray(start,end+1));
});}}],server:{host:'127.0.0.1',port:0,headers:{'Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp'}}});
await server.listen();const base=`http://127.0.0.1:${server.httpServer.address().port}`;
try{for(const [browserName,engine] of Object.entries({webkit,chromium})){
  const browser=await engine.launch({headless:true});
  try{for(const item of [...official,...derived])for(const remote of [false,true]){
    const page=await browser.newPage();let timer;
    try{
      await page.route('**/timestamp-audit',r=>r.fulfill({contentType:'text/html',headers:{'Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp'},body:'<canvas></canvas>'}));await page.goto(base+'/timestamp-audit');
      const rows=await Promise.race([page.evaluate(async({file,remote,ref})=>{
        const {openMedia,openMediaFromUrl}=await import('/src/media.ts');
        const {paintFrame,captureFrame,disposePresentation}=await import('/src/presenter.ts');
        const {pixelSignature,checkSequence,checkFrame,expectedAt}=await import('/scripts/fate-oracle.ts');
        const url=new URL('/timestamp-fixture/'+file,location.href).href,bytes=await(await fetch(url)).arrayBuffer(),rows=[];
        for(let round=0;round<2;round++){
          const row={round,frames:[],failures:[],phase:'open',environment:{crossOriginIsolated:globalThis.crossOriginIsolated,sharedArrayBuffer:typeof SharedArrayBuffer!=='undefined',secureContext:globalThis.isSecureContext}};let source;
          const observe=f=>{const c=document.querySelector('canvas');paintFrame(c,f);const image=captureFrame(c);return{ptsUs:f.ptsUs,width:f.width,height:f.height,signature:pixelSignature(image.getContext('2d').getImageData(0,0,image.width,image.height).data,image.width,image.height)};};
          try{
            source=await(remote?openMediaFromUrl(url,{name:file,size:bytes.byteLength,lastModified:0}):openMedia(new File([bytes],file)));row.info=structuredClone(source.info);row.phase='play';
            for await(const f of source.framesFrom(0)){try{row.frames.push(observe(f));}finally{f.close();}if(row.frames.length>1000)throw Error('frame bound exceeded');}
            row.failures.push(...checkSequence(row.frames,ref));row.phase='seek';
            if(ref.length)for(const time of [0,Math.floor(source.info.durationUs/2),source.info.durationUs-1,0]){const f=await source.frameAt(time);try{row.failures.push(...checkFrame(observe(f),expectedAt(ref,time),'seek'));}finally{f.close();}}
            row.phase='complete';
          }catch(e){row.failures.push({code:`${row.phase}:${e.stage??'decode'}`,detail:e.message});}finally{source?.dispose();disposePresentation();}
          row.status=row.failures.some(f=>f.code==='open:resource'&&/跨源隔离/.test(f.detail))&&(!row.environment.crossOriginIsolated||!row.environment.sharedArrayBuffer)?'environment-blocked':row.failures.length?'fail':'pass';rows.push(row);
        }return rows;
      },{file:item.file,remote,ref:refs.get(item.file)}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('audit case timeout')),60000);})]);
      for(const row of rows){report.runs.push({file:item.file,backend:browserName,remote,...row});console.log(JSON.stringify({file:item.file,backend:browserName,remote,round:row.round,status:row.status,count:row.frames.length,failures:row.failures.slice(0,2)}));}
    }catch(e){report.runs.push({file:item.file,backend:browserName,remote,status:'fail',failures:[{code:'timeout-or-page',detail:e.message}]});}
    finally{clearTimeout(timer);await page.close();await save();}
  }}finally{await browser.close();}
}}finally{await server.close();}
}
await save();
console.log(JSON.stringify({pass:report.runs.filter(r=>r.status==='pass').length,fail:report.runs.filter(r=>r.status==='fail').length,environmentBlocked:report.runs.filter(r=>r.status==='environment-blocked').length}));
if(report.runs.some(r=>r.status==='fail')&&!process.argv.includes('--report-only'))process.exitCode=1;
