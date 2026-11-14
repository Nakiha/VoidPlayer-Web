import { recordBackButton, installRecordNavigation } from './presentation.ts';
import { requestError } from './diagnostics.ts';
import { localizedText, type LocalizedValue } from '../ui/live-localization.ts';
import { formatDate, t, th, msg } from '../i18n.ts';
import { AnnotationClient } from '../review/annotation-client.ts';
import type { AnnotationRecord } from '../../shared/review/annotation-record.ts';
import { formatTime } from '../../shared/review/model.ts';
import { randomUUID } from '../../shared/utils/uuid.ts';
import { installChoiceMenu } from '../ui/choice-menu.ts';
import { markSymbol } from '../ui/mark-symbol.ts';
import { icon } from '../ui/icons.ts';
import { createShareUrl } from '../../shared/review/uri-binary.ts';
import { emptyUriState } from '../../shared/review/uri-state.ts';
export function annotationAdminShell() {
  return `<section id="pane-annotations" hidden>
    <header class="admin-heading"><h1>${th(msg("admin.marksTab", "标注"))}</h1><button id="admin-annotations-refresh" class="icon-button" aria-label="${th(msg("admin.refreshMarks", "刷新标注"))}">${icon('refreshRegular')}</button></header>
    <div class="admin-records"><div class="admin-record-list">
      <div class="admin-section-title"><h2>${th(msg('uriState.mediaVersion', '片源版本'))}</h2><button id="admin-annotation-space" class="choice-trigger" aria-label="${th(msg('uriState.mediaVersion', '片源版本'))}"></button></div>
      <div class="admin-panel admin-list-panel">
        <div class="admin-annotation-tabs" role="group" aria-label="${th(msg("admin.marksTab", "标注"))}"><button id="admin-annotations-active" aria-pressed="true">${th(msg("admin.marksTab", "标注"))}</button><button id="admin-annotations-trash" aria-pressed="false">${th(msg("admin.trashTab", "回收站"))}</button><span id="admin-annotation-count" class="muted"></span></div>
        <div class="admin-annotation-tools"><input id="admin-annotation-search" type="search" aria-label="${th(msg("admin.searchMarks", "搜索标注"))}" placeholder="${th(msg("admin.searchMarksPh", "搜索媒体、标注或作者"))}"><button id="admin-annotation-search-button">${th(msg("admin.search", "搜索"))}</button></div>
        <div id="admin-annotation-list" class="library-row-surface"></div><button id="admin-annotations-next" hidden>${th(msg("admin.loadMore", "加载更多"))}</button>
      </div></div>
      <div id="admin-annotation-detail" class="admin-record-detail" hidden>${recordBackButton()}<h2>${th(msg('admin.annotationDetails', '标注详情'))}</h2>
        <article class="admin-panel admin-mark-card"><div class="admin-annotation-preview"><img alt="${th(msg("marks.previewImage", "标注画面"))}" id="admin-annotation-image"><span id="admin-annotation-no-preview" hidden>${th(msg("marks.noPreview", "暂无预览"))}</span></div>
          <h3 id="admin-annotation-title"></h3><p id="admin-annotation-text"></p><p id="admin-annotation-author" class="admin-caption"></p>
          <div class="admin-actions"><a id="admin-annotation-open" class="admin-link-button">${icon('open')}${th(msg("admin.openInPlayerLink", "在播放器中打开"))}</a><button id="admin-annotation-export">${icon('download')}${th(msg("admin.download", "下载"))}</button><button id="admin-annotation-delete" class="admin-danger">${th(msg("admin.moveToTrash", "移入回收站"))}</button><button id="admin-annotation-restore" hidden>${th(msg("admin.restoreMark", "恢复标注"))}</button></div>
          <div id="admin-annotation-confirm" class="admin-inline-confirm" hidden><span>${th(msg("admin.trashConfirm", "将这条标注移入回收站？"))}</span><button id="admin-annotation-confirm-delete">${th(msg("marks.delete", "删除"))}</button><button id="admin-annotation-cancel">${th(msg("admin.cancel", "取消"))}</button></div>
        </article></div></div>
  </section>`;
}
export function installAnnotationAdmin(signal: AbortSignal, notice: (message: LocalizedValue) => void) {
 const $=<T extends HTMLElement=HTMLElement>(id:string)=>document.getElementById(`admin-annotation${id}`) as T;
 const spaceNames=new Map<string,string>();
 const client=new AnnotationClient(signal);let space='',deleted=false,search='',next:number|null=null,selected:AnnotationRecord|null=null,busy=false;
 let renderedList='';
 const panel=document.getElementById('pane-annotations')!;
 panel.addEventListener('click',event=>{
  if(!busy)return;
  event.preventDefault();
  event.stopImmediatePropagation();
 },{capture:true,signal});
 const navigation=installRecordNavigation(panel.querySelector<HTMLElement>('.admin-records')!,signal);
 const choice=installChoiceMenu('admin-annotation-space',[],value=>{if(busy)return;space=value;choice.sync(space,spaceNames.get(space)??space,true);void act(()=>load());});
 function controls(){
  for(const button of panel.querySelectorAll('button'))button.setAttribute('aria-disabled',String(busy));
  $('-list').setAttribute('aria-busy',String(busy));
 }
 async function act(run:()=>Promise<void>){
  if(busy)return;
  busy=true;controls();
  try{await run();notice(() => '');}
  catch(error){notice(() => requestError(error));}
  finally{busy=false;controls();}
 }
 function select(record:AnnotationRecord|null){
  selected=record;
  for(const row of $('-list').querySelectorAll<HTMLElement>('[data-annotation-id]')){
   const active=row.dataset.annotationId===record?.id;
   row.setAttribute('aria-pressed',String(active));
   row.classList.toggle('in-use',active);
  }
  $('-detail').hidden=!record;$('-confirm').hidden=true;if(!record){navigation.reset();return;}
  const {mark,media}=record.document,source=media.find(media=>media.id===mark.mediaId)!;
  localizedText($('-title'), () => `${source.name} · ${formatTime(mark.frame.ptsUs)}`);localizedText($('-text'), () => mark.text);
  localizedText($('-author'), () => t(msg("admin.annotationMeta", "{author} · 版本 {revision} · {date}"), {author:mark.author?.name ?? t(msg('marks.anonymous', '未署名')),revision:record.revision,date:formatDate(record.updatedAt)}));
  const image=$<HTMLImageElement>('-image');image.hidden=false;$('-no-preview').hidden=true;image.onerror=()=>{image.hidden=true;$('-no-preview').hidden=false;};image.src=`/api/annotations/media/${space}/${record.id}/preview?revision=${record.revision}`;
  const link = $<HTMLAnchorElement>('-open'), sourceUrl = source.source ? new URL(source.source.url, location.origin) : null;
  link.href = sourceUrl ? createShareUrl({ ...emptyUriState(), tracks: [{ slot: mark.slot, id: source.source!.id,
    version: sourceUrl.searchParams.get('v')!, offsetUs: 0, visible: true,
    ...(sourceUrl.origin !== location.origin ? { origin: sourceUrl.origin } : {}) }], mark: record.id }, location.href).href : '#';
  link.hidden = record.deleted || !source.source;
  $('-delete').hidden=record.deleted;$('-restore').hidden=!record.deleted;
 }
 type Page={entries:AnnotationRecord[];next:number|null;count:number;previewBytes:number};
 async function load(more=false){
  if(!space){const empty=document.createElement('p');empty.className='admin-caption';localizedText(empty,()=>t(msg('admin.noMarksAdmin','暂无标注')));$('-list').replaceChildren(empty);$('s-next').hidden=true;localizedText($('-count'),()=>t(msg('admin.itemsCount','{n, plural, other {# 条}}'),{n:0}));select(null);return;}
  const page=await client.request<Page>(`/api/annotations/media/${space}?list=1&deleted=${Number(deleted)}&search=${encodeURIComponent(search)}${more&&next?`&before=${next}`:''}`);
  next=page.next;$('s-next').hidden=!next;localizedText($('-count'), () => t(msg("admin.itemsCount", "{n, plural, other {# 条}}"), { n: page.count }));
  const snapshot=JSON.stringify([space,deleted,search,page]);
  if(!more&&renderedList===snapshot)return;
  renderedList=more?'':snapshot;
  if(!more){$('-list').replaceChildren();select(null);}
  const offset=$('-list').querySelectorAll('.admin-annotation-row').length;
  for(const [index,record] of page.entries.entries()){
   const button=document.createElement('button');button.className='admin-annotation-row source-row';button.dataset.annotationId=record.id;
   button.classList.toggle('source-striped',(offset+index)%2===1);
   button.setAttribute('aria-pressed','false');
   const content=document.createElement('span'),title=document.createElement('strong'),detail=document.createElement('span');localizedText(title, () => record.document.mark.text || t(msg("sync.frameMark", "画面标注")));localizedText(detail, () => `${record.document.media.find(media=>media.id===record.document.mark.mediaId)?.name} · ${record.document.mark.author?.name??t(msg("marks.anonymous", "未署名"))}`);content.append(title,detail);
   const position=document.createElement('span');position.className='admin-mark-time';position.textContent=formatTime(record.document.mark.frame.ptsUs);
   button.append(markSymbol(record.id),content,position);button.onclick=()=>{select(record);navigation.open();};$('-list').append(button);
  }
  if(!more && !page.entries.length){const empty=document.createElement('p');empty.className='admin-caption';localizedText(empty, () => search?t(msg("admin.noMatchMarks", "没有匹配的标注")):deleted?t(msg("admin.trashEmpty", "回收站为空")):t(msg("admin.noMarksAdmin", "暂无标注")));$('-list').append(empty);}
 }
 async function mutate(action:'delete'|'restore'){if(!selected)return;await client.mutate(space,{operationId:randomUUID(),id:selected.id,revision:selected.revision,action,client:{kind:'gui'}});await load();}
 $('s-refresh').onclick=()=>void act(()=>load());$('s-next').onclick=()=>void act(()=>load(true));
 $('-search-button').onclick=()=>{search=$<HTMLInputElement>('-search').value.trim();void act(()=>load());};$('-search').onkeydown=event=>{if(event.key==='Enter')$('-search-button').click();};
 for(const [suffix,value]of [['active',false],['trash',true]] as const)$(`s-${suffix}`).onclick=()=>{deleted=value;$('s-active').setAttribute('aria-pressed',String(!deleted));$('s-trash').setAttribute('aria-pressed',String(deleted));void act(()=>load());};
 $('-delete').onclick=()=>{$('-confirm').hidden=false;};$('-cancel').onclick=()=>{$('-confirm').hidden=true;};$('-confirm-delete').onclick=()=>void act(()=>mutate('delete'));$('-restore').onclick=()=>void act(()=>mutate('restore'));
 $('-export').onclick=()=>{if(!selected)return;const url=URL.createObjectURL(new Blob([JSON.stringify({schema:'voidplayer-annotation',abi:1,record:selected},null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=`VoidPlayer-annotation-${selected.id}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};

 return {activate(){void act(async()=>{
  const spaces=await client.spaces();spaceNames.clear();
  for(const item of spaces)spaceNames.set(item.id,item.name+(item.source?' · '+item.source.version.slice(0,8):''));
  choice.setOptions(spaces.map(item=>({value:item.id,label:spaceNames.get(item.id)!})));
  if(!spaces.some(item=>item.id===space))space=spaces[0]?.id??'';
  choice.sync(space,spaceNames.get(space)??t(msg('admin.noMarksAdmin','暂无标注')),!!space);
  await load();
 });}};
}
