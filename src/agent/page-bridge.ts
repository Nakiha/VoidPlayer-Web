import {BRIDGE_PATH,PAGE_BRIDGE_LIMITS as L,PAGE_TOOLS} from '../../shared/service/page-bridge.ts';
import type {PageCommand,PageScope} from '../../shared/service/page-bridge.ts';
import {validateToolInput} from './tool-input.ts';
import {currentActor} from '../services/identity.ts';
import {t,th,msg} from '../i18n.ts';
import type {ReviewSession} from '../session.ts';
import type {reviewTools} from '../agent.ts';
import './page-bridge.css';

/** Installed only in HTML minted by this stdio process. No probing ordinary
 * deployments, persistent credential, automatic reconnect or tool passthrough. */
export function installPageBridge(session:ReviewSession,tools:ReturnType<typeof reviewTools>,signal:AbortSignal){
  const meta=document.querySelector<HTMLMetaElement>('meta[name="voidplayer-page-bridge"]');
  if(!meta)return;
  const documentToken=meta.content;meta.remove();
  const pageId=crypto.randomUUID();
  const button=document.createElement('button');button.type='button';button.id='page-bridge-open';button.textContent='MCP';
  const dialog=document.createElement('dialog');dialog.id='page-bridge-dialog';dialog.className='page-bridge-dialog';
  dialog.innerHTML=`<h2>${th(msg('pageBridge.title','临时本机 MCP 连接'))}</h2>
    <p>${th(msg('pageBridge.claim','客户端名称为自行声明，并非认证身份。仅授权此页面及当前工作区，不跟随其他标签。'))}</p>
    <pre id="page-bridge-client"></pre><p id="page-bridge-workspace"></p>
    <label><input type="checkbox" checked disabled> ${th(msg('pageBridge.read','读取此页面会话、已有标注与 ROI（不含媒体或日志字节）'))}</label>
    <label><input id="page-bridge-view" type="checkbox"> ${th(msg('pageBridge.view','允许暂停和精确定位此页面'))}</label>
    <label><input id="page-bridge-annotate" type="checkbox"> ${th(msg('pageBridge.annotate','允许在已暂停的当前帧创建可见标注'))}</label>
    <p>${th(msg('pageBridge.lifetime','授权仅存于当前进程和页面内存。撤销、重载、关页或断线即失效；已经开始的操作可能完成，取消不表示回滚，未知写入不得自动重试。'))}</p>
    <p id="page-bridge-status" role="status"></p>
    <div><button id="page-bridge-connect" type="button">${th(msg('pageBridge.connect','明确连接此页面'))}</button>
    <button id="page-bridge-revoke" type="button" disabled>${th(msg('pageBridge.revoke','撤销连接'))}</button>
    <button id="page-bridge-close" type="button">${th(msg('pageBridge.close','关闭面板'))}</button></div>`;
  document.querySelector('.topbar-utility-actions')?.append(button);document.body.append(dialog);
  const $=<T extends HTMLElement=HTMLElement>(id:string)=>dialog.querySelector<T>('#page-bridge-'+id)!;
  let grant:{token:string;epoch:string;scopes:PageScope[];binding:string;clientClaim:unknown}|undefined;
  let generation=0,refreshSequence=0,inFlight=0,connecting=false,stopped=false,descriptor:unknown,reviewedRevision:number|undefined,reviewedReady=false;
  let controller=new AbortController();
  const binding=()=>JSON.stringify([location.search,currentActor()?.id??null,session.getState().tracks.map(x=>[x.slot,x.id,x.sourceGen])]);
  const workspace=()=>`${pageId} · ${session.getState().tracks.map(x=>`${x.slot}: ${x.name}`).join(' / ')||t(msg('pageBridge.empty','空工作区'))}`.slice(0,300);
  const note=(s:string)=>{$('status').textContent=s;};
  const render=()=>{
    $('client').textContent=JSON.stringify(grant?.clientClaim??descriptor??{},null,2);$('workspace').textContent=workspace();
    $('connect').toggleAttribute('disabled',!!grant||inFlight>0||connecting||stopped||!reviewedReady);
    $('revoke').toggleAttribute('disabled',!grant);
    for(const id of ['view','annotate'])$(id).toggleAttribute('disabled',!!grant||connecting);
    button.dataset.connected=String(!!grant);button.textContent=grant?'MCP ●':'MCP';
  };
  async function post(route:string,body:unknown,token:string,abort?:AbortSignal,keepalive=false){
    const response=await fetch(BRIDGE_PATH+'/'+route,{method:'POST',headers:{'content-type':'application/json','x-voidplayer-bridge':'1',authorization:'Bearer '+token},body:JSON.stringify(body),cache:'no-store',signal:abort,keepalive});
    const reader=response.body!.getReader(),chunks:Uint8Array[]=[];let size=0;
    try{for(;;){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>L.stdioBytes){await reader.cancel();throw Error('channel-response-budget');}chunks.push(value);}}finally{reader.releaseLock();}
    const bytes=new Uint8Array(size);let offset=0;for(const part of chunks){bytes.set(part,offset);offset+=part.byteLength;}
    const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));if(!response.ok)throw Error(value.code??'channel-disconnected');return value;
  }
  function revoke(message:string,retire=false){
    const old=grant;++generation;grant=undefined;controller.abort();controller=new AbortController();
    if(old)void post('revoke',{epoch:old.epoch},old.token,undefined,true).catch(()=>{});
    if(retire)void post('retire',{},documentToken,undefined,true).catch(()=>{});
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
    const seq=++refreshSequence,owner=generation;
    try{const r=await fetch(BRIDGE_PATH+'/descriptor',{cache:'no-store',signal:AbortSignal.timeout(3000)});if(!r.ok)throw Error('host-unavailable');const d=await r.json();if(seq!==refreshSequence||owner!==generation||signal.aborted)return null;reviewedRevision=d.clientRevision;reviewedReady=d.ready;descriptor=d.clientClaim??t(msg('pageBridge.noClient','MCP 客户端尚未初始化。'));render();return d;}
    catch{if(seq===refreshSequence&&owner===generation&&!signal.aborted){reviewedReady=false;descriptor=t(msg('pageBridge.unavailable','本机桥进程不可用；普通 HTTP 后台任务不受页面连接影响。'));render();}return null;}
  }
  button.onclick=()=>{void refresh();render();dialog.showModal();};
  $('close').onclick=()=>dialog.close();
  $('revoke').onclick=()=>revoke(t(msg('pageBridge.revoked','已撤销；已开始的操作可能仍会完成。重新连接必须再次确认。')));
  $('connect').onclick=async event=>{
    if(!event.isTrusted||!navigator.userActivation.isActive||grant||inFlight||connecting||stopped)return;
    connecting=true;render();
    const current=++generation,original=binding(),clientClaim=descriptor;
    try{
      if(!reviewedReady)throw Error('client-not-ready');
      const scopes:PageScope[]=['read'];if($<HTMLInputElement>('view').checked)scopes.push('view');if($<HTMLInputElement>('annotate').checked)scopes.push('annotate');
      const accepted=await post('connect',{context:pageId,workspace:workspace(),scopes,clientRevision:reviewedRevision},documentToken,AbortSignal.timeout(4000));
      if(current!==generation||original!==binding()||signal.aborted){void post('revoke',{epoch:accepted.epoch},accepted.token).catch(()=>{});return;}
      grant={token:accepted.token,epoch:accepted.epoch,scopes,binding:original,clientClaim};
      note(t(msg('pageBridge.connected','已连接此页面；关闭面板仍保留授权，可随时重新打开并撤销。')));void poll(grant,current);
    }catch{if(current===generation){await refresh();note(t(msg('pageBridge.connectFailed','未能确认连接。请检查客户端及目标页面；不会自动重连或跟随其他标签。')));}}
    finally{connecting=false;render();}
  };
  const unsubscribe=session.subscribe(()=>{if(grant&&grant.binding!==binding())revoke(t(msg('pageBridge.changed','身份或工作区来源已改变，请重新明确授权。')));});
  window.addEventListener('voidplayer-identity-change',()=>{if(grant)revoke(t(msg('pageBridge.changed','身份或工作区来源已改变，请重新明确授权。')));},{signal});
  for(const name of ['popstate','hashchange'])window.addEventListener(name,()=>{if(grant&&grant.binding!==binding())revoke(t(msg('pageBridge.changed','身份或工作区来源已改变，请重新明确授权。')));},{signal});
  window.addEventListener('pagehide',()=>{stopped=true;revoke('',true);},{signal});
  signal.addEventListener('abort',()=>{stopped=true;revoke('',true);unsubscribe();button.remove();dialog.remove();},{once:true});
}
