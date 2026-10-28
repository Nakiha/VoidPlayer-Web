import assert from 'node:assert/strict';
import {mkdir,writeFile,copyFile} from 'node:fs/promises';
import path from 'node:path';
import {Worker} from 'node:worker_threads';
import {randomUUID} from 'node:crypto';
import {chromium,webkit} from 'playwright';
import {nativeFixture,until} from '../test/helpers/native-vmaf.mjs';
import {xpsnrComponent} from '../test/helpers/native-xpsnr.mjs';
import {startService} from '../server/runtime.ts';
import {chooseTestGuest} from './test-identity.mjs';
import {waitForAnnotationMedia} from './testing/agent-annotations-ready.mjs';

const engine=process.argv[2]??'chromium';assert.ok(['chromium','webkit'].includes(engine));
const directory=path.resolve(process.env.VOIDPLAYER_TEST_ARTIFACTS??`.run/reexecution/browser-${engine}`);await mkdir(directory,{recursive:true});
let f,browser,context,page,player,phase='setup',gatedWorker;const errors=[],checks=[],posts=[],held=[];
const check=(name,value)=>{assert.ok(value,name);checks.push(name);};
const defer=()=>{let resolve;const promise=new Promise(r=>resolve=r);const d={promise,resolve};held.push(d);return d;};
const bounded=async(promise,label)=>{let timer;try{return await Promise.race([promise,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('Bounded gate: '+label+' '+phase)),15000))]);}finally{clearTimeout(timer);}};
try{
  f=await nativeFixture({distorted:true,containers:['mp4','flv'],staticDir:'dist',start:async config=>{config.nativeXpsnr=await xpsnrComponent();return startService(config,false);}});
  const library=f.service.library,runner=library.quality,create=runner.createWorker;let measureCount=0,gateAt=Infinity,state;
  runner.createWorker=data=>{if(data.mode==='measure'&&++measureCount===gateAt){state=new Int32Array(new SharedArrayBuffer(20));gatedWorker=new Worker(new URL('../test/helpers/quality-phase-worker.ts',import.meta.url),{workerData:{...data,hangPhase:'decode',phaseState:state.buffer}});return gatedWorker;}return create(data);};
  const frozen=library.qualityCorrespondence.result(f.input.plan.id,f.actor).rangePlan.input;
  const pair={...frozen.pairs[0],ssim:{variant:'ffmpeg-uniform-8x8-step4-v1'},spatial:{blockWidth:64,blockHeight:48}};
  const inputs={single:{schema:'voidplayer-psnr-frame-job',version:1,client:{id:'gui-reexecution',kind:'agent'},request:pair},range:{...frozen,client:{id:'gui-reexecution',kind:'agent'},pairs:frozen.pairs.map(p=>({...p,ssim:{variant:'ffmpeg-uniform-8x8-step4-v1'},spatial:{blockWidth:64,blockHeight:48}}))},vmaf:f.input,xpsnr:(({model,...input})=>({...input,schema:'voidplayer-native-xpsnr-job',recipe:'ffmpeg-xpsnr-reference-first-temporal-v1'}))(f.input)};
  const paths={single:'/api/quality/jobs',range:'/api/quality/ranges',vmaf:'/api/quality/vmaf/jobs',xpsnr:'/api/quality/xpsnr/jobs'},originals={},snapshots={};
  const read=async(kind,id)=>{const r=await f.json(paths[kind]+'/'+id);return kind==='range'?r.job:r;};
  for(const service of [library.qualityVmaf,library.qualityXpsnr]){let crashNative=true;const nativeRunner=service.runner,nativeRun=nativeRunner.run.bind(nativeRunner);nativeRunner.run=(input,snapshot,signal,hooks)=>nativeRun(input,snapshot,signal,{...hooks,process:p=>{hooks.process(p);if(p&&crashNative){crashNative=false;process.kill(p.pid,'SIGKILL');}}});}
  for(const kind of ['single','range','vmaf','xpsnr']){
    phase='prepare-original-'+kind;
    if((kind==='single'||kind==='range')){gateAt=measureCount+(kind==='range'?2:1);state=undefined;}
    const job=(await f.json(paths[kind],inputs[kind],'original-'+kind)).job;
    if((kind==='single'||kind==='range')){await until(()=>state&&Atomics.load(state,0),Boolean,'Actual original decode gate');await f.json(paths[kind]+'/'+job.id+'/cancel',{});gateAt=Infinity;}
    const done=await until(()=>read(kind,job.id),j=>!['queued','preparing','running','cancelling'].includes(j.state),'Original terminal');
    assert.equal(done.state,(kind==='vmaf'||kind==='xpsnr')?'partial':'cancelled');originals[kind]=done;snapshots[kind]=JSON.stringify(done);
  }
  await copyFile(path.resolve('.run/playback-media/http-1080p-a.mp4'),path.join(f.media,'A.mp4'));await library.refresh();const [a]=await waitForAnnotationMedia(library,['A.mp4']);
  browser=await({chromium,webkit}[engine]).launch({headless:true});context=await browser.newContext({locale:'en-US',viewport:{width:1400,height:1000}});await context.addCookies([{name:'voidplayer-user',value:f.actor,url:f.base}]);context.on('page',p=>p.on('pageerror',e=>errors.push(e.message)));
  player=await context.newPage();await player.goto(f.base);await chooseTestGuest(player);await player.waitForFunction(()=>!!window.voidPlayer);
  await player.evaluate(async url=>{const blob=await fetch(url).then(r=>r.blob());await window.voidPlayer.loadFile('A',new File([blob],'A.mp4'));},`${f.base}/api/media/${a.id}?v=${a.version}`);await player.waitForFunction(()=>!window.voidPlayer.getState().busy&&window.voidPlayer.getState().tracks[0]?.frame);await player.evaluate(()=>window.voidPlayer.play());await player.waitForFunction(()=>window.voidPlayer.getState().positionUs>200000);const before=await player.evaluate(()=>window.voidPlayer.getState());
  page=await context.newPage();await page.goto(f.base+'/admin/#quality');
  const roots={single:'#quality-reexecution',range:'#quality-range-reexecution',vmaf:'#vmaf-reexecution',xpsnr:'#tasks-reexecution [data-reexecution="xpsnr"]'},selectors={single:'data-job-id',range:'data-range-id',vmaf:'data-vmaf-job',xpsnr:'data-xpsnr-job'},successors={};
  const select=async(kind,id)=>{if(kind==='xpsnr'){await page.locator('[data-pane=tasks]').click();await page.locator('#tasks-filters [name=kind]').selectOption('xpsnr');await page.locator('#tasks-filters button[type=submit]').click();await page.locator(`[data-task-id="${id}"]`).click();await page.locator(roots[kind]).waitFor({state:'visible'});return;}await page.locator(`[${selectors[kind]}="${id}"]`).click();await page.locator(roots[kind]).waitFor({state:'visible'});};
  for(const kind of ['single','range','vmaf','xpsnr']){
    phase='GUI-plan-'+kind;const id=originals[kind].id,url=paths[kind]+'/'+id;await select(kind,id);const root=page.locator(roots[kind]);
    await root.locator('[data-reason]').fill('Explicit GUI full recomputation '+kind);await root.locator('[data-plan]').click();await root.locator('[data-status]').filter({hasText:'Conditions verified'}).waitFor();
    check(kind+' requires explicit cost confirmation',await root.locator('[data-execute]').isDisabled());check(kind+' describes full scope without old-score reuse',(await root.locator('[data-cost]').textContent()).includes('entire-frozen-input-from-start'));
    await root.locator('[data-confirm]').check();
    if(kind==='range'){
      gateAt=measureCount+1;state=undefined;
      let lost=false;await page.route('**'+url+'/reexecutions',async route=>{if(route.request().method()==='POST'){posts.push({key:route.request().headers()['idempotency-key'],actor:route.request().headers()['x-voidplayer-actor'],body:route.request().postData()});if(!lost){lost=true;const response=await route.fetch();await response.json();await route.abort('failed');return;}}await route.continue();});
      await root.locator('[data-execute]').click();await root.locator('[data-replay]').waitFor({state:'visible'});await until(()=>state&&Atomics.load(state,0),Boolean,'New full range reached actual decode gate');
      const chain=await f.json(url+'/reexecutions');successors[kind]=chain.successor.id;await page.reload();check('reload does not cancel accepted computation',(await read(kind,chain.successor.id)).state==='running');
      gatedWorker.postMessage({type:'resume'});gateAt=Infinity;await until(()=>read(kind,chain.successor.id),j=>j.state==='completed','Background full range completion');
      await select(kind,id);await root.locator('[data-replay]').click();await page.waitForFunction(id=>document.querySelector('#quality-range-title')?.textContent.includes(id),chain.successor.id);
      check('unknown response replays exact original actor/body/key',posts.length===2&&posts[0].key===posts[1].key&&posts[0].actor===posts[1].actor&&posts[0].body===posts[1].body);
      const peer=await context.newPage();await peer.goto(f.base+'/admin/#quality');await peer.locator(`[data-range-id="${id}"]`).click();await peer.locator(roots.range+' [data-reason]').fill('Another window must observe the existing successor');await peer.locator(roots.range+' [data-plan]').click();await peer.locator(roots.range+' [data-blocks]').filter({hasText:'successor-exists'}).waitFor();check('second window cannot fork',await peer.locator(roots.range+' [data-execute]').isDisabled());await peer.close();
      await page.unrouteAll({behavior:'wait'});
    }else{
      await root.locator('[data-execute]').click();const chain=await until(()=>f.json(url+'/reexecutions'),v=>!!v.successor,'GUI durable successor');successors[kind]=chain.successor.id;await until(()=>read(kind,chain.successor.id),j=>!['queued','preparing','running','cancelling'].includes(j.state),'GUI execution');
    }
    if(kind==='xpsnr'){
      await page.locator('#tasks-title').filter({hasText:successors[kind]}).waitFor();
      const originalSeen=defer(),releaseOriginal=defer(),originalPath=`**/api/tasks/xpsnr/${id}`;
      const originalResponse=async route=>{try{const response=await route.fetch(),value=await response.json();originalSeen.resolve({ok:true,status:response.status(),actor:route.request().headers()['x-voidplayer-actor'],value});await releaseOriginal.promise;await route.fulfill({response,json:value});}catch(error){originalSeen.resolve({ok:false,error});await route.abort('failed').catch(()=>{});}};
      await page.route(originalPath,originalResponse);
      await page.locator(`[data-related-id="${id}"]`).click();
      const original=await bounded(originalSeen.promise,'original task detail');if(!original.ok)throw original.error;
      assert.equal(original.status,200);assert.equal(original.actor,f.actor);assert.equal(original.value.task.kind,'xpsnr');assert.equal(original.value.task.id,id);
      check('loading the original clears stale successor details',await page.locator('#tasks-detail').isHidden());
      releaseOriginal.resolve();
      await page.locator('#tasks-detail:not([hidden]) #tasks-title').filter({hasText:id}).waitFor();
      check('task center traces the original computation',(await page.locator('#tasks-title').textContent()).includes(id));
      await page.unroute(originalPath,originalResponse);
      await page.reload();await page.locator('#tasks-title').filter({hasText:id}).waitFor();check('task center reopens the same target and filter',await page.locator('#tasks-filters [name=kind]').inputValue()==='xpsnr');await page.locator('[data-pane=quality]').click();await page.locator(`[data-xpsnr-job="${successors[kind]}"]`).click();await page.locator('#xpsnr-reexecution [data-chain]').filter({hasText:id}).waitFor();
    }
    const done=await read(kind,successors[kind]);check(kind+' finishes a new computation',done.state==='completed'&&done.retryOf.retryOf===id&&done.retryOf.generation===2);check(kind+' retains original terminal facts',JSON.stringify(await read(kind,id))===snapshots[kind]);
    if(kind!=='single'){
      check(kind+' does not auto-publish',await f.json(paths[kind]+'/'+done.id+'/candidates')===null);
      const policy=kind==='range'?{space:'default',side:'reference',metric:'psnr',maxDb:120,limit:1,minAuDistance:1,text:'GUI reviewed new range',severity:2}:{space:'default',side:'reference',maxScore:100,limit:1,minFrameDistance:1,text:'GUI reviewed new VMAF',severity:2};
      const publication=await f.json(paths[kind]+'/'+done.id+'/candidates',policy);check(kind+' candidate is explicit',publication.createdIds.length===1);
      if(kind==='vmaf'||kind==='xpsnr'){
        await page.locator(`[data-${kind}-candidate="${publication.createdIds[0]}"]`).waitFor();const href=await page.locator(`[data-${kind}-candidate="${publication.createdIds[0]}"]`).getAttribute('href'),other=await browser.newContext(),viewer=await other.newPage(),privateReads=[];await other.addCookies([{name:'voidplayer-user',value:'guest-'+randomUUID(),url:f.base}]);viewer.on('request',r=>{if(/\/api\/quality\/(jobs|ranges|vmaf\/jobs|xpsnr\/jobs)/.test(r.url()))privateReads.push(r.url());});await viewer.goto(href);await viewer.locator('#pair-view[data-state="ready"]').waitFor({timeout:30000});check('independent original viewer uses shared evidence without private jobs',privateReads.length===0);await viewer.screenshot({path:path.join(directory,'reexecuted-original-frame.png')});await other.close();
      }
    }
  }
  const after=await player.evaluate(()=>window.voidPlayer.getState());check('other player keeps its source and advances',after.playing&&after.positionUs>before.positionUs&&JSON.stringify(after.tracks.map(t=>t.id))===JSON.stringify(before.tracks.map(t=>t.id)));
  phase='late-view-fence';await select('single',originals.single.id);const seen=defer(),release=defer();let heldOnce=false;
  await page.route('**'+paths.single+'/'+originals.single.id+'/reexecution-plan',async route=>{if(!heldOnce){heldOnce=true;const response=await route.fetch(),json=await response.json();seen.resolve();await release.promise;await route.fulfill({response,json}).catch(()=>{});}else await route.continue();});
  await page.locator(roots.single+' [data-reason]').fill('DELAYED_OLD_VIEW');await page.locator(roots.single+' [data-plan]').click();await bounded(seen.promise,'old view response');await select('single',successors.single);release.resolve();await page.unrouteAll({behavior:'wait'});check('late old plan cannot fill new selection',await page.locator(roots.single+' [data-reason]').inputValue()===''&&!(await page.locator(roots.single+' [data-cost]').textContent()).includes('DELAYED_OLD_VIEW'));
  phase='late-actor-fence';await select('single',originals.single.id);const actorSeen=defer(),actorRelease=defer();heldOnce=false;
  await page.route('**'+paths.single+'/'+originals.single.id+'/reexecution-plan',async route=>{if(!heldOnce){heldOnce=true;const response=await route.fetch(),json=await response.json();actorSeen.resolve();await actorRelease.promise;await route.fulfill({response,json}).catch(()=>{});}else await route.continue();});
  await page.locator(roots.single+' [data-reason]').fill('DELAYED_OLD_ACTOR');await page.locator(roots.single+' [data-plan]').click();await bounded(actorSeen.promise,'old actor response');
  await player.evaluate(async()=>{const r=await fetch('/api/identity',{method:'POST',headers:{'content-type':'application/json','x-voidplayer-action':'identity'},body:JSON.stringify({name:'Reexecution peer',mode:'create'})});const v=await r.json();localStorage.setItem('voidplayer.identity',JSON.stringify(v.actor));});await page.waitForFunction(()=>document.querySelector('#quality-job-detail').hidden);actorRelease.resolve();await page.unrouteAll({behavior:'wait'});check('late old actor cannot restore private plan',await page.locator(roots.single).isHidden()&&!(await page.locator(roots.single).textContent()).includes('DELAYED_OLD_ACTOR'));
  check('no browser page errors',errors.length===0);await page.screenshot({path:path.join(directory,'reexecution-fences.png'),fullPage:true});await writeFile(path.join(directory,'evidence.json'),JSON.stringify({passed:true,engine,checks,successors,posts,otherPlayerUnchanged:true,errors},null,2));console.log(JSON.stringify({passed:true,engine,checks:checks.length}));
}catch(error){await writeFile(path.join(directory,'failure.json'),JSON.stringify({phase,error:String(error),errors,checks},null,2));await page?.screenshot({path:path.join(directory,'failure.png'),fullPage:true}).catch(()=>{});throw error;}
finally{for(const gate of held)gate.resolve();await context?.close();await browser?.close();await f?.close();}
