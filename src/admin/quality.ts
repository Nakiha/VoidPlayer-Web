import { ssimPlan, SSIM_VARIANT } from '../../shared/analysis/quality/ssim.ts';
import { localizedText, type LocalizedValue } from '../ui/live-localization.ts';
import { t, th, msg, onLanguageChange, formatDate } from '../i18n.ts';
import { currentActor,identityHealth } from '../services/identity.ts';
import { QualityClient } from '../services/quality-jobs.ts';
import { QualityJobObserver, type QualityObservation } from '../analysis/quality/job-observer.ts';
import type { QualityFramePage } from '../../shared/analysis/quality/selection.ts';
import type { PairTarget } from '../../shared/analysis/quality/frame-pair.ts';
import type { QualityJobInput } from '../../shared/analysis/quality/jobs.ts';
import { terminalQualityJob } from '../../shared/analysis/quality/jobs.ts';
import type { LibraryPage, LibraryEntry } from '../services/library.ts';
import type { AnnotationRecord } from '../../shared/review/annotation-record.ts';
import { AnnotationClient } from '../review/annotation-client.ts';
import { attachAnnotationQuality, type QualityAttachmentCommand } from '../review/quality-evidence-client.ts';
import { qualityEvidenceValue } from '../../shared/review/quality-evidence.ts';
import { qualityPairViewUrl } from '../../shared/review/quality-pair-view.ts';
import { qualityFacts } from '../ui/quality-evidence.ts';
import { randomUUID } from '../../shared/utils/uuid.ts';
import { psnrGridPlan } from '../../shared/analysis/quality/psnr.ts';

const sides=['reference','distorted'] as const;
type Side=typeof sides[number];
const sideLabel=(side:Side)=>side==='reference'?t(msg('qualityWorkflow.reference','参考片源')):t(msg('qualityWorkflow.distorted','待测片源'));
export function qualityJobsShell(){
  const source=(side:Side)=>`<fieldset data-quality-source="${side}"><legend>${sideLabel(side)}</legend>
    <div class="admin-actions"><input data-search type="search" aria-label="${th(msg('qualityWorkflow.searchMedia','搜索媒体库'))}"><button type="button" data-search-button>${th(msg('admin.search','搜索'))}</button><button type="button" data-more hidden>${th(msg('admin.nextPage','下一页'))}</button></div>
    <div data-media-list class="quality-media-list"></div><p data-source-status role="status"></p><details data-proof hidden><summary>${th(msg('qualityWorkflow.sourceProof','来源、缓存身份与几何见证'))}</summary><pre data-source-proof></pre></details>
    <label>${th(msg('qualityWorkflow.frame','明确选择缓存 AU / 源 PTS'))}<select data-frame disabled><option value="">—</option></select></label>
    <button type="button" data-frame-more hidden>${th(msg('qualityWorkflow.moreFrames','下一页候选帧'))}</button></fieldset>`;
  return `<section id="pane-quality" hidden><header class="admin-heading"><div><h1>${th(msg('qualityWorkflow.title','单帧 PSNR 任务'))}</h1>
    <p>${th(msg('qualityWorkflow.scope','显式配对媒体库中的闭合关键帧或有界前向依赖帧，以 8/10 位 YUV420 原始码值测量。依赖帧须从明确闭合起点逐 AU 解码，每侧最多 32 AU，且每个输入立即输出唯一帧。拒绝重排、延迟输出和序列，不自动按时间配对。'))}</p></div></header>
    <p id="quality-owner"></p><p id="quality-availability" role="status"></p><p>${th(msg('qualityWorkflow.lifetime','任务由服务持有。关闭此页或切换分类只停止观察；仅“取消任务”会请求终止。网络故障不表示任务失败。'))}</p>
    <label>${th(msg('qualityWorkflow.client','本页客户端 ID'))}<input id="quality-client" maxlength="80" spellcheck="false"><button id="quality-client-apply" type="button">${th(msg('qualityWorkflow.useClient','使用此客户端'))}</button></label>
    <form id="quality-form" class="admin-panel"><div class="quality-sources">${sides.map(source).join('')}</div>
    <fieldset><legend>${th(msg('qualityWorkflow.roi','ROI：未旋转可见源像素网格，所有值须为偶数整数'))}</legend><div class="quality-roi">${['x','y','width','height'].map(key=>`<label>${key}<input name="${key}" type="number" step="2" min="${key==='width'||key==='height'?2:0}" required></label>`).join('')}</div><button type="button" id="quality-full-frame">${th(msg('qualityWorkflow.full','使用两侧完整可见帧'))}</button></fieldset>
    <fieldset><legend>SSIM</legend><label><input id="quality-ssim-enabled" type="checkbox">${th(msg('quality.ssimEnable','同次测量另附 SSIM（FFmpeg 均匀 8×8，步长 4；不是高斯窗口 SSIM）'))}</label><p>${th(msg('quality.ssimMinimum','SSIM 的 ROI 和每个实际边缘块至少 16×16 源像素。仅计算有效窗口，各平面覆盖范围单独记录；不补边、不重采样。'))}</p></fieldset>
    <fieldset><legend>${th(msg('quality.spatialTitle','源像素分块 PSNR'))}</legend><label><input id="quality-grid-enabled" type="checkbox">${th(msg('quality.spatialEnable','同次测量生成分块与最差区域证据（最多 64 块）'))}</label><div class="quality-roi"><label>${th(msg('quality.spatialWidth','块宽（偶数源像素）'))}<input id="quality-grid-width" type="number" step="2" min="2" max="16384" value="16" required></label><label>${th(msg('quality.spatialHeight','块高（偶数源像素）'))}<input id="quality-grid-height" type="number" step="2" min="2" max="16384" value="16" required></label></div></fieldset>
    <p>${th(msg('qualityWorkflow.candidateNotice','候选页只读取已有可信缓存，不构建索引。容器关键帧标记不保证可测；执行时仍逐侧核验闭合 AU、颜色、版本和缓存身份。缓存缺失请先在缓存管理中显式构建。'))}</p>
    <p id="quality-form-status" role="alert"></p>
    <button id="quality-submit" class="admin-primary" type="submit" disabled>${th(msg('qualityWorkflow.submit','发起持久测量'))}</button>
    <button id="quality-retry" type="button" hidden>${th(msg('qualityWorkflow.retry','使用原幂等键重试提交'))}</button>
    <button id="quality-forget" type="button" hidden>${th(msg('qualityWorkflow.forget','结束此提交的重试，准备新请求'))}</button><p id="quality-submit-status" role="status"></p></form>
    <div class="admin-panel"><div class="admin-section-heading"><h2>${th(msg('qualityWorkflow.history','当前用户的服务端任务与历史'))}</h2><button id="quality-refresh">${th(msg('qualityWorkflow.refresh','刷新任务'))}</button></div><p id="quality-observer-status" role="status"></p><p id="quality-resources"></p><details><summary>${th(msg('qualityWorkflow.budgets','服务端资源计数与预算'))}</summary><pre id="quality-resource-json"></pre></details>
    <div class="quality-jobs-workspace"><div id="quality-job-list"></div><div id="quality-job-detail" hidden><h3 id="quality-job-title"></h3><p id="quality-job-state"></p><p id="quality-job-reason"></p><p id="quality-job-input"></p><button id="quality-cancel">${th(msg('qualityWorkflow.cancel','取消任务'))}</button><details><summary>${th(msg('qualityWorkflow.requestFacts','请求、attempt 与服务端事实'))}</summary><pre id="quality-job-json"></pre></details><div id="quality-job-result"></div></div></div></div>
    <section id="quality-attachment" class="admin-panel" hidden><h2>${th(msg('qualityWorkflow.attach','将此结果显式共享到已有标注'))}</h2><p>${th(msg('quality.shareNotice','此操作会向所有可查看该标注的人共享两侧片源身份、测量 ROI 和不可变结果事实。'))}</p>
    <div class="admin-actions"><label>${th(msg('admin.reviewSpace','评审空间'))}<select id="quality-space"></select></label><label>${th(msg('quality.side','标注对应的片源侧'))}<select id="quality-attach-side"><option value="reference">reference</option><option value="distorted">distorted</option></select></label></div>
    <div class="admin-actions"><input id="quality-mark-search" type="search" aria-label="${th(msg('admin.searchMarks','搜索标注'))}"><button id="quality-mark-refresh">${th(msg('admin.search','搜索'))}</button><button id="quality-mark-more" hidden>${th(msg('admin.nextPage','下一页'))}</button></div>
    <div id="quality-mark-list"></div><p id="quality-attach-target"></p><button id="quality-attach" disabled>${th(msg('quality.publish','共享到标注'))}</button><p id="quality-attach-status" role="status"></p><div id="quality-shared-links"></div></section></section>`;
}
export function installQualityJobs(signal:AbortSignal){
  const $=<T extends HTMLElement=HTMLElement>(id:string)=>document.getElementById(`quality-${id}`)as T;
  const api=new QualityClient();let observer:QualityJobObserver|null=null,observation:QualityObservation|null=null;
  let active=false,enabled=false,scope=0,controller=new AbortController(),lastActor='',lastResult='',attachmentGeneration=0,attachmentBusy=false;
  let command:QualityAttachmentCommand|null=null,markNext:number|null=null,selectedMark:AnnotationRecord|null=null;
  const initial=new URLSearchParams(location.search),initialSpace=initial.get('qualitySpace')??'default',initialMark=initial.get('qualityAnnotation');
  let seededMark=false,identityCheck=0;let expectedActor:string|null|undefined;
  const pickers=new Map<Side,{page:QualityFramePage|null;entry:LibraryEntry|null;target:PairTarget|null;sequence:number;offset:number|null;revision?:number}>();
  for(const side of sides)pickers.set(side,{page:null,entry:null,target:null,sequence:0,offset:null});
  const clientInput=$<HTMLInputElement>('client');
  try{clientInput.value=sessionStorage.getItem('voidplayer-quality-client')??randomUUID();if(!/^[a-zA-Z0-9._:-]{1,80}$/.test(clientInput.value))clientInput.value=randomUUID();sessionStorage.setItem('voidplayer-quality-client',clientInput.value);}catch{clientInput.value=randomUUID();}
  let appliedClient=clientInput.value;
  const context=()=>({scope,actor:lastActor,signal:AbortSignal.any([signal,controller.signal])});
  const valid=(c:ReturnType<typeof context>)=>active&&!signal.aborted&&!c.signal.aborted&&c.scope===scope&&currentActor()?.id===c.actor;
  const errorText=(error:unknown)=>error instanceof Error?error.message:String(error);
  const setError=(id:string,error:unknown)=>{localizedText($(id),errorText(error));};
  // Local form validation belongs to the form, not the polled observer state.
  const clearFormError=()=>localizedText($('form-status'),'');
  $('form').addEventListener('input',clearFormError,{signal});
  $('form').addEventListener('change',clearFormError,{signal});
  function actions(){const pending=!!observation?.pending,busy=!!observation?.busy;
    $('submit').toggleAttribute('disabled',!enabled||!lastActor||pending||busy||sides.some(side=>!pickers.get(side)?.target));
    $('retry').hidden=!pending;$('forget').hidden=!pending;$('retry').toggleAttribute('disabled',busy||!enabled);$('forget').toggleAttribute('disabled',busy);
    for(const input of $('form').querySelectorAll<HTMLInputElement|HTMLSelectElement>('input,select'))input.disabled=!enabled||pending||busy||input instanceof HTMLSelectElement&&!pickers.get(input.closest<HTMLElement>('[data-quality-source]')?.dataset.qualitySource as Side)?.page;
    for(const button of $('form').querySelectorAll<HTMLButtonElement>('button'))if(!['quality-submit','quality-retry','quality-forget'].includes(button.id))button.disabled=!enabled||pending||busy;
    for(const id of ['grid-width','grid-height'])$<HTMLInputElement>(id).disabled=!enabled||pending||busy||!$<HTMLInputElement>('grid-enabled').checked;
    $('submit-status').textContent=pending?t(msg('qualityWorkflow.pending','提交结果尚未确认。请求已冻结；重试会复用原幂等键，不能据网络失败断言任务未创建。')):'';
  }
  function stateLabel(state:string){const labels:Record<string,string>={queued:t(msg('qualityWorkflow.queued','排队中')),preparing:t(msg('qualityWorkflow.preparing','检查来源')),running:t(msg('qualityWorkflow.running','执行中')),cancelling:t(msg('qualityWorkflow.cancelling','正在终止 Worker')),completed:t(msg('admin.measureDone','已完成')),failed:t(msg('admin.stateFailed','失败')),cancelled:t(msg('admin.stateCancelled','已停止')),interrupted:t(msg('admin.stateInterrupted','上次任务被中断'))};return labels[state]??state;}
  function render(value:QualityObservation){
    observation=value;actions();
    const reported=value.operationError??value.error;
    $('observer-status').textContent=reported?t(msg('qualityWorkflow.observeError','观察或请求暂不可用：{error}。任务终态以服务端事实为准。'),{error:errorText(reported)}):t(msg('qualityWorkflow.observing','正在观察当前用户的服务端事实；不需要播放器确认。'));
    $('resources').textContent=value.history?t(msg('qualityWorkflow.capacity','运行 {active}/{running}；排队 {queued}/{queueLimit}。容量由服务端统一管理。'),{active:value.history.resources.activeAttempts,running:value.history.limits.running,queued:value.history.resources.queued,queueLimit:value.history.limits.queued}):'';
    $('resource-json').textContent=value.history?JSON.stringify({resources:value.history.resources,limits:value.history.limits},null,2):'';
    // Keep pointer/focus targets stable across observation ticks. Replacing
    // rows between pointerdown/up can swallow a real selection in WebKit.
    const list=$('job-list'),rows=new Map([...list.querySelectorAll<HTMLButtonElement>('[data-job-id]')].map(row=>[row.dataset.jobId!,row]));
    for(const [index,job]of value.jobs.entries()){
      let button=rows.get(job.id);rows.delete(job.id);
      if(!button){button=document.createElement('button');button.type='button';button.className='quality-job-row';button.dataset.jobId=job.id;
        const rowScope=scope;button.onclick=()=>{if(rowScope===scope)void observer?.select(job.id);};}
      const pressed=String(value.detail?.id===job.id),label=`${stateLabel(job.state)} · ${job.submitted.client.kind}/${job.submitted.client.id} · ${formatDate(job.createdAt)} · ${job.id}`;
      if(button.getAttribute('aria-pressed')!==pressed)button.setAttribute('aria-pressed',pressed);
      if(button.textContent!==label)button.textContent=label;
      if(list.children[index]!==button)list.insertBefore(button,list.children[index]??null);
    }
    for(const row of rows.values())row.remove();
    const job=value.detail;$('job-detail').hidden=!job;$('attachment').hidden=!value.result;
    if(job){$('job-title').textContent=job.id;$('job-state').textContent=`${stateLabel(job.state)} · ${job.phase} · ${t(msg('qualityWorkflow.progress','已评分 {pairs}/1 对；已解码帧 {frames}'),{pairs:job.progress.scoredPairs,frames:job.progress.decodedFrames??t(msg('qualityWorkflow.unknown','未知'))})}`;
      $('job-input').textContent=sides.map(side=>`${sideLabel(side)}: ${job.input.request[side].mediaId}@${job.input.request[side].mediaVersion} · AU ${job.input.request[side].picture.au} · source PTS ${job.input.request[side].sourcePtsUs} µs`).join(' / ')+` · ROI ${JSON.stringify(job.input.request.roi)}`;
      $('job-reason').textContent=job.reason?`${job.reason.code}: ${job.reason.message}`:'';$('job-json').textContent=JSON.stringify(job,null,2);$('cancel').toggleAttribute('disabled',terminalQualityJob(job.state)||job.state==='cancelling');}
    const resultKey=value.result?`${value.result.jobId}/${value.result.attemptId}`:'';
    if(resultKey!==lastResult){lastResult=resultKey;resetAttachment();$('job-result').replaceChildren();
      if(value.result){try{qualityFacts($('job-result'),qualityEvidenceValue(value.result.value));void loadSpaces();}catch(error){setError('observer-status',error);$('attachment').hidden=true;}}}
  }
  function resetAttachment(){attachmentGeneration++;command=null;selectedMark=null;markNext=null;$('mark-list').replaceChildren();$('attach').toggleAttribute('disabled',true);localizedText($('attach-target'),'');localizedText($('attach-status'),'');$('shared-links').replaceChildren();}
  async function loadSpaces(){const c=context(),generation=attachmentGeneration;
    try{const spaces=await new AnnotationClient(c.signal).request<{id:string;name:string}[]>('/api/annotations/spaces','GET',undefined,c.actor);
      if(!valid(c)||generation!==attachmentGeneration)return;const select=$<HTMLSelectElement>('space'),previous=select.value;select.replaceChildren();
      for(const space of spaces){const option=new Option(space.name,space.id);select.add(option);}select.value=spaces.some(space=>space.id===previous)?previous:spaces.some(space=>space.id===initialSpace)?initialSpace:spaces[0]?.id??'';
      await loadMarks();
    }catch(error){if(valid(c)&&generation===attachmentGeneration)setError('attach-status',error);}}
  async function loadMarks(more=false){
    const c=context(),space=$<HTMLSelectElement>('space').value;if(!space)return;
    // A new selection/list is a distinct attachment scope. Late responses cannot
    // publish the prior space, side, job or mark into the current controls.
    const generation=++attachmentGeneration;command=null;selectedMark=null;$('attach').toggleAttribute('disabled',true);localizedText($('attach-target'),'');localizedText($('attach-status'),'');$('shared-links').replaceChildren();
    if(!more)$('mark-list').replaceChildren();
    try{const page=await new AnnotationClient(c.signal).request<{entries:AnnotationRecord[];next:number|null}>(`/api/annotations/spaces/${encodeURIComponent(space)}?list=1&deleted=0&search=${encodeURIComponent($<HTMLInputElement>('mark-search').value)}${more&&markNext?`&before=${markNext}`:''}`,'GET',undefined,c.actor);
      if(!valid(c)||generation!==attachmentGeneration)return;markNext=page.next;$('mark-more').hidden=markNext===null;
      for(const record of page.entries){const button=document.createElement('button');button.className='quality-mark-row';button.dataset.markId=record.id;button.textContent=`${record.document.mark.text||record.id} · source PTS ${record.document.mark.frame.sourcePtsUs} µs · r${record.revision}`;
        button.onclick=()=>chooseMark(record,space);$('mark-list').append(button);}
      if(!seededMark&&initialMark){seededMark=true;
        const selected=page.entries.find(record=>record.id===initialMark);
        if(selected)chooseMark(selected,space);
        else{const record=await new AnnotationClient(c.signal).request<AnnotationRecord>(`/api/annotations/spaces/${encodeURIComponent(space)}/${encodeURIComponent(initialMark)}`,'GET',undefined,c.actor);
          if(valid(c)&&generation===attachmentGeneration&&!record.deleted)chooseMark(record,space);}}
    }catch(error){if(valid(c)&&generation===attachmentGeneration)setError('attach-status',error);}}
  function chooseMark(record:AnnotationRecord,space:string){
    const job=observation?.detail;if(!job||job.state!=='completed'||!job.attempt||!job.result.digest||space!==$<HTMLSelectElement>('space').value||attachmentBusy)return;
    selectedMark=record;command={space,id:record.id,revision:record.revision,operationId:randomUUID(),evidence:{jobId:job.id,attemptId:job.attempt.id,digest:job.result.digest,side:$<HTMLSelectElement>('attach-side').value as Side}};
    localizedText($('attach-target'),()=>t(msg('quality.target','目标 {space}/{id} · 修订 {revision} · 源 PTS {pts} µs'),{space,id:record.id,revision:record.revision,pts:record.document.mark.frame.sourcePtsUs}));$('attach').toggleAttribute('disabled',false);localizedText($('attach-status'),'');
    for(const button of $('mark-list').querySelectorAll<HTMLElement>('[data-mark-id]'))button.setAttribute('aria-pressed',String(button.dataset.markId===record.id));
  }
  $('attach').onclick=async()=>{if(attachmentBusy||!command)return;const frozen=structuredClone(command),c=context(),generation=attachmentGeneration;attachmentBusy=true;$('attach').toggleAttribute('disabled',true);
    try{const record=await attachAnnotationQuality(frozen,{kind:'gui',id:observer?.client},c.actor);if(!valid(c)||generation!==attachmentGeneration||command?.operationId!==frozen.operationId)return;
      localizedText($('attach-status'),()=>t(msg('qualityWorkflow.attached','已共享；以下链接使用标注中的不可变证据，查看器仍会重新核验来源、缓存和几何。')));
      $('shared-links').replaceChildren();for(const evidence of record.document.mark.qualityEvidence??[]){if(evidence.ref.jobId!==frozen.evidence.jobId||evidence.ref.side!==frozen.evidence.side)continue;
        const link=document.createElement('a');link.className='quality-pair-open';link.target='_blank';link.rel='noopener';link.href=qualityPairViewUrl({space:frozen.space,annotationId:record.id,evidenceId:evidence.id},location.origin);link.textContent=t(msg('quality.openPair','在新窗口查看原帧对与 ROI'));$('shared-links').append(link);}
    }catch(error){if(valid(c)&&generation===attachmentGeneration)$('attach-status').textContent=t(msg('quality.retry','{error} 重试将复用操作 {operation}。'),{error:errorText(error),operation:frozen.operationId});}
    finally{attachmentBusy=false;if(valid(c)&&generation===attachmentGeneration)$('attach').toggleAttribute('disabled',false);}};
  $('space').onchange=()=>{seededMark=true;void loadMarks();};$('attach-side').onchange=()=>{attachmentGeneration++;command=null;$('attach').toggleAttribute('disabled',true);if(selectedMark&&!attachmentBusy)chooseMark(selectedMark,$<HTMLSelectElement>('space').value);};
  $('mark-refresh').onclick=()=>void loadMarks();$('mark-more').onclick=()=>void loadMarks(true);
  for(const side of sides){
    const root=document.querySelector<HTMLElement>(`[data-quality-source="${side}"]`)!,picker=pickers.get(side)!;
    const q=<T extends HTMLElement=HTMLElement>(selector:string)=>root.querySelector<T>(selector)!;
    const info=(message:LocalizedValue)=>localizedText(q('[data-source-status]'),message);
    async function search(more=false){const c=context(),sequence=++picker.sequence;picker.page=null;picker.target=null;q('[data-proof]').hidden=true;q<HTMLSelectElement>('[data-frame]').replaceChildren(new Option('—',''));actions();
      if(!more)q('[data-media-list]').replaceChildren();
      try{const params=new URLSearchParams({search:q<HTMLInputElement>('[data-search]').value,recursive:'1',limit:'50',offset:String(more?picker.offset??0:0),...(more&&picker.revision!==undefined?{revision:String(picker.revision)}:{})});
        const page=await api.request<LibraryPage>(c.actor,`/api/library/browse?${params}`,c.signal);if(!valid(c)||sequence!==picker.sequence)return;
        picker.offset=page.nextOffset;picker.revision=page.revision;q('[data-more]').hidden=page.nextOffset===null;
        for(const entry of page.entries){const button=document.createElement('button');button.type='button';button.dataset.mediaId=entry.id;button.textContent=`${entry.name} · ${entry.version??'—'}`;button.onclick=()=>void frames(entry);q('[data-media-list]').append(button);}info(()=>page.entries.length?'':t(msg('qualityWorkflow.noMedia','没有匹配的媒体。')));
      }catch(error){if(valid(c)&&sequence===picker.sequence)info(errorText(error));}}
    async function frames(entry:LibraryEntry,more=false){const c=context(),sequence=++picker.sequence,previous=picker.page;
      if(observation?.pending||observation?.busy)return;
      picker.target=null;picker.page=null;picker.entry=entry;q('[data-proof]').hidden=true;q<HTMLSelectElement>('[data-frame]').replaceChildren(new Option('—',''));q('[data-frame-more]').hidden=true;actions();info(()=>t(msg('qualityWorkflow.readingCache','读取已有可信缓存…')));
      try{if(!entry.version)throw new Error(t(msg('qualityWorkflow.noVersion','片源缺少版本，不能测量。')));
        const page=await api.frames(c.actor,entry.id,entry.version,{afterAu:more?previous?.nextAu??0:0,limit:50,...(more&&previous?{buildId:previous.source.binding.indexBuildId}:{})},c.signal);
        if(!valid(c)||sequence!==picker.sequence)return;picker.page=page;
        for(const [index,target]of page.entries.entries())q<HTMLSelectElement>('[data-frame]').add(new Option(`AU ${target.picture.au} · source PTS ${target.sourcePtsUs} µs${target.decode?` · decode AU ${target.decode.startAu}→${target.picture.au}`:``}`,String(index)));
        q('[data-proof]').hidden=false;q('[data-source-proof]').textContent=JSON.stringify({source:page.source,geometry:page.geometry,eligibility:page.eligibility},null,2);
        info(()=>`${entry.name} · ${page.codec} · ${page.geometry.width}×${page.geometry.height}\n${page.inspection.supported?t(msg('qualityWorkflow.inspectable','几何在原帧查看器支持范围内；执行与查看时仍重新核验。')):t(msg('qualityWorkflow.notInspectable','此源可尝试测量，但原帧查看器拒绝此几何：{reason}'),{reason:page.inspection.reason??'—'})}`);
        q('[data-frame-more]').hidden=page.nextAu===null;actions();
      }catch(error){if(valid(c)&&sequence===picker.sequence){info(errorText(error));actions();}}}
    q('[data-search-button]').onclick=()=>void search();q('[data-more]').onclick=()=>void search(true);q('[data-frame-more]').onclick=()=>{if(picker.entry)void frames(picker.entry,true);};
    q<HTMLInputElement>('[data-search]').onkeydown=event=>{if(event.key==='Enter'){event.preventDefault();void search();}};
    q<HTMLSelectElement>('[data-frame]').onchange=()=>{const value=q<HTMLSelectElement>('[data-frame]').value;picker.target=value!==''?picker.page?.entries[Number(value)]??null:null;actions();};
  }
  $('full-frame').onclick=()=>{clearFormError();const [a,b]=sides.map(side=>pickers.get(side)!.page?.geometry);if(!a||!b||a.width!==b.width||a.height!==b.height||a.width%2||a.height%2){setError('form-status',t(msg('qualityWorkflow.geometryMismatch','两侧需要相同的偶数可见尺寸；请明确选择有效 ROI。')));return;}
    for(const [key,value]of Object.entries({x:0,y:0,width:a.width,height:a.height}))($('form').querySelector(`[name=${key}]`)as HTMLInputElement).value=String(value);};
  $('grid-enabled').onchange=actions;
  $('form').onsubmit=event=>{event.preventDefault();if(!enabled||!observer||observation?.pending||observation?.busy)return;
    const targets=sides.map(side=>pickers.get(side)!);if(targets.some(p=>!p.target||!p.page))return;
    const roi=Object.fromEntries(['x','y','width','height'].map(key=>[key,Number(($('form').querySelector(`[name=${key}]`)as HTMLInputElement).value)]))as {x:number;y:number;width:number;height:number};
    if(!Object.values(roi).every(n=>Number.isSafeInteger(n)&&n%2===0)||roi.x<0||roi.y<0||roi.width<=0||roi.height<=0||targets.some(p=>roi.x+roi.width>p.page!.geometry.width||roi.y+roi.height>p.page!.geometry.height)){setError('form-status',t(msg('qualityWorkflow.invalidRoi','ROI 必须是两侧可见源网格内的偶数整数区域。')));return;}
    const spatial=$<HTMLInputElement>('grid-enabled').checked?{blockWidth:Number($<HTMLInputElement>('grid-width').value),blockHeight:Number($<HTMLInputElement>('grid-height').value)}:undefined;
    const ssim=$<HTMLInputElement>('ssim-enabled').checked?{variant:SSIM_VARIANT}:undefined;
    try{if(spatial)psnrGridPlan(roi,spatial);if(ssim)ssimPlan(roi,ssim,spatial);}catch(error){setError('form-status',error);return;}
    clearFormError();
    const input:QualityJobInput={schema:'voidplayer-psnr-frame-job',version:1,client:{id:observer.client,kind:'browser'},request:{pairing:'caller-specified',reference:targets[0].target!,distorted:targets[1].target!,roi,...(spatial?{spatial}:{}),...(ssim?{ssim}:{})}};
    void observer.submit(input).then(()=>observer?.poll());};
  $('retry').onclick=()=>void observer?.submit().then(()=>observer?.poll());$('forget').onclick=()=>observer?.forgetPending();$('refresh').onclick=()=>{const c=context();void (async()=>{if(await discover(c))await observer?.resync();})().catch(error=>{if(valid(c))setError('availability',error);});};$('cancel').onclick=()=>{if(observation?.detail)void observer?.cancel(observation.detail.id);};
  async function discover(c:ReturnType<typeof context>){
    const manifest=await api.request<{capabilities:{id:string;enabled:boolean}[]}>(c.actor,'/api/agent',c.signal);if(!valid(c))return false;
    enabled=manifest.capabilities.some(item=>item.id==='quality.jobs'&&item.enabled);
    localizedText($('availability'),()=>enabled?t(msg('qualityWorkflow.available','持久单帧 PSNR 可用；支持性仍按每个来源和执行结果判定。')):t(msg('qualityWorkflow.unavailable','此实例不提供持久画质任务（例如临时数据库）。不会回退到浏览器临时计算。')));actions();return enabled;
  }
  async function start(){
    if(expectedActor!==undefined&&(currentActor()?.id??null)!==expectedActor)return;
    clearFormError();observer?.dispose();observer=null;controller.abort();controller=new AbortController();scope++;lastActor=currentActor()?.id??'';enabled=false;lastResult='';observation=null;resetAttachment();
    $('job-list').replaceChildren();$('job-detail').hidden=true;$('attachment').hidden=true;for(const id of ['job-json','job-title','job-input','job-result','job-state','job-reason'])$(id).replaceChildren();
    for(const [side,picker]of pickers){picker.sequence++;picker.target=null;picker.page=null;picker.entry=null;const root=document.querySelector<HTMLElement>(`[data-quality-source="${side}"]`)!;root.querySelector('[data-media-list]')!.replaceChildren();localizedText(root.querySelector<HTMLElement>('[data-source-status]')!,'');root.querySelector<HTMLElement>('[data-proof]')!.hidden=true;root.querySelector<HTMLSelectElement>('[data-frame]')!.replaceChildren(new Option('—',''));root.querySelector<HTMLElement>('[data-frame-more]')!.hidden=true;}
    $('owner').textContent=currentActor()?`${currentActor()!.name} · ${lastActor}`:'';
    actions();if(!active||!lastActor){localizedText($('availability'),()=>t(msg('qualityWorkflow.identityRequired','请先选择服务身份。')));return;}
    const c=context();
    try{observer=new QualityJobObserver(api,lastActor,appliedClient,value=>{if(valid(c))render(value);},sessionStorage);if(await discover(c))await observer?.poll();
    }catch(error){if(valid(c))setError('availability',error);}}
  $('client-apply').onclick=()=>{if(!/^[a-zA-Z0-9._:-]{1,80}$/.test(clientInput.value)){setError('observer-status',t(msg('qualityWorkflow.invalidClient','客户端 ID 须为 1–80 个字母、数字、点、下划线、冒号或连字符。')));return;}try{sessionStorage.setItem('voidplayer-quality-client',clientInput.value);appliedClient=clientInput.value;}catch(error){setError('observer-status',error);return;}void start();};
  window.addEventListener('voidplayer-identity-change',()=>{if(active&&(expectedActor===undefined||(currentActor()?.id??null)===expectedActor)){expectedActor=undefined;void start();}},{signal});
  window.addEventListener('storage',event=>{
    if(event.key!=='voidplayer.identity'||!active)return;
    // The cookie may have changed before /health returns. Revoke publication
    // immediately; never send another captured-user request during confirmation.
    const check=++identityCheck;try{const hint=JSON.parse(event.newValue??'null');expectedActor=typeof hint?.id==='string'?hint.id:hint===null?null:undefined;}catch{expectedActor=undefined;}
    clearFormError();scope++;observer?.dispose();observer=null;controller.abort();lastActor='';enabled=false;observation=null;lastResult='';resetAttachment();
    localizedText($('availability'),()=>t(msg('qualityWorkflow.confirmIdentity','正在向服务确认当前用户…')));$('owner').textContent='';$('job-list').replaceChildren();$('job-detail').hidden=true;$('attachment').hidden=true;for(const id of ['job-json','job-title','job-input','job-result','job-state','job-reason'])$(id).replaceChildren();
    for(const picker of pickers.values()){picker.sequence++;picker.page=null;picker.target=null;}actions();
    void (async()=>{
      let health=await identityHealth();
      if(check!==identityCheck||!active||signal.aborted)return;
      // A focus health read may already have captured the previous cookie. One
      // fresh read confirms the notification rather than restoring old scope.
      if(expectedActor!==undefined&&(health.actor?.id??null)!==expectedActor)health=await identityHealth();
      if(check!==identityCheck||!active||signal.aborted)return;
      if(expectedActor!==undefined&&(health.actor?.id??null)!==expectedActor)throw new Error(t(msg('qualityWorkflow.identityUnconfirmed','当前用户尚未由服务确认，请刷新页面重试。')));
      expectedActor=undefined;if(!observer)void start();
    })().catch(error=>{if(check===identityCheck&&active&&!signal.aborted)setError('availability',error);});
  },{signal});
  window.addEventListener('focus',()=>{if(active)void identityHealth().catch(error=>setError('availability',error));},{signal});
  onLanguageChange(()=>{if(active&&observation&&currentActor()?.id===lastActor)render(observation);},signal);
  const timer=setInterval(()=>{if(active&&enabled&&!document.hidden&&currentActor()?.id===lastActor)void observer?.poll();},1000);
  signal.addEventListener('abort',()=>{clearInterval(timer);observer?.dispose();controller.abort();},{once:true});
  return {activate(value:boolean){if(active===value)return;active=value;if(value)void start();else{scope++;observer?.dispose();observer=null;controller.abort();}}};
}
