import {t,th,msg} from '../../i18n.ts';
import {currentActor} from '../../services/identity.ts';
import {QualityClient} from '../../services/quality-jobs.ts';
import {readXpsnrComparison} from '../../services/xpsnr-comparison.ts';
import type {LoadedXpsnrComparison} from '../../services/xpsnr-comparison.ts';
import {comparisonView,comparisonFromUrl,comparisonDb,sortedComparison,COMPARISON_SORTS} from '../../../shared/analysis/quality/xpsnr-comparison.ts';
import type {ComparisonView,ComparisonSort} from '../../../shared/analysis/quality/xpsnr-comparison.ts';
import {qualityPairViewUrl} from '../../../shared/review/quality-pair-view.ts';
import type {AnnotationRecord} from '../../../shared/review/annotation-record.ts';
import type {QualityEvidenceRef} from '../../../shared/review/quality-evidence.ts';

export function xpsnrComparisonShell(){return `<section id="xpsnr-comparison-panel" class="xpsnr-comparison" aria-labelledby="xpsnr-comparison-heading">
  <h3 id="xpsnr-comparison-heading">${th(msg('xcompare.title','同一参考片段 · 版本比较'))}</h3>
  <p>${th(msg('xcompare.scope','选择 2–4 个已完成版本。Y/U/V 和 minimum 直接来自官方时间序列池化，逐帧 dB 不参与平均。排序仅是客观指标顺序，不是主观优劣判断；参考内容关系未经认证。'))}</p>
  <div id="xpsnr-comparison-selection"></div>
  <div class="admin-actions"><button type="button" id="xpsnr-compare">${th(msg('xpsnr.compare','比较选中版本（须同一冻结参考片段及 recipe）'))}</button>
  <button type="button" id="xpsnr-comparison-refresh">${th(msg('xcompare.refresh','重新核验原比较'))}</button><button type="button" id="xpsnr-comparison-clear">${th(msg('xcompare.clear','清除比较选择'))}</button></div>
  <p id="xpsnr-comparison-status" role="status"></p>
  <div id="xpsnr-comparison-content" hidden><p id="xpsnr-comparison-domain"></p>
  <label>${th(msg('xcompare.sort','版本顺序'))}<select id="xpsnr-comparison-sort"><option value="caller">${th(msg('xcompare.caller','选择顺序'))}</option><option value="minimum">XPSNR minimum ↓</option><option value="y">XPSNR Y ↓</option><option value="u">XPSNR U ↓</option><option value="v">XPSNR V ↓</option></select></label>
  <div id="xpsnr-comparison-pool" class="xpsnr-table-scroll"></div>
  <h4>${th(msg('xcompare.frames','共同参考呈现顺序 · 逐帧事实'))}</h4><p>${th(msg('xcompare.clocks','呈现序号从 0 开始；AU 是源解码顺序标识，PTS 为原始整数微秒。不会按失真 AU 或邻近时钟拼接。SSIM 仅在原任务明确请求时显示。'))}</p>
  <p id="xpsnr-comparison-page"></p><div class="admin-actions"><button type="button" id="xpsnr-comparison-prev">${th(msg('xcompare.prev','上一页参考帧'))}</button><button type="button" id="xpsnr-comparison-next">${th(msg('xcompare.next','下一页参考帧'))}</button></div>
  <div id="xpsnr-comparison-frames" class="xpsnr-table-scroll"></div>
  <h4>${th(msg('xcompare.evidence','已有候选与原帧证据'))}</h4><p>${th(msg('xcompare.evidenceScope','只读取已有发布回执。打开原帧复核会使用独立窗口，并保留返回此比较的链接；没有候选时不会自动创建。'))}</p><div id="xpsnr-comparison-evidence"></div>
  <details><summary>${th(msg('xcompare.json','原始比较 JSON 与固定身份'))}</summary><pre id="xpsnr-comparison"></pre></details></div></section>`;}

export function installXpsnrComparison(signal:AbortSignal,openJob:(id:string)=>void){
  const $=<T extends HTMLElement=HTMLElement>(id:string)=>document.getElementById('xpsnr-comparison-'+id)as T;
  const api=new QualityClient(),ids=new Set<string>();
  let actor='',previousOwner='',active=false,generation=0,life=new AbortController(),pinned:ComparisonView|null=null,loaded:LoadedXpsnrComparison|null=null;
  const storageKey=()=>`voidplayer.xpsnr-comparison.v1.${actor}`;
  const current=(owner:string,token:number,s:AbortSignal)=>active&&!signal.aborted&&!s.aborted&&actor===owner&&currentActor()?.id===owner&&generation===token;
  function clearFacts(){loaded=null;$('content').hidden=true;for(const part of ['pool','frames','evidence','domain','page'])$(part).replaceChildren();document.getElementById('xpsnr-comparison')!.textContent='';}
  function invalidate(){life.abort();life=new AbortController();generation++;clearFacts();}
  function locationView(view:ComparisonView|null){const url=new URL(location.href);if(view)url.searchParams.set('xpsnrComparison',JSON.stringify(view));else url.searchParams.delete('xpsnrComparison');history.replaceState(null,'',url);}
  function save(){if(!actor)return;locationView(pinned);try{if(pinned)localStorage.setItem(storageKey(),JSON.stringify(pinned));else localStorage.removeItem(storageKey());}catch{}}
  function selection(){
    $('selection').replaceChildren();
    for(const id of ids){const row=document.createElement('div');row.textContent=id+' ';const remove=document.createElement('button');remove.type='button';remove.textContent='×';remove.setAttribute('aria-label',t(msg('xcompare.remove','移除版本 {id}'),{id}));remove.onclick=()=>toggle(id,false);row.append(remove);$('selection').append(row);}
    for(const box of document.querySelectorAll<HTMLInputElement>('input[data-xpsnr-compare]'))box.checked=ids.has(box.dataset.xpsnrCompare!);
  }
  function toggle(id:string,on:boolean){if(on&&ids.size>=4&&!ids.has(id)){$('status').textContent=t(msg('xcompare.max','最多比较四个版本。'));selection();return;}invalidate();pinned=null;if(on)ids.add(id);else ids.delete(id);save();selection();$('status').textContent='';}
  function table(root:HTMLElement,headers:string[]){const table=document.createElement('table'),caption=document.createElement('caption');caption.className='sr-only';caption.textContent=headers.join(' · ');const head=table.createTHead().insertRow();for(const label of headers){const th=document.createElement('th');th.scope='col';th.textContent=label;head.append(th);}table.append(caption);root.append(table);return table.createTBody();}
  function cell(row:HTMLTableRowElement,value:string){const cell=row.insertCell();cell.textContent=value;return cell;}
  function jobButton(root:HTMLElement,id:string){const b=document.createElement('button');b.type='button';b.textContent=t(msg('xcompare.job','查看原任务 {id}'),{id});b.dataset.comparisonJob=id;b.onclick=()=>{openJob(id);document.getElementById('xpsnr-detail')?.scrollIntoView({block:'start'});};root.append(b);}
  function render(){
    if(!loaded||!pinned)return;
    const {comparison:c,summaries,pages}=loaded,ordered=sortedComparison(c,pinned.sort);
    $('content').hidden=false;document.getElementById('xpsnr-comparison-panel')!.dataset.state='ready';
    $('domain').textContent=`${c.recipe.width} × ${c.recipe.height} · ${c.recipe.pixelFormat} · ${c.recipe.range} BT.709 SDR · ${c.recipe.cadenceUs} µs · reference ${c.reference.binding.mediaId} / ${c.reference.binding.mediaVersion} · ${c.comparisonKey}`;
    $('pool').replaceChildren();const body=table($('pool'),[t(msg('xcompare.version','版本 / 不可变结果')),'Y (dB)','U (dB)','V (dB)','minimum (dB)']);
    for(const item of ordered){const row=body.insertRow();row.dataset.comparisonVersion=item.id;const label=cell(row,item.label??item.distorted.binding.mediaId),details=document.createElement('details'),summary=document.createElement('summary'),facts=document.createElement('pre');summary.textContent=t(msg('xcompare.identity','固定结果身份'));facts.textContent=`source ${item.distorted.binding.mediaId} / ${item.distorted.binding.mediaVersion}\njob ${item.id}\nattempt ${item.attemptId}\nSHA256 ${item.resultDigest}`;details.append(summary,facts);label.append(details);jobButton(label,item.id);for(const p of ['y','u','v']as const)cell(row,comparisonDb(item.pooled.planes[p]));cell(row,comparisonDb(item.pooled.minimum));}
    const after=pinned.after,total=summaries[0].companionPairs,end=after+pages[0].entries.length;
    $('page').textContent=`${after}–${end-1} / ${total}`;$<HTMLButtonElement>('prev').disabled=after===0;$<HTMLButtonElement>('next').disabled=pages[0].next===null;
    $<HTMLSelectElement>('sort').value=pinned.sort;$('frames').replaceChildren();
    const rows=table($('frames'),[t(msg('xcompare.referenceFrame','参考呈现序号 / AU / PTS (µs)')),t(msg('xcompare.version','版本 / 不可变结果')),t(msg('xcompare.distortedClock','失真 AU / PTS (µs)')),'XPSNR Y / U / V / minimum (dB)','PSNR (dB)','SSIM']);
    for(let offset=0;offset<pages[0].entries.length;offset++)for(const item of ordered){const v=c.items.findIndex(x=>x.id===item.id),e=pages[v].entries[offset],index=e.index,p=e.pair.result.provenance,n=summaries[v].xpsnr!.frames[index];const row=rows.insertRow();row.dataset.comparisonFrame=String(index);row.dataset.versionId=item.id;
      cell(row,`${index} · AU ${p.reference.picture.au} · ${p.reference.sourcePtsUs}`);cell(row,item.label??item.id);cell(row,`AU ${p.distorted.picture.au} · ${p.distorted.sourcePtsUs}`);cell(row,[n.planes.y,n.planes.u,n.planes.v,n.minimum].map(comparisonDb).join(' / '));cell(row,comparisonDb(e.pair.result.metric.aggregate.psnr));cell(row,summaries[v].job.input.metrics.ssim?String(e.pair.result.ssim!.aggregate.score):t(msg('xcompare.notRequested','未请求')));
    }
    document.getElementById('xpsnr-comparison')!.textContent=JSON.stringify({comparison:c,view:pinned},null,2);
    for(const link of $('evidence').querySelectorAll<HTMLAnchorElement>('a[data-comparison-candidate]')){const url=new URL(link.href);url.searchParams.set('xpsnrComparison',JSON.stringify(pinned));link.href=url.href;}
  }
  async function evidence(owner:string,token:number,s:AbortSignal,value:LoadedXpsnrComparison){
    const root=$('evidence');
    for(const item of value.comparison.items){
      const section=document.createElement('section');section.dataset.comparisonEvidence=item.id;const title=document.createElement('h5');title.textContent=item.id;section.append(title);
      const publication=await api.request<{policy:{space:string};createdIds:string[];selected:{id:string;index:number;ref:QualityEvidenceRef}[]}|null>(owner,`/api/quality/xpsnr/jobs/${item.id}/candidates`,s);
      if(!current(owner,token,s))return;
      if(!publication?.createdIds.length){const p=document.createElement('p');p.textContent=t(msg('xcompare.noCandidates','没有已发布候选。'));section.append(p);}
      for(const id of publication?.createdIds??[]){
        const frozen=publication!.selected.find(v=>v.id===id);
        if(!frozen||frozen.ref.attemptId!==item.attemptId||frozen.ref.digest!==item.resultDigest||frozen.ref.jobId!==`${item.id}-f${frozen.index}`)throw Error('Candidate receipt differs from compared result');
        const record=await api.request<AnnotationRecord>(owner,`/api/annotations/spaces/${encodeURIComponent(publication!.policy.space)}/${encodeURIComponent(id)}`,s);if(!current(owner,token,s))return;
        for(const e of record.document.mark.qualityEvidence??[]){if(e.verification!=='server-verified'||e.serviceOrigin!==location.origin||(['jobId','attemptId','digest','side']as const).some(k=>e.ref[k]!==frozen.ref[k]))continue;
          const url=new URL(qualityPairViewUrl({space:record.space,annotationId:record.id,evidenceId:e.id},location.origin));url.searchParams.set('xpsnrComparison',JSON.stringify(pinned));const a=document.createElement('a');a.href=url.href;a.target='_blank';a.rel='noopener';a.dataset.comparisonCandidate=id;a.textContent=t(msg('xcompare.openEvidence','呈现帧 {index} · 打开候选原帧'),{index:frozen.index});section.append(a,document.createElement('br'));}
      }
      if(current(owner,token,s))root.append(section);
    }
  }
  async function load(expected?:ComparisonView){
    invalidate();const owner=actor,token=generation,s=AbortSignal.any([signal,life.signal]);
    if(!owner||ids.size<2){$('status').textContent=t(msg('xcompare.choose','请选择 2–4 个已完成版本。'));return;}
    $('status').textContent=t(msg('xcompare.loading','正在核对原任务、attempt、digest、参考域和逐帧覆盖…'));
    try{const value=await readXpsnrComparison(api,owner,[...ids],s,expected);if(!current(owner,token,s))return;
      loaded=value;pinned=value.view;save();render();$('status').textContent=t(msg('xcompare.verified','已核验固定结果。仅代表本参考片段；未建立感知优越性。'));
      try{await evidence(owner,token,s,value);}catch(e){if(current(owner,token,s)){$('evidence').replaceChildren();$('evidence').textContent=t(msg('xcompare.evidenceUnavailable','候选证据不可用：{error}'),{error:String(e)});}}
    }catch(e){if(current(owner,token,s)){clearFacts();$('status').textContent=t(msg('xcompare.rejected','拒绝恢复或显示比较：{error}。原选择保留；请明确清除后重新选择，不会替换结果。'),{error:String(e)});}}
  }
  document.getElementById('xpsnr-compare')!.onclick=()=>void load(pinned??undefined);
  $('refresh').onclick=()=>void load(pinned??undefined);
  $('clear').onclick=()=>{invalidate();ids.clear();pinned=null;save();selection();$('status').textContent='';const url=new URL(location.href);url.searchParams.delete('xpsnrComparison');history.replaceState(null,'',url);};
  $('sort').onchange=()=>{if(!pinned)return;const sort=$<HTMLSelectElement>('sort').value as ComparisonSort;if(!COMPARISON_SORTS.includes(sort))return;pinned={...pinned,sort};save();render();};
  for(const [part,step]of [['prev',-4],['next',4]]as const)$(part).onclick=()=>{if(pinned)void load({...pinned,after:pinned.after+step});};
  signal.addEventListener('abort',()=>life.abort(),{once:true});
  return {has:(id:string)=>ids.has(id),toggle,
    unavailable(id:string){if(!ids.has(id))return;invalidate();document.getElementById('xpsnr-comparison-panel')!.dataset.state='unavailable';$('status').textContent=t(msg('qualityWorkspace.resultReleased','评分结果已回收；原始摘要与回执保留。'));},
    activate(value:boolean,owner:string){if(previousOwner&&owner!==previousOwner)locationView(null);if(owner)previousOwner=owner;active=value;actor=owner;invalidate();pinned=null;ids.clear();selection();$('status').textContent='';if(!value||!owner)return;
      try{const addressed=comparisonFromUrl(new URL(location.href)),raw=localStorage.getItem(storageKey());pinned=addressed??(raw&&raw.length<=4096?comparisonView(JSON.parse(raw)):null);if(pinned){for(const i of pinned.items)ids.add(i.id);selection();void load(pinned);}}
      catch(e){$('status').textContent=t(msg('xcompare.restoreInvalid','已保存的比较身份无效：{error}'),{error:String(e)});}
    }};
}
