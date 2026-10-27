import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {startMcpClient} from '../../scripts/testing/mcp-client.mjs';
import {get} from 'node:http';

async function fixture(run,modern=false){const dir=await mkdtemp(path.join(os.tmpdir(),'vp-mcp-contract-'));await writeFile(path.join(dir,'index.html'),'<html><head></head><body>test-only document</body></html>');let c;try{c=await startMcpClient({staticDir:dir,modern});await run(c);assert.deepEqual(c.errors,[]);}finally{await c?.close();await rm(dir,{recursive:true,force:true});}}

test('real stdio legacy handshake, fixed whitelist and no-page recovery; EOF closes host',async()=>fixture(async c=>{
  assert.ok((await c.rpc('tools/list')).error);
  assert.deepEqual((await c.rpc('ping',{_meta:{}})).result,{});
  assert.equal((await c.initialize()).result.protocolVersion,'2025-11-25');
  const tools=(await c.rpc('tools/list')).result.tools;
  assert.deepEqual(tools.map(t=>t.name),['get_bridge_status','get_bridge_receipt','get_review_session','get_review_marks','pause_review','seek_review','add_review_mark']);
  assert.equal((await c.call('get_bridge_status')).connected,false);
  assert.ok((await c.rpc('tools/call',{name:'get_bridge_status',arguments:null})).error,'explicit null is not an object-shaped tool input');
  const manifest=await(await fetch(c.base+'/api/agent')).json();
  assert.equal(manifest.capabilities.find(v=>v.id==='bridge.local-mcp').enabled,true);
  assert.equal(manifest.capabilities.find(v=>v.id==='quality.jobs').enabled,false,'the page host does not own durable scoring jobs');
  assert.deepEqual(manifest.localMcp.tools.map(v=>v.inputSchema),tools.map(v=>v.inputSchema),'HTTP operation discovery reuses the actual MCP envelopes');
  assert.equal((await c.call('seek_review',{epoch:'none',operationId:'no-page',input:{ptsUs:0}})).code,'host-unavailable');
  assert.ok((await c.rpc('tools/call',{name:'eval',arguments:{script:'process.exit()'}})).error);
  assert.ok((await c.rpc('tools/call',{name:'seek_review',arguments:{epoch:'x',operationId:'bad',input:{ptsUs:0,path:'/any/file'}}})).error);
  assert.ok((await c.rpc('tools/list',{cursor:'wrong'})).error);
  const previous=c.messages.find(m=>m.result?.tools)?.id;
  c.child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:previous,method:'tools/list',params:{}})+'\n');
  await c.rpc('tools/list');assert.ok(c.messages.some(m=>m.id===previous&&m.error?.code===-32600),'legacy request IDs cannot be reused after completion');
  const base=c.base;assert.deepEqual(await c.close(),{code:0,signal:null});await assert.rejects(fetch(base+'/api/health'));
}));

test('current MCP discovery and per-request metadata without handshake; no invented shutdown',async()=>fixture(async c=>{
  const r=await c.initialize();assert.equal(r.result.resultType,'complete');assert.deepEqual(r.result.supportedVersions,['2026-07-28','2025-11-25']);
  assert.equal(r.result.cacheScope,'public');assert.equal((await c.rpc('tools/list')).result.ttlMs,0);
  assert.equal((await c.rpc('tools/list',{_meta:{'io.modelcontextprotocol/protocolVersion':'1900-01-01'}})).error.code,-32022);
  assert.ok((await c.rpc('tools/list',{},false)).error);
  assert.equal((await c.rpc('shutdown')).error.code,-32601);
},true));

test('document capability required in addition to Host/Origin; no secret in stdout or URLs',async()=>fixture(async c=>{
  await c.initialize();const html=await(await fetch(c.base)).text();const secret=html.match(/name="voidplayer-page-bridge" content="([a-f0-9]{64})"/)[1];
  const headers={origin:c.base,'sec-fetch-site':'same-origin','x-voidplayer-bridge':'1','content-type':'application/json'};
  const descriptor=await(await fetch(c.base+'/api/page-bridge/descriptor')).json();
  const body=JSON.stringify({context:'test-document',workspace:'test workspace',scopes:['read'],clientRevision:descriptor.clientRevision});
  const noToken=await fetch(c.base+'/api/page-bridge/connect',{method:'POST',headers,body});assert.equal((await noToken.json()).code,'document-credential-required');
  assert.equal(noToken.status,403);
  const staleDeclaration=await fetch(c.base+'/api/page-bridge/connect',{method:'POST',headers:{...headers,authorization:'Bearer '+secret},body:JSON.stringify({context:'test-document',workspace:'test workspace',scopes:['read'],clientRevision:descriptor.clientRevision+1})});assert.equal((await staleDeclaration.json()).code,'client-declaration-changed');
  assert.equal((await fetch(c.base+'/api/page-bridge/connect',{method:'POST',headers:{...headers,origin:'https://unrelated.example',authorization:'Bearer '+secret},body})).status,403);
  const forgedHost=await new Promise((resolve,reject)=>{get(c.base,{headers:{host:'rebind.example'}},res=>{res.resume();resolve(res.statusCode);}).on('error',reject);});
  assert.equal(forgedHost,403);
  const accepted=await(await fetch(c.base+'/api/page-bridge/connect',{method:'POST',headers:{...headers,authorization:'Bearer '+secret},body})).json();assert.match(accepted.token,/^[a-f0-9]{64}$/);
  const status=await c.call('get_bridge_status');assert.equal(status.connected,true);assert.equal(status.clientIdentity,'self-declared-not-authenticated');
  const otherHtml=await(await fetch(c.base)).text(),otherSecret=otherHtml.match(/name="voidplayer-page-bridge" content="([a-f0-9]{64})"/)[1];
  assert.equal((await fetch(c.base+'/api/page-bridge/revoke',{method:'POST',headers:{...headers,authorization:'Bearer '+otherSecret},body:JSON.stringify({epoch:accepted.epoch})})).status,403);
  assert.equal((await c.call('get_bridge_status')).epoch,accepted.epoch,'another document cannot revoke this grant');
  assert.equal((await c.call('seek_review',{epoch:accepted.epoch,operationId:'readonly',input:{ptsUs:0}})).code,'scope-denied');
  assert.ok(!JSON.stringify(c.messages).includes(secret));assert.ok(!JSON.stringify(c.messages).includes(accepted.token));assert.ok(!c.stderr.includes(secret));assert.ok(!c.stderr.includes(accepted.token));
  const retire=await fetch(c.base+'/api/page-bridge/retire',{method:'POST',headers:{...headers,authorization:'Bearer '+secret},body:'{}'});assert.equal(retire.status,200);assert.equal((await c.call('get_bridge_status')).connected,false);
}));

test('stdio oversized line closes process with bounded protocol output',async()=>fixture(async c=>{
  c.child.stdin.write('x'.repeat(65537));const {code}=await c.exited;assert.equal(code,0);assert.ok(c.messages.length<=1);assert.equal(c.messages[0].error.code,-32600);
}));

test('bounded real stdio queue, cancellation without a fake response, and dispatched deadline', {timeout:25000},async()=>fixture(async c=>{
  await c.initialize();const html=await(await fetch(c.base)).text(),token=html.match(/name="voidplayer-page-bridge" content="([a-f0-9]{64})"/)[1];
  const headers={origin:c.base,'sec-fetch-site':'same-origin','x-voidplayer-bridge':'1','content-type':'application/json',authorization:'Bearer '+token};
  const descriptor=await(await fetch(c.base+'/api/page-bridge/descriptor')).json();
  const grant=await(await fetch(c.base+'/api/page-bridge/connect',{method:'POST',headers,body:JSON.stringify({context:'queue-test',workspace:'queue test',scopes:['read','view'],clientRevision:descriptor.clientRevision})})).json();
  const queued=Array.from({length:8},(_,i)=>c.request('tools/call',{name:'pause_review',arguments:{epoch:grant.epoch,operationId:'queued-'+i,input:{}}}));
  assert.equal((await c.call('pause_review',{epoch:grant.epoch,operationId:'ninth',input:{}})).code,'queue-full');
  queued.forEach(r=>c.cancel(r.id));await Promise.all(queued.map(r=>r.promise));
  assert.equal((await c.call('get_bridge_receipt',{operationId:'queued-0'})).outcome,'not-executed');
  assert.ok(!c.messages.some(m=>queued.some(r=>r.id===m.id)),'cancelled requests have no later response');
  const poll=()=>fetch(c.base+'/api/page-bridge/poll',{method:'POST',headers:{...headers,authorization:'Bearer '+grant.token},body:JSON.stringify({epoch:grant.epoch})});
  const active=c.call('pause_review',{epoch:grant.epoch,operationId:'dispatched-deadline',input:{}});
  assert.equal((await(await poll()).json()).command.name,'pause_review');
  let stopped=false;const observer=(async()=>{while(!stopped){const r=await poll();await r.text();if(!r.ok)break;}})();
  const waiting=c.call('pause_review',{epoch:grant.epoch,operationId:'waiting-behind-active',input:{}});
  try{const result=await active;assert.equal(result.code,'outcome-unknown');assert.equal(result.reason,'request-deadline-after-dispatch');assert.equal((await waiting).code,'not-executed');}
  finally{stopped=true;await observer;}
}));
