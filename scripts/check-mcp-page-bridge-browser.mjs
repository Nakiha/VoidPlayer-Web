import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import {chromium} from 'playwright';
import {startMcpClient} from './testing/mcp-client.mjs';

// Agent actions only use this independent real stdin/stdout client. Browser
// automation selects Files, clicks consent/revoke and observes real DOM/network.
const root=path.resolve(import.meta.dirname,'..'),dir=path.join(root,'.run/mcp-page-bridge');
await mkdir(dir,{recursive:true});const temp=await mkdtemp(path.join(os.tmpdir(),'vp-mcp-browser-'));
let client,browser,phase='setup';const network=[],pageErrors=[],checks=[],channelResponses=[],mediaNeedles=[];
const check=(name,value=true)=>{assert.ok(value,name);checks.push(name);};
const gates=[],sessions=[];
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);gates.push(()=>resolve());return {promise,resolve};};
async function gateWait(gate){let timer;try{await Promise.race([gate.promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Gate timeout: '+phase)),12000);})]);}finally{clearTimeout(timer);}}
async function eventually(fn){const end=Date.now()+12000;for(;;){const value=await fn();if(value)return value;if(Date.now()>=end)throw Error('Condition timeout: '+phase);await new Promise(r=>setTimeout(r,40));}}
try{
  const a=path.join(temp,'Explicit-A.mp4'),b=path.join(temp,'Explicit-B.mp4');
  for(const [file,source]of [[a,'testsrc2=size=160x96:rate=10'],[b,'smptebars=size=160x96:rate=10']])execFileSync('ffmpeg',['-v','error','-f','lavfi','-i',source,'-t','4','-c:v','libx264','-threads','1','-pix_fmt','yuv420p','-g','10','-bf','2','-movflags','+faststart',file]);
  for(const file of [a,b]){const bytes=await readFile(file);const sample=bytes.subarray(1024,1280);mediaNeedles.push(sample,Buffer.from(sample.toString('base64')));}
  client=await startMcpClient();await client.initialize();
  const list=await client.rpc('tools/list');check('real MCP initialize, initialized and tools/list',list.result.tools.length===7);
  check('no page reports host unavailable',(await client.call('seek_review',{epoch:'absent',operationId:'no-page',input:{ptsUs:0}})).code==='host-unavailable');
  browser=await chromium.launch({headless:true,...(process.env.MCP_BROWSER_EXECUTABLE?{executablePath:process.env.MCP_BROWSER_EXECUTABLE}:{}),...(process.env.MCP_BROWSER_CHANNEL?{channel:process.env.MCP_BROWSER_CHANNEL}:{})});
  const context=await browser.newContext({viewport:{width:1280,height:900},locale:'en-US'});
  context.setDefaultTimeout(10000);
  context.on('page',page=>{page.on('pageerror',e=>pageErrors.push(e.message));page.on('request',request=>{const body=request.postDataBuffer();network.push({method:request.method(),path:new URL(request.url()).pathname,bodyBytes:body?.byteLength??0,containsMediaBytes:!!body&&mediaNeedles.some(needle=>body.includes(needle))});});});
  const pageA=await context.newPage(),pageB=await context.newPage();
  phase='explicit-files';
  for(const [page,file]of [[pageA,a],[pageB,b]]){
    await page.goto(client.base);await page.locator('#app:not([data-initializing])').waitFor({state:'visible'});await page.waitForFunction(()=>!!window.voidPlayer?.tools);await page.locator('#file-A').setInputFiles(file);
    await page.locator('#image-A').waitFor({state:'visible'});await page.waitForFunction(()=>document.querySelector('#pts-A')?.textContent!=='—');
  }
  const bBefore={time:await pageB.locator('#pts-A').textContent(),name:await pageB.locator('#name-A').textContent()};
  phase='read-only';await pageA.locator('#page-bridge-open').click();await pageA.locator('#page-bridge-connect').click();
  let status=await eventually(async()=>{const s=await client.call('get_bridge_status');return s.connected?s:false;}),epoch=status.epoch;
  check('explicit A workspace target',status.workspace.includes('Explicit-A.mp4'));
  check('client declaration is not authentication',status.clientIdentity==='self-declared-not-authenticated');
  const call=(name,input={},operationId)=>client.call(name,{epoch, input,...(operationId?{operationId}:{})});
  check('MCP state reads selected File metadata',(await call('get_review_session')).tracks[0].name==='Explicit-A.mp4');
  check('MCP existing ROI list is read-only',(await call('get_review_marks')).entries.length===0);
  check('read-only seek denied',(await call('seek_review',{ptsUs:500000},'readonly-seek')).code==='scope-denied');
  check('read-only annotation denied',(await call('add_review_mark',{slot:'A',text:'forbidden'},'readonly-mark')).code==='scope-denied');
  await pageB.locator('#page-bridge-open').click();await pageB.locator('#page-bridge-connect').click();
  await pageB.locator('#page-bridge-status').getByText('Connection could not be confirmed.',{exact:false}).waitFor();
  check('B cannot replace active A grant',(await client.call('get_bridge_status')).epoch===epoch);
  phase='view-and-annotation';await pageA.locator('#page-bridge-revoke').click();
  await eventually(async()=>!(await client.call('get_bridge_status')).connected);
  check('old epoch unavailable',(await call('seek_review',{ptsUs:500000},'revoked-seek')).code==='host-unavailable');
  await pageA.locator('#page-bridge-view').check();await pageA.locator('#page-bridge-annotate').check();await pageA.locator('#page-bridge-connect').click();
  status=await eventually(async()=>{const s=await client.call('get_bridge_status');return s.connected?s:false;});epoch=status.epoch;
  await pageA.locator('#page-bridge-close').click();
  check('MCP pause completes',(await call('pause_review',{},'pause-1')).completed);
  phase='delivery-ack-is-not-active-domain-work';
  const ackSeen=deferred(),ackRelease=deferred();let ackHeld=false;
  const ackCdp=await context.newCDPSession(pageA);sessions.push(ackCdp);
  ackCdp.on('Fetch.requestPaused',async event=>{
    try{if(!ackHeld){ackHeld=true;ackSeen.resolve();await ackRelease.promise;}}
    finally{await ackCdp.send('Fetch.continueResponse',{requestId:event.requestId}).catch(()=>{});}
  });
  await ackCdp.send('Fetch.enable',{patterns:[{urlPattern:client.base+'/api/page-bridge/reply',requestStage:'Response'}]});
  await call('pause_review',{},'pause-delayed-ack');await gateWait(ackSeen);
  check('next command succeeds while prior delivery ACK is delayed',Array.isArray((await call('get_review_marks')).entries));
  check('delayed ACK does not revoke authorization',(await client.call('get_bridge_status')).connected);
  ackRelease.resolve();await ackCdp.send('Fetch.disable');await ackCdp.detach();sessions.splice(sessions.indexOf(ackCdp),1);
  phase='view-and-annotation';
  await call('seek_review',{ptsUs:500000},'seek-1');
  const state=await call('get_review_session');check('exact seek through real MCP',state.positionUs===500000&&state.tracks[0].frame.ptsUs===500000);
  const markInput={slot:'A',text:'MCP visible ROI',severity:3,drawings:[{tool:'rect',points:[{x:.2,y:.2},{x:.6,y:.6}]}]};
  const mark=await call('add_review_mark',markInput,'mark-1');check('real visible annotation created',typeof mark.id==='string');
  assert.deepEqual(await call('add_review_mark',markInput,'mark-1'),mark);
  check('same operationId receipt never executes twice',(await call('get_review_marks')).entries.length===1);
  check('changed input conflicts',(await call('add_review_mark',{...markInput,text:'different'},'mark-1')).code==='operation-conflict');
  await pageA.locator('#annotations-A rect.annotation-object').waitFor({state:'visible'});
  check('annotation rendered in page DOM');
  await pageA.screenshot({path:path.join(dir,'mcp-created-roi.png')});
  await pageA.locator('#page-bridge-open').click();
  check('B File and frame unchanged',await pageB.locator('#pts-A').textContent()===bBefore.time&&await pageB.locator('#name-A').textContent()===bBefore.name);
  phase='committed-page-write-lost-reply';
  const seen=deferred(),release=deferred();let held=false;
  await pageA.route('**/api/page-bridge/reply',async route=>{if(held){await route.continue();return;}held=true;seen.resolve();await release.promise;await route.abort().catch(()=>{});});
  const unknownInput={...markInput,text:'MCP unknown outcome'};
  const unknownCall=call('add_review_mark',unknownInput,'unknown-mark');await gateWait(seen);
  await eventually(async()=>await pageA.locator('#annotations-A .annotation-object').count()===2);
  await pageA.locator('#page-bridge-revoke').click();const unknown=await unknownCall;
  check('disconnected dispatched write is unknown',unknown.code==='outcome-unknown'&&unknown.operationId==='unknown-mark'&&unknown.automaticReplay===false);
  release.resolve();await pageA.unrouteAll({behavior:'wait'});
  await pageA.locator('#page-bridge-connect').waitFor({state:'visible'});await eventually(()=>pageA.locator('#page-bridge-connect').isEnabled());await pageA.locator('#page-bridge-connect').click();
  status=await eventually(async()=>{const s=await client.call('get_bridge_status');return s.connected?s:false;});epoch=status.epoch;
  check('unknown receipt survives reconnect',(await client.call('get_bridge_receipt',{operationId:'unknown-mark'})).outcome==='unknown');
  check('unknown operation cannot be replayed under new epoch',(await call('add_review_mark',unknownInput,'unknown-mark')).code==='operation-conflict');
  check('page write occurred exactly once',(await call('get_review_marks')).entries.filter(m=>m.text==='MCP unknown outcome').length===1);
  phase='MCP-cancel-after-real-write';
  const cancelSeen=deferred(),cancelRelease=deferred();let cancelHeld=false;
  await pageA.route('**/api/page-bridge/reply',async route=>{if(cancelHeld){await route.continue();return;}cancelHeld=true;cancelSeen.resolve();await cancelRelease.promise;await route.abort().catch(()=>{});});
  const cancelled=client.request('tools/call',{name:'add_review_mark',arguments:{epoch,operationId:'cancelled-mark',input:{...markInput,text:'MCP cancelled write'}}});await gateWait(cancelSeen);
  await eventually(async()=>await pageA.locator('#annotations-A .annotation-object').count()===3);
  client.cancel(cancelled.id);await cancelled.promise;
  await eventually(async()=>(await client.call('get_bridge_receipt',{operationId:'cancelled-mark'})).outcome==='unknown');
  check('MCP cancellation cannot roll back an executed write');check('cancelled MCP request has no further response',!client.messages.some(m=>m.id===cancelled.id));
  cancelRelease.resolve();await pageA.unrouteAll({behavior:'wait'});
  await eventually(()=>pageA.locator('#page-bridge-connect').isEnabled());await pageA.locator('#page-bridge-connect').click();
  status=await eventually(async()=>{const s=await client.call('get_bridge_status');return s.connected?s:false;});epoch=status.epoch;
  phase='late-old-command-after-reconnect';
  const pollSeen=deferred(),lateSeen=deferred(),lateRelease=deferred();let lateHeld=false;
  // Gate the real browser response: API route.fetch changes fetch metadata and
  // is correctly rejected by this channel's strict same-origin policy.
  const cdp=await context.newCDPSession(pageA);sessions.push(cdp);
  cdp.on('Fetch.requestPaused',async event=>{
    try{
      const raw=await cdp.send('Fetch.getResponseBody',{requestId:event.requestId});
      const observed=JSON.parse(raw.base64Encoded?Buffer.from(raw.body,'base64').toString():raw.body);
      channelResponses.push({status:event.responseStatusCode,code:observed.code,command:observed.command?.name??null});pollSeen.resolve();
      if(!lateHeld&&observed.command){lateHeld=true;lateSeen.resolve();await lateRelease.promise;}
    }catch(error){channelResponses.push({gateError:String(error)});}
    finally{await cdp.send('Fetch.continueResponse',{requestId:event.requestId}).catch(()=>{});}
  });
  await cdp.send('Fetch.enable',{patterns:[{urlPattern:client.base+'/api/page-bridge/poll',requestStage:'Response'}]});
  await gateWait(pollSeen);
  check('late gate retains live authorization',(await client.call('get_bridge_status')).connected);
  const late=call('seek_review',{ptsUs:2500000},'late-seek');await gateWait(lateSeen);await pageA.locator('#page-bridge-revoke').click();
  check('lost dispatched command remains unknown',(await late).code==='outcome-unknown');
  await pageA.locator('#page-bridge-connect').click();status=await eventually(async()=>{const s=await client.call('get_bridge_status');return s.connected?s:false;});epoch=status.epoch;
  lateRelease.resolve();await cdp.send('Fetch.disable');await cdp.detach();sessions.splice(sessions.indexOf(cdp),1);
  check('late old command cannot mutate new grant',(await call('get_review_session')).positionUs===500000);
  phase='explicit-source-replacement';await pageA.locator('#page-bridge-close').click();await pageA.locator('#file-A').setInputFiles(b);
  await eventually(async()=>!(await client.call('get_bridge_status')).connected);check('explicit source replacement revokes the old grant');
  await pageA.locator('#image-A').waitFor({state:'visible'});await pageA.locator('#page-bridge-open').click();await eventually(()=>pageA.locator('#page-bridge-connect').isEnabled());await pageA.locator('#page-bridge-connect').click();
  status=await eventually(async()=>{const s=await client.call('get_bridge_status');return s.connected?s:false;});epoch=status.epoch;
  phase='reload-and-close';const oldEpoch=epoch;await pageA.reload();await pageA.locator('#page-bridge-open').waitFor();
  await eventually(async()=>!(await client.call('get_bridge_status')).connected);
  check('reload invalidates epoch',(await client.call('seek_review',{epoch:oldEpoch,operationId:'after-reload',input:{ptsUs:0}})).code==='host-unavailable');
  await pageB.locator('#page-bridge-connect').click();status=await eventually(async()=>{const s=await client.call('get_bridge_status');return s.connected?s:false;});check('B connects only after explicit click',status.workspace.includes('Explicit-B.mp4'));
  const bEpoch=status.epoch;await pageB.close();await eventually(async()=>!(await client.call('get_bridge_status')).connected);
  check('page close invalidates B epoch',(await client.call('get_review_session',{epoch:bEpoch,input:{}})).code==='host-unavailable');
  check('no local File/log upload',network.filter(r=>r.method==='POST').every(r=>r.path.startsWith('/api/page-bridge/'))&&!network.some(r=>r.containsMediaBytes));
  check('no script evaluation or full-tool forwarding',!(await client.rpc('tools/call',{name:'get_review_logs',arguments:{}})).result);
  check('no page exceptions',pageErrors.length===0);assert.deepEqual(client.errors,[]);
  await pageA.screenshot({path:path.join(dir,'disconnected.png')});
  await pageA.locator('#page-bridge-open').click();await pageA.locator('#page-bridge-connect').click();
  await eventually(async()=>(await client.call('get_bridge_status')).connected);check('EOF starts with a live explicit grant');
  check('stdio EOF shutdown',(await client.close()).code===0);
  await pageA.locator('#page-bridge-open[data-connected="false"]').waitFor({state:'visible'});check('EOF invalidates the live page grant');
  await writeFile(path.join(dir,'evidence.json'),JSON.stringify({passed:true,browser:browser.version(),channel:process.env.MCP_BROWSER_CHANNEL??'chromium',checks,network,pageErrors},null,2));
  console.log(JSON.stringify({passed:true,browser:browser.version(),checks:checks.length,phase}));
}catch(error){await writeFile(path.join(dir,'failure.json'),JSON.stringify({phase,error:String(error),stack:error.stack,checks,network,pageErrors,channelResponses},null,2));throw error;}
finally{gates.forEach(resolve=>resolve());for(const cdp of sessions)await cdp.detach().catch(()=>{});await browser?.close();await client?.close();await rm(temp,{recursive:true,force:true});}
