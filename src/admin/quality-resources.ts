import {th,t,msg,formatDate} from '../i18n.ts';
import {localizedText,type LocalizedValue} from '../ui/live-localization.ts';
import {observeIdentity,confirmedActor} from '../services/identity.ts';
import {requestError,rootReason} from './diagnostics.ts';
import {qualityResourceLimits} from '../../shared/service/quality-resources.ts';
import type {QualityResourceSettings,QualityResourceLimits} from '../../shared/service/quality-resources.ts';

const fields = () => [
  ['concurrency',t(msg('qualityResources.concurrency','评分总并发')),1,8],
  ['psnr', 'PSNR / SSIM',1,4], ['vmaf','VMAF',1,4], ['xpsnr','XPSNR',1,4], ['cambi','CAMBI',1,4],
  ['outstanding',t(msg('qualityResources.outstanding','未完成计算总上限')),1,128],
  ['actorOutstanding',t(msg('qualityResources.actorOutstanding','每人未完成计算上限')),1,32],
  ['memoryBytes',t(msg('qualityResources.memory','同时预留的内存（MiB）')),256,32768],
  ['readBytes',t(msg('qualityResources.read','同时预留的读取量（MiB）')),16,262144],
  ['threads',t(msg('qualityResources.threads','计算线程总上限')),1,32],
] as const;

export function qualityResourceShell() {
  return `<form id="quality-resources" class="admin-panel">
    <h2>${th(msg('qualityResources.title','评分资源'))}</h2>
    <p>${th(msg('qualityResources.help','所有评分任务共用这些限制。调低只影响后续准入，不会中断正在执行的任务。评分与索引构建、码流分析互斥；元数据准备和对应规划各限一路。'))}</p>
    <div class="quality-resource-fields">${fields().map(([key,label,min,max])=>`<label>${label}<input data-quality-resource="${key}" type="number" min="${min}" max="${max}" step="1" required disabled></label>`).join('')}</div>
    <p id="quality-resource-status" class="admin-caption" role="status"></p>
    <p class="admin-caption">${th(msg('qualityResources.reservationHelp','内存和读取量显示已准入任务的预算预留，不是操作系统内存限额或实时网速。当前计算核为单线程；每个算法上限仍须同时满足总并发及资源预算。'))}</p>
    <div class="admin-panel-footer"><span id="quality-resource-save-state" role="status"></span><div class="admin-button-group">
      <button id="quality-resource-reload" type="button">${th(msg('admin.analysisReload','载入配置'))}</button>
      <button id="quality-resource-save" type="submit" class="admin-primary" disabled>${th(msg('qualityResources.save','保存评分配置'))}</button>
    </div></div>
    <details><summary>${th(msg('qualityResources.history','最近的配置变更'))}</summary><ol id="quality-resource-history"></ol></details>
  </form>`;
}

export function installQualityResources(signal:AbortSignal,
  api:<T>(url:string,method?:string,body?:unknown,headers?:Record<string,string>)=>Promise<T>,
  notice:(value:LocalizedValue,error?:boolean)=>void) {
  const form=document.getElementById('quality-resources') as HTMLFormElement;
  const nodes=new Map([...form.querySelectorAll<HTMLElement>('[id]')].map(node=>[node.id,node]));
  const $=(id:string)=>nodes.get('quality-resource-'+id)!;
  const inputs=[...form.querySelectorAll<HTMLInputElement>('[data-quality-resource]')];
  let settings:QualityResourceSettings|undefined,dirty=false,busy=false,epoch=0;
  function controls(){
    if(signal.aborted||!form.isConnected)return;
    for(const input of inputs)input.disabled=busy||!settings?.writable;
    $('save').toggleAttribute('disabled',busy||!dirty||!settings?.writable||!inputs.every(i=>i.validity.valid));
    $('reload').toggleAttribute('disabled',busy);
    localizedText($('save-state'),()=>busy?t(msg('admin.saving','正在保存…')):settings?.reasonCode?rootReason(settings.reasonCode,null):dirty?t(msg('admin.unsavedChanges','有未保存的修改')):'');
  }
  function draft():QualityResourceLimits {
    const limits=structuredClone(settings!.limits);
    for(const input of inputs){const key=input.dataset.qualityResource!,n=input.valueAsNumber;
      if(['psnr','vmaf','xpsnr','cambi'].includes(key))limits.perExecutor[key as 'psnr']=n;
      else (limits as unknown as Record<string,number>)[key]=n*(key.endsWith('Bytes')?1024**2:1);
    }
    return qualityResourceLimits(limits);
  }
  function accept(value:QualityResourceSettings){
    settings=value;dirty=false;
    for(const input of inputs){const key=input.dataset.qualityResource!;
      const n=['psnr','vmaf','xpsnr','cambi'].includes(key)?value.limits.perExecutor[key as 'psnr']:value.limits[key as 'concurrency'];
      input.value=String(n/(key.endsWith('Bytes')?1024**2:1));
    }
    localizedText($('status'),()=>t(msg('qualityResources.status','{running} 项运行 · {outstanding} 项未完成 · 预留内存 {memory} MiB · 预留读取 {read} MiB · {threads} 个线程'),{running:value.running,outstanding:value.outstanding,memory:Math.ceil(value.reservations.memoryBytes/1024**2),read:Math.ceil(value.reservations.readBytes/1024**2),threads:value.reservations.threads}));
    $('history').replaceChildren(...[...value.history].reverse().map(c=>{const label=document.createElement('span');
      localizedText(label,()=>t(msg('qualityResources.change','{date} · {actor} · 总并发 {before} → {after}'),{date:formatDate(new Date(c.at).toISOString()),actor:c.actor.name,before:c.before.concurrency,after:c.after.concurrency}));
      const detail=document.createElement('pre');detail.textContent=JSON.stringify({before:c.before,after:c.after},null,2);const row=document.createElement('li');row.append(label,detail);return row;}));
  }
  async function load(reset=false){
    const actor=confirmedActor();if(busy||!actor||(dirty&&!reset))return;
    const ticket=epoch;busy=true;controls();
    try{const value=await api<QualityResourceSettings>('/api/admin/quality-resources');if(!signal.aborted&&form.isConnected&&epoch===ticket)accept(value);}
    catch(error){if(!signal.aborted&&epoch===ticket)notice(()=>requestError(error),true);}
    finally{if(epoch===ticket){busy=false;controls();}}
  }
  form.addEventListener('input',()=>{dirty=true;controls();},{signal});
  $('reload').addEventListener('click',()=>void load(true),{signal});
  form.addEventListener('submit',event=>{event.preventDefault();const actor=confirmedActor();if(!actor||busy||!dirty||!settings?.writable||!form.reportValidity())return;
    let limits;try{limits=draft();}catch(error){notice(()=>requestError(error),true);return;}
    const ticket=epoch;busy=true;controls();
    void api<QualityResourceSettings>('/api/admin/quality-resources','PUT',{revision:settings.revision,limits},{'x-voidplayer-actor':actor.id})
      .then(value=>{if(epoch===ticket&&!signal.aborted)accept(value);}).catch(error=>{if(epoch===ticket&&!signal.aborted)notice(()=>requestError(error),true);})
      .finally(()=>{if(epoch===ticket){busy=false;controls();}});
  },{signal});
  observeIdentity(signal,{invalidated(){epoch++;settings=undefined;dirty=false;busy=false;for(const i of inputs)i.value='';$('status').replaceChildren();$('history').replaceChildren();controls();},confirmed(){void load();},failed(error){notice(()=>requestError(error),true);}});
  const timer=setInterval(()=>{if(!document.hidden&&!document.getElementById('pane-overview')?.hidden)void load();},2500);
  signal.addEventListener('abort',()=>{epoch++;clearInterval(timer);},{once:true});controls();
  return {load,get dirty(){return dirty;}};
}
