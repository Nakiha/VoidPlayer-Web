import {createMediaServer} from '../../server/app.ts';
import {MediaLibraryIndex} from '../../server/library.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request} from 'node:http';
import {ExistingPageRequests,EXISTING_PATH as P,EXISTING_LIMITS} from '../../server/bridge/existing-pages.ts';
import {ExistingPageClient} from '../../server/bridge/existing-client.ts';

async function fixture(run:(origin:string)=>Promise<void>){
  const registry=new ExistingPageRequests(),server=createServer((req,res)=>{void registry.handle(req,res).then(handled=>{if(!handled){res.writeHead(404);res.end();}});});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{await run('http://127.0.0.1:'+(server.address() as {port:number}).port);}finally{registry.close();await new Promise<void>(resolve=>{server.close(()=>resolve());server.closeAllConnections();});}
}
const jsonHeaders={'content-type':'application/json'};
async function post(origin:string,path:string,body:unknown,headers:Record<string,string>={}){return fetch(origin+path,{method:'POST',headers:{...jsonHeaders,...headers},body:JSON.stringify(body)});}

test('existing page pairing is bounded, single use, independent capabilities, strict origin/Host and expiry',()=>fixture(async origin=>{
  const pageHeaders={origin,'sec-fetch-site':'same-origin','x-voidplayer-bridge':'1'};
  assert.equal((await post(origin,P+'/request',{},pageHeaders)).status,403);
  assert.equal((await post(origin,P+'/request',{}, {origin:'https://other.invalid'})).status,403);
  const forged=await new Promise<number>((resolve,reject)=>{const req=request(origin+P+'/request',{method:'POST',headers:{...jsonHeaders,host:'evil.invalid'}},res=>{res.resume();resolve(res.statusCode!);});req.on('error',reject);req.end('{}');});assert.equal(forged,403);
  const e=await(await post(origin,P+'/request',{})).json();assert.match(e.secret,/^[a-f0-9]{64}$/);
  const cli={'x-voidplayer-bridge-request':e.id,authorization:'Bearer '+e.secret};
  assert.equal((await post(origin,P+'/status',{}, {'x-voidplayer-bridge-request':e.id})).status,403);
  assert.equal((await post(origin,P+'/sync',{client:{name:'Claim only',version:'1'},revision:1,ready:true},cli)).status,200);
  assert.equal((await post(origin,P+'/pair',{code:'0'.repeat(32)},pageHeaders)).status,403);
  assert.equal((await post(origin,P+'/pair',{code:e.pairingCode},{...pageHeaders,origin:'https://other.invalid'})).status,403);
  assert.equal((await post(origin,P+'/pair',{code:e.pairingCode},pageHeaders)).status,403,'public selector alone cannot obtain a document capability');
  const document=await(await post(origin,P+'/document',{},pageHeaders)).json();assert.match(document.documentToken,/^[a-f0-9]{64}$/);
  const pairingHeaders={...pageHeaders,authorization:'Bearer '+document.documentToken};
  const pair=await(await post(origin,P+'/pair',{code:e.pairingCode},pairingHeaders)).json();assert.equal(pair.documentToken,undefined,'pair never returns a capability');
  const otherDocument=await(await post(origin,P+'/document',{},pageHeaders)).json();
  assert.equal((await post(origin,P+'/pair',{code:e.pairingCode},{...pageHeaders,authorization:'Bearer '+otherDocument.documentToken})).status,403,'selector is consumed even for another valid document');
  const pending=await(await post(origin,P+'/status',{},cli)).json();assert.equal(pending.connected,false);assert.equal(pending.workspace,undefined);
  const headers={...pageHeaders,'x-voidplayer-bridge-request':e.id,authorization:'Bearer '+document.documentToken};
  const descriptor=await fetch(origin+'/api/page-bridge/descriptor',{headers});assert.equal(descriptor.status,200);
  assert.equal((await fetch(origin+'/api/page-bridge/descriptor',{headers:{...headers,authorization:'Bearer '+e.secret}})).status,403);
  const grant=await(await post(origin,'/api/page-bridge/connect',{context:'only-this-document',workspace:'specific File A',scopes:['view'],clientRevision:1},headers)).json();assert.match(grant.token,/^[a-f0-9]{64}$/);
  const denied=await(await post(origin,P+'/call',{callId:'denied',name:'get_review_session',args:{epoch:grant.epoch,input:{}}},cli)).json();assert.equal(denied.code,'scope-denied','read is separately opted in');
  assert.equal((await post(origin,'/api/page-bridge/revoke',{epoch:grant.epoch},headers)).status,403,'document credential cannot impersonate grant');
  const clock=Date.now;Date.now=()=>clock()+EXISTING_LIMITS.grantMs+1;
  try{assert.equal((await post(origin,P+'/status',{},cli)).status,403,'authorization deadline is not renewed by the CLI');}finally{Date.now=clock;}
  assert.equal((await post(origin,P+'/close',{},cli)).status,200);
  assert.equal((await post(origin,P+'/status',{},cli)).status,403,'EOF capability is retired');
  const expiresDocument=await(await post(origin,P+'/document',{},pageHeaders)).json();
  const expired=await(await post(origin,P+'/request',{})).json();
  const expiredCli={'x-voidplayer-bridge-request':expired.id,authorization:'Bearer '+expired.secret};
  await post(origin,P+'/sync',{client:{name:'x',version:'1'},revision:1,ready:true},expiredCli);
  const now=Date.now;Date.now=()=>now()+EXISTING_LIMITS.pairMs+1;
  try{
    const freshDocument=await(await post(origin,P+'/document',{},pageHeaders)).json();
    const response=await post(origin,P+'/pair',{code:expired.pairingCode},{...pageHeaders,authorization:'Bearer '+freshDocument.documentToken});assert.equal(response.status,403);assert.equal((await response.json()).code,'pairing-unavailable');
  }finally{Date.now=now;}
  for(let i=0;i<EXISTING_LIMITS.requests-1;i++)assert.equal((await post(origin,P+'/request',{})).status,200);
  assert.equal((await post(origin,P+'/request',{})).status,403,'pending request budget cannot grow');
}));

test('client rejects remote/path/credentials/query/fragment without contacting target',async()=>{
  for(const target of ['https://example.com','http://127.0.0.1/path','http://user:pass@localhost','http://localhost/?secret=x','http://localhost/#secret'])await assert.rejects(ExistingPageClient.create(target));
});


test('normal service bridge rejects mapped remote peer even with loopback Host',async()=>{
  const library=new MediaLibraryIndex([],{database:':memory:',watch:false});
  const server=createMediaServer({roots:[],library,onLog:()=>{},clientAddress:()=> '198.51.100.1'});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
  try{assert.equal((await post(origin,P+'/request',{})).status,403);}finally{await new Promise<void>(resolve=>{server.close(()=>resolve());server.closeAllConnections();});await library.close();}
});


test('a dead CLI lease retires pending requests and all process capabilities',()=>fixture(async origin=>{
  const entry=await(await post(origin,P+'/request',{})).json();
  const clock=Date.now;Date.now=()=>clock()+EXISTING_LIMITS.leaseMs+1;
  try{await new Promise(resolve=>setTimeout(resolve,600));}finally{Date.now=clock;}
  assert.equal((await post(origin,P+'/status',{}, {'x-voidplayer-bridge-request':entry.id,authorization:'Bearer '+entry.secret})).status,403);
}));
