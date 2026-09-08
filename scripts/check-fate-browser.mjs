import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {createServer} from 'vite';
import {chromium,webkit} from 'playwright';
import {classify} from './fate-oracle.ts';
const manifest=JSON.parse(await readFile(new URL('./fate-samples.json',import.meta.url))).filter(s=>/multi-stsd|4bf|brokensps|interlaced_crop/.test(s.file));
const reference=JSON.parse(await readFile(new URL('./fate-reference.json',import.meta.url)));
const expectations=JSON.parse(await readFile(new URL('./fate-expectations.json',import.meta.url)));
for(const sample of manifest)assert.equal(createHash('sha256').update(await readFile(new URL('../fixtures/fate/'+sample.file,import.meta.url))).digest('hex'),reference.samples[sample.path].sha256);
const server=await createServer({server:{host:'127.0.0.1',port:0,headers:{'Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp'}}});
await server.listen();const base=`http://127.0.0.1:${server.httpServer.address().port}`, results=[];
await mkdir('.run/playback-reports',{recursive:true});
try {
for(const [browserName,engine] of Object.entries({chromium,webkit})){
  const browser=await engine.launch({headless:true});
  try {for(const sample of manifest)for(const remote of [false,true]){
    const page=await browser.newPage();let timer;
    try {
      await page.route('**/fate-test',r=>r.fulfill({contentType:'text/html',body:'<div class="frame-stage"><canvas id="source"></canvas></div>'}));
      await page.goto(base+'/fate-test');
      const rows=await Promise.race([page.evaluate(async ({url,name,remote,ref})=>{
        const {openMedia,openMediaFromUrl}=await import('/src/media.ts');
        const {paintFrame,captureFrame,setPresentationGeometry,disposePresentation}=await import('/src/presenter.ts');
        const {pixelSignature,checkFrame,checkSequence,expectedAt}=await import('/scripts/fate-oracle.ts');
        const bytes=await (await fetch(url)).arrayBuffer(), rows=[];
        for(let round=0;round<2;round++){
          let source;const row={round,phase:'open',frames:[],seeks:[],failures:[]};
          try {
            source=await (remote?openMediaFromUrl(url,{name,size:bytes.byteLength,lastModified:0}):openMedia(new File([bytes],name)));
            row.info=structuredClone(source.info);row.phase='first';
            const canvas=document.querySelector('canvas');
            const observe=frame=>{
              paintFrame(canvas,frame);const image=captureFrame(canvas);
              const pixels=image.getContext('2d').getImageData(0,0,image.width,image.height).data;
              return {ptsUs:frame.ptsUs,width:frame.width,height:frame.height,bytes:frame.pixels?.byteLength,signature:pixelSignature(pixels,image.width,image.height)};
            };
            const first=await source.frameAt(0);try{row.failures.push(...checkFrame(observe(first),ref.frames[0],'first'));}finally{first.close();}
            setPresentationGeometry(canvas,{width:320,height:240,imageWidth:320,imageHeight:240,zoom:1,offsetX:0,offsetY:0,dpr:1});
            row.phase='index';await source.ensureIndexed?.();row.phase='play';
            for await(const frame of source.framesFrom(0)){
              try{row.frames.push(observe(frame));}finally{frame.close();}
              if(row.frames.length>500)throw new Error('audit frame limit');
            }
            row.failures.push(...checkSequence(row.frames,ref.frames));
            row.phase='seek';for(const pts of [Math.floor(source.info.durationUs/2),Math.max(0,source.info.durationUs-1),0]){
              const f=await source.frameAt(pts);try{const actual=observe(f);row.seeks.push({requested:pts,...actual});row.failures.push(...checkFrame(actual,expectedAt(ref.frames,pts),`seek ${pts}`));}finally{f.close();}
            }
            row.phase='complete';
          }catch(e){row.error={message:e.message,stage:e.stage};row.failures.push({code:`${row.phase}:${e.stage??'decode'}`,detail:e.message});}finally{source?.dispose();disposePresentation();}
          rows.push(row);
        }return rows;
      },{url:base+'/fixtures/fate/'+sample.file,name:sample.file,remote,ref:reference.samples[sample.path]}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('case exceeded 60 seconds')),60000);})]);
      for(const row of rows)row.status=classify(row.failures,expectations.browser[sample.path]?.[browserName+'/'+(remote?'http':'local')]??{});
      results.push({browser:browserName,sample:sample.path,remote,rows});
      console.log(JSON.stringify({browser:browserName,sample:sample.path,remote,rows:rows.map(r=>({status:r.status,frames:r.frames.length,failures:r.failures}))}));
    }catch(e){results.push({browser:browserName,sample:sample.path,remote,error:e.message});}
    finally{clearTimeout(timer);await page.close();}
    await writeFile('.run/playback-reports/fate-browser-report.json',JSON.stringify(results,null,2)+'\n');
  }}finally{await browser.close();}
}
}finally{await server.close();}
if(results.some(r=>r.error||r.rows.some(row=>row.status==='fail'))&&!process.argv.includes('--report-only'))process.exitCode=1;
