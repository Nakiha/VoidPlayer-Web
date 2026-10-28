import {t,th,msg} from '../i18n.ts';
import {currentActor} from '../services/identity.ts';
import {QualityClient} from '../services/quality-jobs.ts';
import {QualityReexecutionClient} from '../services/quality-reexecution.ts';
import {reexecutionPath} from '../../shared/analysis/quality/reexecution.ts';
import type {ReexecutionKind,ReexecutionPlan} from '../../shared/analysis/quality/reexecution.ts';

/** Three views consume the same plan/confirmation/receipt protocol. This panel
 * owns observation only. It never cancels a job when hidden or disposed. */
export function installQualityReexecution(root:HTMLElement,kind:ReexecutionKind,signal:AbortSignal,navigate:(id:string)=>void){
  root.dataset.reexecution=kind;
  root.innerHTML=`<h4>${th(msg('reexecution.title','显式重新计算与追溯'))}</h4>
  <p>${th(msg('reexecution.scope','重新计算创建关联的新任务，从头处理全部冻结输入，不复用旧分数。原任务、partial 证据与候选保留；不会自动发布新候选。重放原提交只查询原回执，不会重新计算。'))}</p>
  <div data-chain></div><label>${th(msg('reexecution.reason','重新计算原因'))}<textarea data-reason maxlength="500"></textarea></label>
  <button type="button" data-plan>${th(msg('reexecution.preview','检查原条件并预览完整成本'))}</button>
  <pre data-cost></pre><pre data-previous></pre><p data-blocks></p>
  <label><input type="checkbox" data-confirm>${th(msg('reexecution.confirm','我确认按以上完整范围和预算重新计算'))}</label>
  <button type="button" data-execute disabled>${th(msg('reexecution.execute','创建关联的新计算任务'))}</button>
  <button type="button" data-replay hidden>${th(msg('reexecution.replay','用冻结的原请求和原键获取重算回执'))}</button>
  <button type="button" data-clear hidden>${th(msg('reexecution.clearRejected','结束服务端已明确拒绝的本地请求'))}</button>
  <p data-status role="status"></p>`;
  const q=<T extends HTMLElement=HTMLElement>(selector:string)=>root.querySelector<T>('[data-'+selector+']')!;
  const api=new QualityClient(),client=new QualityReexecutionClient(sessionStorage,location.origin);let id='',actor='',generation=0,controller=new AbortController(),plan:ReexecutionPlan|null=null,busy=false;
  const context=()=>({id,actor,generation,signal:controller.signal});
  const valid=(c:ReturnType<typeof context>)=>!!id&&!signal.aborted&&!c.signal.aborted&&c.id===id&&c.actor===actor&&c.generation===generation&&currentActor()?.id===actor;
  function lock(){
    const p=actor?client.pending(actor,kind):null,matching=p?.jobId===id;
    q<HTMLTextAreaElement>('reason').disabled=busy||!!p;q<HTMLButtonElement>('plan').disabled=busy||!!p;
    q<HTMLInputElement>('confirm').disabled=busy||!!p||!plan?.eligible;
    q<HTMLButtonElement>('execute').disabled=busy||!!p||!plan?.eligible||!q<HTMLInputElement>('confirm').checked;
    q('replay').hidden=!matching;q<HTMLButtonElement>('replay').disabled=busy;q('clear').hidden=!matching||!p?.rejected;
    if(p){q<HTMLTextAreaElement>('reason').value=p.body.reason;q('cost').textContent=JSON.stringify(p.body.confirm,null,2);q('status').textContent=p.rejected?t(msg('reexecution.rejected','服务端已明确拒绝此请求。可结束本地请求，或读取原任务链。')):t(msg('reexecution.unknown','提交结果尚未确认。仅允许冻结的原 actor、原请求与原键回放；不要创建新键。'));
      if(!matching){const button=document.createElement('button');button.type='button';button.textContent=t(msg('reexecution.pendingOther','先查看此用户尚未确认的原重算请求'));button.onclick=()=>{if(currentActor()?.id===actor)navigate(p.jobId);};q('chain').append(button);}}
  }
  async function chain(){const c=context();if(!c.id)return;try{const value=await api.request<{retryOf:{retryOf:string;rootJobId:string;generation:number;reason:string}|null;successor:{id:string;lineage:{generation:number};state:string}|null}>(c.actor,reexecutionPath(kind,c.id)+'/reexecutions',c.signal);if(!valid(c))return;q('chain').replaceChildren();
    const link=(target:string,text:string)=>{const b=document.createElement('button');b.type='button';b.textContent=text;b.onclick=()=>{if(valid(c))navigate(target);};q('chain').append(b);};
    if(value.retryOf)link(value.retryOf.retryOf,t(msg('reexecution.previous','查看上一次执行'))+' · '+value.retryOf.retryOf+' · '+value.retryOf.reason);
    if(value.successor)link(value.successor.id,t(msg('reexecution.successor','查看已受理的新执行'))+` · ${value.successor.id} · ${value.successor.state} · #${value.successor.lineage.generation}`);
    lock();
  }catch(error){if(valid(c))q('status').textContent=String(error);}}
  async function preview(){const c=context();busy=true;plan=null;q<HTMLInputElement>('confirm').checked=false;try{lock();const value=await api.request<ReexecutionPlan>(c.actor,reexecutionPath(kind,c.id)+'/reexecution-plan',c.signal,'POST',{reason:q<HTMLTextAreaElement>('reason').value},undefined,'quality-job',35000);if(!valid(c))return;plan=value;q('cost').textContent=JSON.stringify(value.cost,null,2);q('previous').textContent=JSON.stringify(value.previous,null,2);q('blocks').textContent=value.blocks.map(b=>b.code+': '+b.message+' → '+b.next).join('\n');q('status').textContent=value.eligible?t(msg('reexecution.ready','条件核验通过。请确认完整范围与成本，再明确发起新计算。')):t(msg('reexecution.blocked','原条件不能保持或任务尚未停止；不会创建新计算。'));
    }catch(error){if(valid(c))q('status').textContent=String(error);}finally{if(valid(c)){busy=false;lock();}}}
  async function send(replay:boolean){const c=context();busy=true;try{
    const p=replay?client.pending(c.actor,kind):client.freeze(c.actor,kind,c.id,plan!);if(!p||p.jobId!==c.id)throw Error('No matching frozen reexecution request');lock();
    const accepted=await client.send(p,currentActor()?.id??'',c.signal);if(!valid(c))return;q('status').textContent=t(msg('reexecution.accepted','已取得原子受理回执。新计算由服务端持有；关闭观察不会取消它。'));await chain();if(!valid(c))return;plan=null;q<HTMLInputElement>('confirm').checked=false;q('cost').textContent='';navigate(accepted.job.id);
    }catch(error){if(valid(c))q('status').textContent=String(error);}finally{if(valid(c)){busy=false;lock();}}}
  q('plan').onclick=()=>void preview();q('execute').onclick=()=>{if(plan?.eligible&&q<HTMLInputElement>('confirm').checked)void send(false);};q('replay').onclick=()=>void send(true);
  q('clear').onclick=()=>{try{client.clearRejected(actor,kind);plan=null;q('cost').textContent='';q('status').textContent='';lock();void chain();}catch(error){q('status').textContent=String(error);}};
  q('reason').oninput=()=>{plan=null;q<HTMLInputElement>('confirm').checked=false;q('cost').textContent='';q('blocks').textContent='';lock();};q('confirm').onchange=lock;
  function clear(){controller.abort();controller=new AbortController();generation++;id='';actor='';plan=null;busy=false;root.hidden=true;for(const field of ['chain','cost','previous','blocks','status'])q(field).replaceChildren();q<HTMLTextAreaElement>('reason').value='';q<HTMLInputElement>('confirm').checked=false;}
  window.addEventListener('voidplayer-identity-change',clear,{signal});window.addEventListener('storage',e=>{if(e.key==='voidplayer.identity')clear();},{signal});signal.addEventListener('abort',clear,{once:true});clear();
  return {clear,show(jobId:string){const owner=currentActor()?.id??'';if(!owner){clear();return;}if(id===jobId&&actor===owner)return;clear();id=jobId;actor=owner;root.hidden=false;try{lock();void chain();}catch(error){q('status').textContent=String(error);}}};
}
