import {FrozenSubmissionJournal,assertJobReceipt} from '../services/frozen-submission.ts';
import type {FrozenSubmission} from '../services/frozen-submission.ts';
import {QualityObservationScope} from '../analysis/quality/observation-scope.ts';
import { th,t,msg,onLanguageChange } from '../i18n.ts';
import { confirmedActor,observeIdentity,identityHealth } from '../services/identity.ts';
import { LibraryDiscoveryClient } from '../services/library-discovery.ts';
import type { DiscoveryItem,DiscoveryPage } from '../services/library-discovery.ts';
import { parseDiscoveryQuery,preparationInput } from '../../shared/media/discovery.ts';
import type { PreparationInput,PreparationJob } from '../../shared/media/discovery.ts';
import { randomUUID } from '../../shared/utils/uuid.ts';

export function discoveryShell(){return `<section id="pane-discovery" hidden><header class="admin-heading"><div><h1>${th(msg('discovery.title','技术选片与显式准备'))}</h1><p>${th(msg('discovery.scope','按已缓存技术证据选片。未知不是不匹配；读取不探测、不构建索引，也不移动播放器。元数据可读不表示可评分，评分仍逐源核验可信缓存与精确 AU。'))}</p></div></header>
  <form id="discovery-query" class="admin-panel"><label>${th(msg('libraryBrowser.scopeLabel','媒体库范围'))}<select id="discovery-root"><option value="">${th(msg('libraryBrowser.allLibraries','所有媒体库'))}</option></select></label><label>${th(msg('admin.search','搜索'))}<input id="discovery-search" type="search" maxlength="300"></label>
  <div class="quality-roi"><label>codec<input id="discovery-codec" maxlength="64" placeholder="h264 / hevc"></label><label>${th(msg('discovery.width','最小宽度（源像素）'))}<input id="discovery-minWidth" type="number" min="1" max="16384" step="1"></label><label>${th(msg('discovery.maxWidth','最大宽度（源像素）'))}<input id="discovery-maxWidth" type="number" min="1" max="16384" step="1"></label><label>${th(msg('discovery.height','最小高度（源像素）'))}<input id="discovery-minHeight" type="number" min="1" max="16384" step="1"></label><label>${th(msg('discovery.maxHeight','最大高度（源像素）'))}<input id="discovery-maxHeight" type="number" min="1" max="16384" step="1"></label><label>${th(msg('discovery.depth','位深（已知证据）'))}<input id="discovery-bitDepth" type="number" min="1" max="16" step="1"></label><label>${th(msg('discovery.transfer','源传递函数'))}<input id="discovery-colorTransfer" placeholder="bt709 / pq / hlg"></label><label>${th(msg('discovery.duration','最小时长（整数微秒）'))}<input id="discovery-minDurationUs" type="number" min="1" step="1"></label><label>${th(msg('discovery.maxDuration','最大时长（整数微秒）'))}<input id="discovery-maxDurationUs" type="number" min="1" step="1"></label></div>
  <label><input id="discovery-records-ready" type="checkbox">${th(msg('discovery.recordsReady','要求已有有界缓存记录适配器（不是可评分保证）'))}</label><label><input id="discovery-include-unknown" type="checkbox" checked>${th(msg('discovery.keepUnknown','保留未知结果，显示缺失原因'))}</label><button type="submit" id="discovery-search-button">${th(msg('admin.search','搜索'))}</button><button type="button" id="discovery-next" hidden>${th(msg('admin.nextPage','下一页'))}</button><p id="discovery-query-status" role="status"></p><p id="discovery-coverage"></p><div id="discovery-list" class="quality-media-list"></div></form>
  <section id="discovery-detail" class="admin-panel" hidden><h2 id="discovery-name"></h2><p id="discovery-source"></p><p id="discovery-readiness" role="status"></p><select id="discovery-stream" aria-label="${th(msg('discovery.stream','明确选择技术流'))}"></select><pre id="discovery-fields"></pre>
  <p>${th(msg('discovery.prepareHelp','准备必须显式提交。probe 仅做有界技术读取（4MiB / 512次 / 32流 / 30秒）；可信 FLV / 非分片 MP4 索引准备另受64MiB来源与128MiB读取预算，MP4 还须通过单视频轨、精确时钟与闭合 IDR 校验。两者均由服务持有，关页不取消，明确取消后等待 Worker 真实退出；不自动重试。'))}</p>
  <div class="admin-button-group"><button id="discovery-probe" type="button">${th(msg('discovery.probe','显式读取技术信息'))}</button><button id="discovery-index" type="button" disabled>${th(msg('discovery.index','显式准备可信 FLV / MP4 索引'))}</button><button id="discovery-check" type="button">${th(msg('discovery.check','只读检查评分来源'))}</button></div><p id="discovery-write-status" role="status"></p>
  <button id="discovery-retry" type="button" hidden>${th(msg('discovery.retry','用原幂等键重试未知提交'))}</button><button id="discovery-forget" type="button" hidden>${th(msg('discovery.forget','结束此重试（已受理任务仍可能继续）'))}</button>
  <div id="discovery-quality-links" hidden><a id="discovery-reference" target="_blank" rel="noopener">${th(msg('discovery.reference','作为参考源打开测量'))}</a> · <a id="discovery-distorted" target="_blank" rel="noopener">${th(msg('discovery.distorted','作为待测源打开测量'))}</a></div>
  <details><summary>${th(msg('discovery.facts','完整技术事实、覆盖与缺失原因'))}</summary><pre id="discovery-json"></pre></details></section>
  <section class="admin-panel"><h2>${th(msg('discovery.jobs','当前用户的显式准备历史'))}</h2><p id="discovery-owner"></p><p>${th(msg('discovery.jobLifetime','网络错误不是任务失败。关闭页面只停止观察；终态、attempt 与结果以同一后台记录为准。'))}</p><button id="discovery-refresh-jobs" type="button">${th(msg('qualityWorkflow.refresh','刷新任务'))}</button><button id="discovery-more-jobs" type="button" hidden>${th(msg('admin.nextPage','下一页'))}</button><p id="discovery-job-status" role="status"></p><div id="discovery-jobs" class="quality-media-list"></div><button id="discovery-cancel" type="button" disabled>${th(msg('qualityWorkflow.cancel','取消任务'))}</button><pre id="discovery-job"></pre></section></section>`;}

type Pending=FrozenSubmission<PreparationInput>;
export function installDiscovery(signal:AbortSignal){
  const $=<T extends HTMLElement=HTMLElement>(id:string)=>document.getElementById(`discovery-${id}`)as T;
  const api=new LibraryDiscoveryClient();let active=false,owner='',busy=false,invalidDraft=false;const observation=new QualityObservationScope();
  let querySequence=0,detailSequence=0,identitySequence=0;
  let selected:DiscoveryItem|null=null,page:DiscoveryPage|null=null,job:PreparationJob|null=null,pending:Pending|null=null,moreJobs:number|null=null,historyAdvanced=false,selectedJobId='';
  let queryParams=new URLSearchParams();
  let client:string;try{client=sessionStorage.getItem('voidplayer-library-discovery-client')??randomUUID();if(!/^[a-zA-Z0-9._:-]{1,80}$/.test(client))client=randomUUID();sessionStorage.setItem('voidplayer-library-discovery-client',client);}catch{client=randomUUID();}
  const pendingKey=(actor:string)=>`voidplayer-library-preparation:${actor}:${client}`;
  const journal=new FrozenSubmissionJournal<PreparationInput>(sessionStorage,pendingKey,preparationInput,{
    read(value:any,actor){if(value?.actor!==actor||value?.input?.client?.id!==client)throw Error('Stored preparation owner mismatch');return {...value,body:value.input};},
    write(value,actor){const {body,...rest}=value;return {...rest,actor,input:body};},
  });
  const context=(level:'actor'|'selection'='actor',key?:string)=>({owner,...observation.capture(level,key)});
  const valid=(c:ReturnType<typeof context>)=>active&&!signal.aborted&&c.current()&&owner===c.owner&&(confirmedActor()?.id??'')===c.owner;
  const error=(e:unknown)=>e instanceof Error?e.message:String(e);
  const terminal=(state:string)=>!['queued','running','cancelling'].includes(state);
  function actions(){for(const id of ['probe','index','check'])$(id).toggleAttribute('disabled',!selected||!owner||!!pending||invalidDraft||busy||id==='index'&&!['flv','mp4'].includes(String(selected.technical.probe?.container.value)));
    $('retry').hidden=!pending;$('forget').hidden=!pending&&!invalidDraft;$('retry').toggleAttribute('disabled',busy||!owner);$('forget').toggleAttribute('disabled',busy);
    $('cancel').toggleAttribute('disabled',!owner||!job||terminal(job.state)||job.state==='cancelling');
    $('write-status').textContent=pending?t(msg('discovery.pending','提交结果未知；内容已冻结。重试复用原 actor、client 与幂等键，不会另建任务。')):'';}
  function renderDetail(){if(!selected){$('detail').hidden=true;actions();return;}$('detail').hidden=false;$('name').textContent=selected.file.name;$('source').textContent=`${selected.source.id}@${selected.source.version}`;
    $('json').textContent=JSON.stringify(selected,null,2);$('quality-links').hidden=true;
    $('readiness').textContent=selected.technical.probe?['flv','mp4'].includes(String(selected.technical.probe.container.value))?t(msg('discovery.metadataOnly','已读取技术证据；尚未据此核验评分来源。技术流/时钟不是评分 AU 身份。')):t(msg('discovery.metadataContainerOnly','此容器已提供技术信息；可信索引准备与评分仍限严格 FLV/Enhanced FLV 和非分片 MP4 子集。Matroska、TS 等能读取或播放，不等于可评分。')):`${selected.technical.state}: ${selected.technical.reason}`;
    const streams=selected.technical.streams,select=$<HTMLSelectElement>('stream');select.replaceChildren();
    for(const stream of streams)select.add(new Option(`${stream.id} · ${stream.type} · ${stream.fields.codec?.value??'?'}`,stream.id));
    renderFields();actions();}
  function renderFields(){const stream=selected?.technical.streams.find(s=>s.id===$<HTMLSelectElement>('stream').value);$('fields').textContent=stream?JSON.stringify({fields:stream.fields,clock:stream.clock,...(stream.cachedIndex?{cachedIndex:stream.cachedIndex}:{})},null,2):t(msg('discovery.noStream','没有已准备的流证据；缺失字段不能填零。'));}
  async function select(item:DiscoveryItem){if(pending||invalidDraft||busy)return;const c=context(),ticket=++detailSequence;selected=item;renderDetail();try{const detail=await api.detail(item.source,c.owner,c.signal);if(valid(c)&&ticket===detailSequence){selected=detail;renderDetail();}}catch(e){if(valid(c)&&ticket===detailSequence)$('readiness').textContent=error(e);}}
  async function browse(more=false){const c=context(),ticket=++querySequence;
    try{if(!more){queryParams=new URLSearchParams({limit:'16',includeUnknown:$<HTMLInputElement>('include-unknown').checked?'1':'0'});
        for(const key of ['root','search','codec','minWidth','maxWidth','minHeight','maxHeight','bitDepth','colorTransfer','minDurationUs','maxDurationUs']){const value=$<HTMLInputElement>(key).value;if(value)queryParams.set(key,value);}if($<HTMLInputElement>('records-ready').checked)queryParams.set('recordsReady','1');parseDiscoveryQuery(queryParams);}
      const params=new URLSearchParams(queryParams);if(more&&page?.nextCursor)params.set('cursor',page.nextCursor);
      $('query-status').textContent='';const result=await api.browse(params,c.owner,c.signal);if(!valid(c)||ticket!==querySequence)return;page=result;
      $('next').hidden=!result.nextCursor;$('list').replaceChildren();for(const entry of result.entries){const button=document.createElement('button');button.type='button';button.dataset.sourceId=entry.source.id;
        button.textContent=`${entry.file.root} / ${entry.file.name} · ${entry.technical.state} · ${entry.decision?.state??'unknown'} · ${entry.decision?.reason??''}`;button.onclick=()=>void select(entry);$('list').append(button);}
      const count=result.coverage.cumulative;$('coverage').textContent=t(msg('discovery.coverage','已按 ID 顺序扫描 {candidates} 个候选；范围内已检查 {inspected}/{total}：匹配 {match}，未知 {unknown}，不匹配 {notMatch}。总数仅在穷尽后成立，不证明磁盘文件完整发现。'),{...count,candidates:result.coverage.candidates.cumulative,total:result.coverage.total??'?'});
    }catch(e){if(valid(c)&&ticket===querySequence){$('query-status').textContent=error(e);$('next').hidden=true;}}
  }
  function chooseJob(id:string){observation.select();selectedJobId=id;job=null;actions();return inspectJob(id);}
  function inspectJob(id:string):Promise<void>{return observation.run('job','selection',async()=>{const c=context('selection','job');try{const value=await api.job(id,c.owner,c.signal);if(!valid(c)||id!==selectedJobId)return;
      job=value;$('job').textContent=JSON.stringify(value,null,2);actions();
      if(value.state==='completed'&&selected&&value.input.source.id===selected.source.id&&value.input.source.version===selected.source.version){const detailTicket=detailSequence;const fresh=await api.detail(selected.source,c.owner,c.signal);if(valid(c)&&id===selectedJobId&&detailTicket===detailSequence){selected=fresh;renderDetail();}}
    }catch(e){if(valid(c)&&id===selectedJobId)$('job-status').textContent=error(e);}});}
  function history(more=false):Promise<void>{const before=more?moreJobs??0:0;if(more)historyAdvanced=true;return observation.run('history','actor',async()=>{if(!owner)return;const c=context('actor','history');try{const result=await api.jobs(c.owner,c.signal,before);if(!valid(c))return;
      moreJobs=result.next;$('more-jobs').hidden=moreJobs===null;if(more)historyAdvanced=true;
      const list=$('jobs'),existing=new Map([...list.querySelectorAll<HTMLButtonElement>('button[data-job-id]')].map(b=>[b.dataset.jobId!,b]));
      for(const [index,value] of result.jobs.entries()){const button=existing.get(value.id)??document.createElement('button');existing.delete(value.id);button.type='button';button.dataset.jobId=value.id;const label=`${value.state} · ${value.input.operation} · ${value.input.source.id}@${value.input.source.version} · ${value.id}`;if(button.textContent!==label)button.textContent=label;button.onclick=()=>void chooseJob(value.id);
        if(more){if(!button.isConnected)list.append(button);}else if(list.children[index]!==button)list.insertBefore(button,list.children[index]??null);}
      if(!more)for(const button of existing.values())button.remove();
    }catch(e){if(valid(c))$('job-status').textContent=t(msg('discovery.observeError','观察暂不可用：{error}。不表示后台任务失败。'),{error:error(e)});}},`${more}:${before}`);}
  async function submit(operation?:PreparationInput['operation']){if(busy||!owner||!active||invalidDraft)return;const c=context(),view=context('selection');
    try{
      if(!pending){if(!selected||!operation)return;sessionStorage.setItem('voidplayer-library-discovery-client',client);
        pending=journal.freeze(c.owner,preparationInput({source:selected.source,operation,client:{id:client,name:'Library discovery GUI'}}));}
      const frozen=pending;busy=true;actions();
      const accepted=await journal.execute(c.owner,frozen.key,p=>api.submit(p.body,p.key,c.owner,c.signal),(r,p)=>{
        assertJobReceipt(r,c.owner,p);
        if(r.job.schema!=='voidplayer-library-preparation'||r.job.version!==1||r.job.submitted.clientId!==p.body.client.id||!Number.isSafeInteger(r.job.revision)||r.job.revision<1)throw Error('Invalid preparation acknowledgement');
      },false,'keep');
      if(!valid(c))return;pending=journal.pending(c.owner);actions();
      if(valid(view))await chooseJob(accepted.job.id);await history();
    }catch(e){if(valid(c))$('job-status').textContent=error(e);}finally{if(valid(c)){busy=false;pending=journal.pending(c.owner);actions();}}}
  async function start(){observation.invalidate();owner=confirmedActor()?.id??'';
    selected=null;page=null;job=null;pending=null;busy=false;invalidDraft=false;selectedJobId='';moreJobs=null;historyAdvanced=false;renderDetail();$('list').replaceChildren();$('jobs').replaceChildren();$('job').textContent='';$('job-status').textContent='';
    $('owner').textContent=confirmedActor()?`${confirmedActor()!.name} · ${owner} · ${client}`:t(msg('qualityWorkflow.identityRequired','请先选择服务身份。'));
    try{pending=journal.pending(owner);}
    catch{invalidDraft=true;$('detail').hidden=false;$('job-status').textContent=t(msg('discovery.invalidDraft','保存的本地请求无效；保留原内容。请显式结束本地重试后再创建请求。'));}
    actions();if(!active||!owner)return;const c=context();if(pending){try{const fresh=await api.detail(pending.body.source,c.owner,c.signal);if(valid(c)){selected=fresh;renderDetail();}}catch(e){if(valid(c)&&pending){$('detail').hidden=false;$('source').textContent=`${pending.body.source.id}@${pending.body.source.version}`;$('readiness').textContent=error(e);actions();}}}
    try{const roots=await api.request<{roots:{id:string;name:string}[]}>('/api/library/browse?recursive=1&limit=1',c.owner,c.signal);if(valid(c)){const control=$<HTMLSelectElement>('root'),old=control.value;control.replaceChildren(new Option(t(msg('libraryBrowser.allLibraries','所有媒体库')),''));for(const root of roots.roots)control.add(new Option(root.name,root.id));control.value=[...control.options].some(o=>o.value===old)?old:'';}}
    catch(e){if(valid(c))$('query-status').textContent=error(e);}
    if(valid(c)){void browse();void history();}}
  $('query').onsubmit=event=>{event.preventDefault();void browse();};$('next').onclick=()=>void browse(true);$('stream').onchange=renderFields;
  $('probe').onclick=()=>void submit('probe');$('index').onclick=()=>void submit('quality-index');$('retry').onclick=()=>void submit();
  $('forget').onclick=()=>{if(busy)return;try{journal.abandon(owner);pending=null;invalidDraft=false;actions();}catch(e){$('job-status').textContent=error(e);}};
  $('check').onclick=async()=>{if(!selected||!owner)return;const c=context(),source=selected.source,ticket=detailSequence;$('quality-links').hidden=true;try{
    const proof=await api.request<unknown>(selected.scoring.source,c.owner,c.signal);if(!valid(c)||ticket!==detailSequence)return;
    $('readiness').textContent=t(msg('discovery.qualityChecked','此刻可信来源检查通过；测量选择和执行仍重新核验 AU、颜色、源版本与缓存身份。'));
    $('fields').textContent=JSON.stringify(proof,null,2);$('quality-links').hidden=false;
    for(const side of ['reference','distorted'])$<HTMLAnchorElement>(side).href=`/admin/?quality${side==='reference'?'Reference':'Distorted'}=${source.id}@${source.version}#quality`;
  }catch(e){if(valid(c)&&ticket===detailSequence)$('readiness').textContent=error(e);}};
  $('refresh-jobs').onclick=()=>{historyAdvanced=false;void history();if(job)void inspectJob(job.id);};$('more-jobs').onclick=()=>void history(true);
  $('cancel').onclick=async()=>{if(!job||terminal(job.state))return;const c=context(),id=job.id;try{await api.cancel(id,c.owner,c.signal);if(valid(c)&&selectedJobId===id)await inspectJob(id);}catch(e){if(valid(c))$('job-status').textContent=error(e);}};
  observeIdentity(signal,{invalidated:()=>{identitySequence++;observation.invalidate();owner='';selected=null;job=null;pending=null;renderDetail();$('jobs').replaceChildren();$('job').textContent='';},confirmed:()=>{if(active)void start();},failed:e=>{if(active)$('job-status').textContent=error(e);}});
  const timer=setInterval(()=>{if(active&&owner&&!document.hidden){if(!historyAdvanced)void history();if(job&&!terminal(job.state))void inspectJob(job.id);}},1000);
  signal.addEventListener('abort',()=>{observation.close();clearInterval(timer);},{once:true});onLanguageChange(()=>{if(active)renderDetail();},signal);
  return {activate(value:boolean){active=value;observation.invalidate();if(!value)return;const ticket=++identitySequence;void identityHealth().then(()=>{if(active&&ticket===identitySequence)void start();}).catch(e=>{if(active)$('job-status').textContent=error(e);});}};
}
