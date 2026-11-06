import {BRIDGE_PATH,PAGE_BRIDGE_LIMITS as L,PAGE_TOOLS,pageBridgeResult} from '../../shared/service/page-bridge.ts';
import type {PageCommand,PageScope} from '../../shared/service/page-bridge.ts';
import {validateToolInput} from './tool-input.ts';
import {currentActor} from '../services/identity.ts';
import {t,msg} from '../i18n.ts';
import type {ReviewSession} from '../session.ts';
import type {reviewTools} from '../agent.ts';

/** Owned hosts use a document credential. Ordinary loopback pages require explicit pairing. */
export function installPageBridge(session:ReviewSession,tools:ReturnType<typeof reviewTools>,signal:AbortSignal){
  if(window.top!==window)return;
  const meta=document.querySelector<HTMLMetaElement>('meta[name="voidplayer-page-bridge"]');
  const existing=!meta;
  if(existing&&!['localhost','127.0.0.1','[::1]'].includes(location.hostname))return;
  let documentToken=meta?.content??'',requestId='',expiresAt=0;meta?.remove();
  const pageId=crypto.randomUUID();
  const settings=document.querySelector<HTMLDialogElement>('#settings')!;
  const tab=document.querySelector<HTMLButtonElement>('#settings-tab-mcp')!;
  const pane=document.getElementById('settings-pane-mcp')!;
  const $=<T extends HTMLElement=HTMLElement>(id:string)=>pane.querySelector<T>('#page-bridge-'+id)!;
  tab.hidden=false;
  $('pairing').hidden=!existing;
  const read=$<HTMLInputElement>('read');
  read.checked=read.disabled=!existing;
  let grant:{token:string;epoch:string;scopes:PageScope[];binding:string;clientClaim:unknown}|undefined;
  let generation=0,refreshSequence=0,inFlight=0,connecting=false,stopped=false,descriptor:unknown,reviewedRevision:number|undefined,reviewedReady=false;
  let controller=new AbortController();
  const binding=()=>JSON.stringify([location.search,currentActor()?.id??null,session.getState().tracks.map(x=>[x.slot,x.id,x.sourceGen])]);
  const workspace=()=>`${pageId} · ${session.getState().tracks.map(x=>`${x.slot}: ${x.name}`).join(' / ')||t(msg('pageBridge.empty','空工作区'))}`.slice(0,300);
  const note=(s:string)=>{$('status').textContent=s;};
  const render=()=>{
    const client=grant?.clientClaim??descriptor;
    $('client').textContent=typeof client==='string'?client:JSON.stringify(client,null,2)??'—';
    $('workspace').textContent=workspace();
    $('connect').toggleAttribute('disabled',!!grant||inFlight>0||connecting||stopped||!reviewedReady||!['read','view','annotate'].some(id=>$<HTMLInputElement>(id).checked));
    $('revoke').toggleAttribute('disabled',!grant);
    for(const id of (existing?['read','view','annotate']:['view','annotate']))$(id).toggleAttribute('disabled',!!grant||connecting);
    pane.dataset.connected=String(!!grant);
  };
  async function post(route:string,body:unknown,token:string,abort?:AbortSignal,keepalive=false){
    const response=await fetch(BRIDGE_PATH+'/'+route,{method:'POST',headers:{'content-type':'application/json','x-voidplayer-bridge':'1',authorization:'Bearer '+token,...(requestId?{'x-voidplayer-bridge-request':requestId}:{})},body:JSON.stringify(body),cache:'no-store',signal:abort,keepalive});
    const reader=response.body!.getReader(),chunks:Uint8Array[]=[];let size=0;
    try{for(;;){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>L.stdioBytes){await reader.cancel();throw Error('channel-response-budget');}chunks.push(value);}}finally{reader.releaseLock();}
    const bytes=new Uint8Array(size);let offset=0;for(const part of chunks){bytes.set(part,offset);offset+=part.byteLength;}
    const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));if(!response.ok)throw Error(value.code??'channel-disconnected');return value;
  }
  function revoke(message:string,retire=false){
    const old=grant;++generation;grant=undefined;controller.abort();controller=new AbortController();
    if(old)void post('revoke',{epoch:old.epoch},old.token,undefined,true).catch(()=>{});
    if(retire && documentToken)void post('retire',{},documentToken,undefined,true).catch(()=>{});
    note(message);render();
  }
  async function execute(command:PageCommand,g:NonNullable<typeof grant>,epoch:number){
    if(epoch!==generation||grant!==g||g.binding!==binding())return;
    const d=PAGE_TOOLS[command.name];
    if(!d||!Object.hasOwn(PAGE_TOOLS,command.name)||!g.scopes.includes(d.scope)||command.epoch!==g.epoch){revoke(t(msg('pageBridge.invalid','收到不符合授权范围的命令，连接已撤销。')));return;}
    const tool=tools.find(t=>t.name===command.name);if(!tool){revoke('unknown-tool');return;}
    inFlight++;render();let executing=true;
    const physicallyFinished=()=>{if(executing){executing=false;inFlight--;render();}};
    try{
      validateToolInput(d.inputSchema,command.input);
      let result:unknown;
      try{result=await tool.execute(command.input)??{completed:true};}
      catch{result={isError:true,code:'page-operation-failed',correlation:command.correlation,operationId:command.operationId??null};}
      // The facade has settled. Waiting for the delivery ACK is not an active
      // domain operation: the server may already dispatch the next command.
      physicallyFinished();
      result=pageBridgeResult(command.name,result,g.scopes);
      if(epoch!==generation||grant!==g||g.binding!==binding())return;
      if(new TextEncoder().encode(JSON.stringify(result)??'').byteLength>L.resultBytes){revoke(t(msg('pageBridge.large','结果超过通道预算，写入结果可能未知；请保留原 correlation，勿自动重试。')));return;}
      await post('reply',{epoch:g.epoch,correlation:command.correlation,result},g.token,controller.signal);
    }catch{if(epoch===generation)revoke(t(msg('pageBridge.lost','通道已断开；已派发写入的结果可能未知，不会自动重放。')));}
    finally{physicallyFinished();}
  }
  async function poll(g:NonNullable<typeof grant>,epoch:number){
    try{while(epoch===generation&&grant===g&&!signal.aborted){
      const value=await post('poll',{epoch:g.epoch},g.token,controller.signal);
      if(epoch!==generation||grant!==g)return;
      if(g.binding!==binding()){revoke(t(msg('pageBridge.changed','身份或工作区来源已改变，请重新明确授权。')));return;}
      if(value.command){if(inFlight){revoke('concurrent-command');return;}void execute(value.command,g,epoch);}
    }}catch{if(epoch===generation)revoke(t(msg('pageBridge.lost','通道已断开；已派发写入的结果可能未知，不会自动重放。')));}
  }
  async function refresh(){
    if(existing&&!requestId){reviewedReady=false;render();return null;}
    const seq=++refreshSequence,owner=generation;
    try{const r=await fetch(BRIDGE_PATH+'/descriptor',{cache:'no-store',headers:existing?{authorization:'Bearer '+documentToken,'x-voidplayer-bridge-request':requestId}:{},signal:AbortSignal.timeout(3000)});if(!r.ok)throw Error('host-unavailable');const d=await r.json();if(seq!==refreshSequence||owner!==generation||signal.aborted)return null;reviewedRevision=d.clientRevision;reviewedReady=d.ready;descriptor=d.clientClaim??t(msg('pageBridge.noClient','MCP 客户端尚未初始化。'));render();return d;}
    catch{if(seq===refreshSequence&&owner===generation&&!signal.aborted){reviewedReady=false;descriptor=t(msg('pageBridge.unavailable','本机桥进程不可用；普通 HTTP 后台任务不受页面连接影响。'));render();}return null;}
  }
  for(const id of ['read','view','annotate'])$(id).onchange=render;
  if(existing)$('pair').onclick=async event=>{
    if(!event.isTrusted||!navigator.userActivation.isActive||grant||connecting||inFlight||stopped||requestId)return;
    connecting=true;render();const code=$<HTMLInputElement>('code').value;$<HTMLInputElement>('code').value='';
    try{
      const document=await post('existing/document',{},'');
      const paired=await post('existing/pair',{code},document.documentToken);
      if(signal.aborted||stopped)return;
      documentToken=document.documentToken;requestId=paired.id;expiresAt=paired.expiresAt;
      $('pair').toggleAttribute('disabled',true);$('code').toggleAttribute('disabled',true);
      await refresh();note(t(msg('pageBridge.pairReviewTarget','请核对此页面：{page}。配对信息已单次消费。临时授权最晚于 {expiry} 到期。'),{page:`${location.origin}${location.pathname} · ${pageId}`,expiry:new Date(expiresAt).toLocaleTimeString()}));
    }catch{note(t(msg('pageBridge.pairUnavailable','配对不可用：信息不符、已到期、已消费或客户端尚未就绪。请发起新请求，页面数据尚未分享。')));}
    finally{connecting=false;render();}
  };
  if(existing)$('reset').onclick=event=>{
    if(!event.isTrusted||!navigator.userActivation.isActive||inFlight||connecting||signal.aborted)return;
    revoke(t(msg('pageBridge.pairCleared','已清除配对。请输入新的一次性信息，并重新选择权限。')),true);
    ++refreshSequence;requestId='';documentToken='';expiresAt=0;reviewedReady=false;descriptor=undefined;stopped=false;
    $('pair').toggleAttribute('disabled',false);$('code').toggleAttribute('disabled',false);
    for(const id of ['read','view','annotate'])$<HTMLInputElement>(id).checked=false;
    render();
  };
  settings.addEventListener('settings-pane-change',event=>{
    if((event as CustomEvent<string>).detail!=='mcp')return;
    void refresh();render();
  },{signal});
  settings.addEventListener('close',()=>{ $<HTMLInputElement>('code').value=''; },{signal});
  $('revoke').onclick=()=>revoke(t(msg('pageBridge.revoked','已撤销；已开始的操作可能仍会完成。重新连接必须再次确认。')));
  $('connect').onclick=async event=>{
    if(!event.isTrusted||!navigator.userActivation.isActive||grant||inFlight||connecting||stopped)return;
    connecting=true;render();
    const current=++generation,original=binding(),clientClaim=descriptor;
    try{
      if(!reviewedReady)throw Error('client-not-ready');
      const scopes:PageScope[]=[];if($<HTMLInputElement>('read').checked)scopes.push('read');if($<HTMLInputElement>('view').checked)scopes.push('view');if($<HTMLInputElement>('annotate').checked)scopes.push('annotate');
      const accepted=await post('connect',{context:pageId,workspace:workspace(),scopes,clientRevision:reviewedRevision},documentToken,AbortSignal.timeout(4000));
      if(current!==generation||original!==binding()||signal.aborted){void post('revoke',{epoch:accepted.epoch},accepted.token).catch(()=>{});return;}
      grant={token:accepted.token,epoch:accepted.epoch,scopes,binding:original,clientClaim};
      note(t(msg('pageBridge.connected','已连接此页面。关闭设置后授权仍有效，可在此撤销。')));void poll(grant,current);
    }catch{if(current===generation){await refresh();note(t(msg('pageBridge.connectFailed','未能确认连接。请检查客户端及目标页面；不会自动重连或跟随其他标签。')));}}
    finally{connecting=false;render();}
  };
  render();
  const expiry=setInterval(()=>{if(existing&&expiresAt&&Date.now()>=expiresAt){expiresAt=0;stopped=true;revoke(t(msg('pageBridge.pairExpired','临时授权已到期。')),true);}},500);
  const unsubscribe=session.subscribe(()=>{if(grant&&grant.binding!==binding())revoke(t(msg('pageBridge.changed','身份或工作区来源已改变，请重新明确授权。')));});
  window.addEventListener('voidplayer-identity-change',()=>{if(grant)revoke(t(msg('pageBridge.changed','身份或工作区来源已改变，请重新明确授权。')));},{signal});
  for(const name of ['popstate','hashchange'])window.addEventListener(name,()=>{if(grant&&grant.binding!==binding())revoke(t(msg('pageBridge.changed','身份或工作区来源已改变，请重新明确授权。')));},{signal});
  window.addEventListener('pagehide',()=>{stopped=true;clearInterval(expiry);revoke('',true);},{signal});
  signal.addEventListener('abort',()=>{stopped=true;clearInterval(expiry);revoke('',true);unsubscribe();},{once:true});
}
