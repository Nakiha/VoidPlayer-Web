import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createServer} from 'vite';
import {chromium,webkit} from 'playwright';
const manifest=JSON.parse(await readFile(new URL('./fate-samples.json',import.meta.url))).filter(s=>/multi-stsd|4bf|brokensps|interlaced_crop/.test(s.file));
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
      const rows=await Promise.race([page.evaluate(async ({url,name,remote})=>{
        const {openMedia,openMediaFromUrl}=await import('/src/media.ts');
        const {paintFrame,setPresentationGeometry,disposePresentation}=await import('/src/presenter.ts');
        const bytes=await (await fetch(url)).arrayBuffer(), rows=[];
        for(let round=0;round<2;round++){
          let source;const row={round,phase:'open',frames:0,geometry:[]};
          try {
            source=await (remote?openMediaFromUrl(url,{name,size:bytes.byteLength,lastModified:0}):openMedia(new File([bytes],name)));
            row.info=structuredClone(source.info);row.phase='first';
            const canvas=document.querySelector('canvas'), first=await source.frameAt(0);paintFrame(canvas,first);first.close();
            setPresentationGeometry(canvas,{width:320,height:240,imageWidth:320,imageHeight:240,zoom:1,offsetX:0,offsetY:0,dpr:1});
            row.phase='index';await source.ensureIndexed?.();row.phase='play';
            for await(const frame of source.framesFrom(0)){
              row.frames++;const geometry=[frame.width,frame.height,frame.sample?.colorSpace?.transfer??null];
              if(JSON.stringify(row.geometry.at(-1))!==JSON.stringify(geometry))row.geometry.push(geometry);
              paintFrame(canvas,frame);frame.close();if(row.frames>500)throw new Error('audit frame limit');
            }
            row.phase='seek';for(const pts of [Math.floor(source.info.durationUs/2),0]){const f=await source.frameAt(pts);paintFrame(canvas,f);f.close();}
            row.phase='complete';
          }catch(e){row.error={message:e.message,stage:e.stage};}finally{source?.dispose();disposePresentation();}
          rows.push(row);
        }return rows;
      },{url:base+'/fixtures/fate/'+sample.file,name:sample.file,remote}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('case exceeded 45 seconds')),45000);})]);
      results.push({browser:browserName,sample:sample.path,remote,rows});
    }catch(e){results.push({browser:browserName,sample:sample.path,remote,error:e.message});}
    finally{clearTimeout(timer);await page.close();}
    await writeFile('.run/playback-reports/fate-browser-report.json',JSON.stringify(results,null,2)+'\n');
    console.log(JSON.stringify(results.at(-1)));
  }}finally{await browser.close();}
}
}finally{await server.close();}
