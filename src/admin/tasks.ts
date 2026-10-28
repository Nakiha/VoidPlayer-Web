import {installQualityReexecution} from './quality-reexecution.ts';
import {REEXECUTION_KINDS,reexecutionKind} from '../../shared/analysis/quality/reexecution.ts';
import {canonicalJson} from '../../shared/analysis/quality/cambi.ts';
import {t,th,msg,formatDate} from '../i18n.ts';
import {currentActor,identityHealth} from '../services/identity.ts';
import {QualityClient} from '../services/quality-jobs.ts';
import {TASK_KINDS,TASK_METRICS,TASK_STATES,taskQuery,taskPath} from '../../shared/service/tasks.ts';
import type {TaskPage,TaskDetail,TaskKind,TaskSummary} from '../../shared/service/tasks.ts';
import type {AnnotationRecord} from '../../shared/review/annotation-record.ts';
import {qualityPairViewUrl} from '../../shared/review/quality-pair-view.ts';

export function tasksShell(){
  const select=(key:string,values:readonly string[],label:string)=>`<label>${label}<select name="${key}"><option value="">—</option>${values.map(v=>`<option>${v}</option>`).join('')}</select></label>`;
  return `<section id="pane-tasks" hidden><header class="admin-heading"><h1>${th(msg('tasks.title','任务中心'))}</h1></header>
  <p>${th(msg('tasks.scope','当前自述身份的准备、对应计划、单帧、区间、VMAF、XPSNR 和单源 CAMBI 历史。刷新读取新快照；翻页保留当时事实。关闭观察不取消后台工作，也不移动播放头。'))}</p>
  <form id="tasks-filters" class="admin-panel"><div class="admin-actions">
  <label>${th(msg('tasks.media','媒体 ID'))}<input name="mediaId" maxlength="24" spellcheck="false"></label>
  <label>${th(msg('tasks.version','媒体版本'))}<input name="mediaVersion" maxlength="24" spellcheck="false"></label>
  ${select('limit',['5','10','20','50'],th(msg('tasks.pageSize','每页条数')))}
  ${select('kind',TASK_KINDS,th(msg('tasks.kind','任务类型')))}${select('metric',TASK_METRICS,th(msg('tasks.metric','操作或指标')))}${select('state',TASK_STATES,th(msg('tasks.state','原始状态')))}
  <label>${th(msg('tasks.from','创建时间自（含，本地时间）'))}<input name="createdFrom" type="datetime-local" step="1"></label>
  <label>${th(msg('tasks.to','创建时间至（不含，本地时间）'))}<input name="createdTo" type="datetime-local" step="1"></label>
  </div><button type="submit">${th(msg('tasks.refresh','查询 / 刷新快照'))}</button><button id="tasks-reset" type="button">${th(msg('tasks.reset','清除筛选'))}</button></form>
  <p id="tasks-status" role="status"></p><p id="tasks-snapshot"></p><div id="tasks-list"></div>
  <button id="tasks-more" type="button" hidden>${th(msg('admin.nextPage','下一页'))}</button>
  <section id="tasks-detail" class="admin-panel" hidden><h2 id="tasks-title"></h2><pre id="tasks-facts"></pre>
  <button id="tasks-cancel" type="button" hidden>${th(msg('tasks.cancel','显式取消此任务'))}</button>
  <p id="tasks-cancel-status" role="status"></p><div id="tasks-related"></div><div id="tasks-links"></div><div id="tasks-candidates"></div><p id="tasks-reexecution-unavailable" hidden>${th(msg('tasks.reexecutionUnavailable','此任务类型尚不支持显式重新执行；不会替换指标或自动重算。'))}</p><section id="tasks-reexecution"></section></section></section>`;
}

/** Actor and selected-target fences apply after every await. Only filters and
 * a target are local preferences: never persist authorization or cursor tokens. */
export function installTasks(signal:AbortSignal){
  const $=<T extends HTMLElement=HTMLElement>(id:string)=>document.getElementById(`tasks-${id}`)as T;
  const form=$<HTMLFormElement>('filters'),api=new QualityClient();
  const reexecutions=new Map(REEXECUTION_KINDS.map(kind=>{const root=document.createElement('section');$('reexecution').append(root);return [kind,installQualityReexecution(root,kind,signal,id=>choose(kind,id))] as const;}));
  const clearReexecution=()=>{$('reexecution-unavailable').hidden=true;for(const view of reexecutions.values())view.clear();};
  let active=false,actor='',epoch=0,listGeneration=0,detailGeneration=0,next:string|null=null;
  let selected:{kind:TaskKind;id:string}|null=null,detail:TaskDetail|null=null;
  let life=new AbortController(),detailLife=new AbortController(),detailBusy=false;
  const fields=['limit','mediaId','mediaVersion','kind','metric','state','createdFrom','createdTo'];
  const filters=()=>{const p=new URLSearchParams();for(const key of fields){const value=(form.elements.namedItem(key)as HTMLInputElement).value;if(value)p.set(key,key==='createdFrom'||key==='createdTo'?String(new Date(value).getTime()):value);}return p;};
  const preferenceKey=()=>`voidplayer.tasks.v1.${actor}`;
  function save(){if(!actor)return;try{localStorage.setItem(preferenceKey(),JSON.stringify({filter:filters().toString(),selected}));}catch{}}
  function restore(){
    form.reset();(form.elements.namedItem('limit')as HTMLSelectElement).value='20';selected=null;
    try{const raw=localStorage.getItem(preferenceKey());if(raw&&raw.length<=4096){const p=JSON.parse(raw),params=new URLSearchParams(p.filter);taskQuery(params);for(const key of fields){let value=params.get(key)??'';if(value&&(key==='createdFrom'||key==='createdTo')){const date=new Date(Number(value));value=new Date(date.getTime()-date.getTimezoneOffset()*60000).toISOString().slice(0,19);}(form.elements.namedItem(key)as HTMLInputElement).value=value;}
      if(p.selected&&TASK_KINDS.includes(p.selected.kind)&&/^((?:vmaf|xpsnr|cambi)-)?[a-f0-9-]{36}$/.test(p.selected.id))selected=p.selected;}}
    catch{}
  }
  function reset(){
    clearReexecution();
    life.abort();detailLife.abort();life=new AbortController();detailLife=new AbortController();epoch++;listGeneration++;detailGeneration++;detailBusy=false;
    actor=currentActor()?.id??'';next=null;detail=null;$('list').replaceChildren();$('detail').hidden=true;$('more').hidden=true;$('status').textContent='';$('snapshot').textContent='';$('cancel-status').textContent='';$('cancel').toggleAttribute('disabled',false);for(const id of ['title','facts','related','links','candidates'])$(id).replaceChildren();delete $('candidates').dataset.state;restore();
  }
  const context=()=>({owner:actor,epoch,signal:AbortSignal.any([signal,life.signal])});
  const valid=(c:ReturnType<typeof context>)=>active&&!c.signal.aborted&&c.epoch===epoch&&c.owner===actor&&currentActor()?.id===actor;
  function choose(kind:TaskKind,id:string){clearReexecution();detailLife.abort();detailLife=new AbortController();detailGeneration++;detailBusy=false;selected={kind,id};detail=null;$('detail').hidden=true;for(const part of ['title','facts','related','links','candidates'])$(part).replaceChildren();delete $('candidates').dataset.state;$('cancel-status').textContent='';$('cancel').toggleAttribute('disabled',false);save();void loadDetail();}
  function row(task:TaskSummary){const button=document.createElement('button');button.type='button';button.dataset.taskId=task.id;button.dataset.taskKind=task.kind;
    button.textContent=`${task.kind} · ${task.state}${task.phase?` / ${task.phase}`:''} · ${task.metrics.join(', ')} · ${formatDate(task.createdAt)} · ${task.id}`;button.onclick=()=>choose(task.kind,task.id);return button;}
  async function list(more=false){
    const c=context(),generation=++listGeneration;if(!actor)return;
    try{const params=filters();taskQuery(params);if(more&&next)params.set('cursor',next);else next=null;
      const page=await api.request<TaskPage>(c.owner,`/api/tasks?${params}`,c.signal);
      if(!valid(c)||generation!==listGeneration)return;
      if(!more)$('list').replaceChildren();for(const task of page.entries)$('list').append(row(task));next=page.nextCursor;$('more').hidden=!next;
      $('snapshot').textContent=t(msg('tasks.snapshot','快照 {captured}；{count} 项。新状态需刷新；快照到期后重新查询。'),{captured:formatDate(page.capturedAt),count:page.total});$('status').textContent='';
    }catch(e){if(!valid(c)||generation!==listGeneration)return;
      if((e as {code?:string}).code==='task-cursor-expired'){next=null;$('list').replaceChildren();$('more').hidden=true;await list(false);if(valid(c))$('status').textContent=t(msg('tasks.expired','旧分页快照已失效，已按原筛选重新读取；选中目标保留。'));}
      else $('status').textContent=String(e);
    }
  }
  function link(href:string,label:string,root:HTMLElement){const a=document.createElement('a');a.href=href;a.textContent=label;a.target='_blank';a.rel='noopener';root.append(a,document.createElement('br'));}
  async function loadDetail(){
    if(!selected||detailBusy||!actor)return;detailBusy=true;
    const c=context(),target={...selected},generation=++detailGeneration,s=AbortSignal.any([c.signal,detailLife.signal]);
    const current=()=>valid(c)&&!s.aborted&&generation===detailGeneration&&selected?.kind===target.kind&&selected?.id===target.id;
    try{const value=await api.request<TaskDetail>(c.owner,taskPath(target.kind,target.id),s);if(!current())return;detail=value;
      if(reexecutionKind(target.kind))reexecutions.get(target.kind)!.show(target.id);$('reexecution-unavailable').hidden=true;
      $('detail').hidden=false;$('title').textContent=`${value.task.kind} · ${value.task.state} · ${value.task.id}`;$('facts').textContent=JSON.stringify(value.task,null,2);
      $('cancel').hidden=!value.links.some(l=>l.rel==='cancel');$('related').replaceChildren();$('links').replaceChildren();$('candidates').replaceChildren();
      for(const related of value.related){const b=document.createElement('button');b.type='button';b.textContent=`${related.relation} · ${related.kind} · ${related.id}`;b.dataset.relatedId=related.id;b.onclick=()=>choose(related.kind,related.id);$('related').append(b);}
      for(const l of value.links)if(!['cancel','reexecution-plan'].includes(l.rel))link(l.href,l.rel,$('links'));
      $('candidates').dataset.state='loading';const receipt=value.links.find(l=>l.rel==='candidate-receipt');if(!receipt){$('candidates').dataset.state='ready';return;}
      const publication=await api.request<{policy:{space:string};createdIds:string[];selected:{id:string;evidence?:unknown;ref?:unknown}[]}|null>(c.owner,receipt.href,s);if(!current())return;if(!publication){$('candidates').dataset.state='ready';return;}
      for(const id of publication.createdIds){
        const record=await api.request<AnnotationRecord>(c.owner,`/api/annotations/spaces/${encodeURIComponent(publication.policy.space)}/${encodeURIComponent(id)}`,s);if(!current())return;
        const frozen=publication.selected.find(item=>item.id===id);if(!frozen)continue;
        for(const evidence of record.document.mark.cambiEvidence??[]){if(value.task.kind!=='cambi'||!frozen.ref||evidence.verification!=='server-verified'||evidence.serviceOrigin!==location.origin||canonicalJson(evidence.ref)!==canonicalJson(frozen.ref))continue;
          const query=new URLSearchParams({cambi:'1',space:record.space,annotationId:record.id,evidenceId:evidence.id});link('/quality.html?'+query,`${id} · ${t(msg('cambi.open','CAMBI · 查看原始热图、源快照与真实区域'))}`,$('candidates'));}
        for(const evidence of record.document.mark.qualityEvidence??[]){const expected=(frozen.evidence??frozen.ref)as typeof evidence.ref|undefined;if(!expected||(['jobId','attemptId','digest','side']as const).some(k=>evidence.ref[k]!==expected[k]))continue;
          link(qualityPairViewUrl({space:record.space,annotationId:record.id,evidenceId:evidence.id},location.origin),`${id} · ${t(msg('quality.openPair','在新窗口查看原帧对与 ROI'))}`,$('candidates'));}
      }
      $('candidates').dataset.state='ready';
    }catch(e){if(current()){$('candidates').dataset.state='failed';$('status').textContent=String(e);}}
    finally{if(generation===detailGeneration)detailBusy=false;}
  }
  form.onsubmit=e=>{e.preventDefault();save();void list();void loadDetail();};
  $('reset').onclick=()=>{form.reset();(form.elements.namedItem('limit')as HTMLSelectElement).value='20';save();void list();};
  $('more').onclick=()=>void list(true);
  $('cancel').onclick=()=>{
    if(!selected||!detail||detail.task.id!==selected.id)return;
    const c=context(),target={...selected},s=AbortSignal.any([c.signal,detailLife.signal]);
    $('cancel').toggleAttribute('disabled',true);
    void api.request<TaskDetail>(c.owner,taskPath(target.kind,target.id)+'/cancel',s,'POST',{},undefined,target.kind==='preparation'?'library-preparation':'quality-job')
      .then(()=>{if(valid(c)&&!s.aborted&&selected?.kind===target.kind&&selected?.id===target.id){$('cancel-status').textContent=t(msg('tasks.cancelled','已向原任务服务提交取消；以服务端状态及实际退出为准。'));void loadDetail();}})
      .catch(e=>{if(valid(c)&&!s.aborted)$('cancel-status').textContent=t(msg('tasks.cancelUnknown','取消回执尚未确认：{error}。请读取原任务；重复取消不会创建新计算。'),{error:String(e)});})
      .finally(()=>{if(valid(c)&&!s.aborted)$('cancel').toggleAttribute('disabled',false);});
  };
  const changed=()=>{reset();if(active){void list();void loadDetail();}};
  window.addEventListener('voidplayer-identity-change',changed,{signal});
  window.addEventListener('storage',e=>{if(e.key!=='voidplayer.identity')return;reset();actor='';selected=null;form.reset();const version=epoch;void identityHealth().then(()=>{if(epoch===version)changed();},()=>{});},{signal});
  const timer=setInterval(()=>{if(active&&!document.hidden)void loadDetail();},2000);
  signal.addEventListener('abort',()=>{clearInterval(timer);life.abort();detailLife.abort();},{once:true});
  return {activate(value:boolean){if(active===value)return;active=value;reset();if(active){void list();void loadDetail();}}};
}
