import path from 'node:path';
import { withBrowserFixture } from '../browser-fixture.mjs';
import { repositoryRoot } from '../manifest.mjs';
import { prepareAnalysisFixtures } from './fixtures.mjs';
import { createAnalysisControls } from './controls.mjs';
import { analysisResponsibilities } from './plan.mjs';
import { snapshotBuild } from '../build.mjs';

export async function withAnalysisFixture(options, run) {
  const {engine, scenario, matrixPart, desktopPerformance} = options;
  let limitsDir, staticDir, referenceFixtures, gatedId, releaseIndexGate = true, heldBatches = 0;
  const indexGateWaiters = new Set();
  const releaseGate=()=>{releaseIndexGate=true;for(const resolve of indexGateWaiters)resolve();indexGateWaiters.clear();};
  const gate={hold(id){gatedId=id;releaseIndexGate=false;heldBatches=0;},release:releaseGate,get heldBatches(){return heldBatches;}};
  const matrixCase='bitstream-analysis-matrix'+(matrixPart?'-'+matrixPart:'')+(desktopPerformance?'-desktop':'');
  const name=scenario==='matrix'?matrixCase:'bitstream-analysis-'+(scenario==='overlay'?'layout':scenario);
  const roots=scenario==='matrix'?['fixtures/video','fixtures/flv-analysis','fixtures/fmp4-analysis','fixtures/ts-analysis'].map(file=>path.join(repositoryRoot,file)):[];
  return withBrowserFixture({caseName:name,engine,roots,signal:options.signal,pageOptions:{deviceScaleFactor:2},
    ...(desktopPerformance?{launchOptions:{headless:false}}:{}),
    timeoutMs:['layout','overlay'].includes(scenario)?300000:600000,
    dependencies:{async startService({temp,roots,defer}) {
      limitsDir=path.join(temp,'media');
      staticDir=await snapshotBuild(options.staticDir ?? path.join(repositoryRoot,'dist'),path.join(temp,'static'));
      referenceFixtures=await prepareAnalysisFixtures(limitsDir,analysisResponsibilities[scenario].fixtures);
      roots=[...roots,limitsDir];
      const { MediaLibraryIndex } = await import('../../../server/library.ts');
      const { createMediaServer } = await import('../../../server/app.ts');
      const library = new MediaLibraryIndex(roots, { database: path.join(temp, 'library.sqlite'), watch: false });
      const call=library.indexJobs.call.bind(library.indexJobs),startBuild=library.indexJobs.startBuild.bind(library.indexJobs);
      library.indexJobs.startBuild=(request,options={})=>{
        const held=()=>request.id===gatedId&&!releaseIndexGate;
        const handle=startBuild(request,{...options,onProgress(progress){options.onProgress?.(held()?{...progress,packets:Math.min(progress.packets,128)}:progress);}});
        // A joining subscriber must receive the held validated frontier even
        // if the tiny fixture scan finished before it attached.
        void handle.promise.then(()=>{if(held())options.onProgress?.({phase:'scan',packets:128,scannedBytes:request.size,totalBytes:request.size});}).catch(()=>{});
        return handle;
      };
      library.indexJobs.call=async(op,data={},...args)=>{
        if(data.id===gatedId&&op==='get'&&!releaseIndexGate){heldBatches++;await new Promise(resolve=>indexGateWaiters.add(resolve));}
        const result=await call(op,data,...args);
        if(data.id===gatedId&&op==='stream-manifest'&&!releaseIndexGate&&result?.manifest){heldBatches++;return {...result,manifest:{...result.manifest,complete:false}};}
        return result;
      };
      const server = createMediaServer({ roots, library, staticDir, onLog() {} });
      let closed = false;
      const close = async () => {
        if (closed) return; closed = true;releaseGate();
        try { server.closeAllConnections(); if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
        finally { await library.close(); }
      };
      defer('partial-server', close); library.start();
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      return { server, close, url: `http://127.0.0.1:${server.address().port}/` };
    }},
  },async fixture=>{
    const {page,ready}=fixture, errors=[],requests=[],rows=[];
    page.on('pageerror',error=>errors.push(error.message));
    page.on('request',request=>requests.push({url:request.url(),method:request.method(),...(request.method()==='POST'&&/bitstream-analysis\/requests/.test(request.url())?{target:request.postDataJSON()?.target}:{})}));
    await page.addInitScript(()=>{window.__vpAnalysisQA=true;});
    await ready();page.setDefaultTimeout(30000);
    if(await page.locator('#identity-welcome').isVisible().catch(()=>false))await page.locator('#identity-welcome [data-guest]').click();
    const context={...options,...fixture,limitsDir,staticDir,referenceFixtures,gate,errors,requests,rows,overlayOnly:scenario==='overlay',...await createAnalysisControls(page)};
    fixture.checkpoint('analysis-responsibility',{scenario,...analysisResponsibilities[scenario],matrixPart});
    return run(context);
  });
}
