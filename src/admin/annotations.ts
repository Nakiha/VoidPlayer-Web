import { annotationWorkspace } from '../annotation-record.ts';
import { AnnotationClient } from '../annotation-client.ts';
import type { AnnotationRecord } from '../annotation-record.ts';
import { formatTime } from '../model.ts';
import { randomUUID } from '../uuid.ts';
import { installChoiceMenu } from '../ui/choice-menu.ts';
import { markSymbol } from '../ui/mark-symbol.ts';
import { icon } from '../ui/icons.ts';
export function annotationAdminShell() {
 return `<section id="pane-annotations" hidden><header class="admin-heading"><div><h1>标注</h1><p>检索评审记录，恢复已删除的标注。</p></div><button id="admin-annotations-refresh" class="icon-button" aria-label="刷新标注">${icon('refresh')}</button></header><div class="admin-annotation-tools"><button id="admin-annotation-space" class="choice-trigger" aria-label="评审空间"></button><input id="admin-annotation-search" type="search" aria-label="搜索标注" placeholder="搜索媒体、标注或作者"><button id="admin-annotation-search-button">搜索</button></div><div class="admin-annotation-tabs"><button id="admin-annotations-active" aria-pressed="true">标注</button><button id="admin-annotations-trash" aria-pressed="false">回收站</button><span id="admin-annotation-count" class="muted"></span></div><div class="admin-annotation-workspace"><div><div id="admin-annotation-list"></div><button id="admin-annotations-next" hidden>加载更多</button></div><div id="admin-annotation-detail" hidden><div class="admin-annotation-preview"><img alt="标注画面" id="admin-annotation-image"><span id="admin-annotation-no-preview" hidden>暂无预览</span></div><h2 id="admin-annotation-title"></h2><p id="admin-annotation-text"></p><p id="admin-annotation-author" class="muted"></p><div class="admin-actions"><a id="admin-annotation-open">在播放器中打开</a><button id="admin-annotation-export">导出标注</button><button id="admin-annotation-delete" class="admin-danger">移入回收站</button><button id="admin-annotation-restore" hidden>恢复标注</button></div><div id="admin-annotation-confirm" class="admin-inline-confirm" hidden><span>将这条标注移入回收站？</span><button id="admin-annotation-confirm-delete">删除</button><button id="admin-annotation-cancel">取消</button></div></div></div></section>`;
}
export function installAnnotationAdmin(signal: AbortSignal, notice: (message: string) => void) {
 const $=<T extends HTMLElement=HTMLElement>(id:string)=>document.getElementById(`admin-annotation${id}`) as T;
 const spaceNames=new Map<string,string>();
 const client=new AnnotationClient(signal);let space='default',deleted=false,search='',next:number|null=null,selected:AnnotationRecord|null=null,busy=false;
 const choice=installChoiceMenu('admin-annotation-space',[],value=>{if(busy)return;space=value;choice.sync(space,spaceNames.get(space)??space,true);void act(()=>load());});
 async function act(run:()=>Promise<void>){if(busy)return;busy=true;for(const b of document.querySelectorAll<HTMLButtonElement>('#pane-annotations button'))b.disabled=true;try{await run();notice('');}catch(error){notice((error as Error).message);}finally{busy=false;for(const b of document.querySelectorAll<HTMLButtonElement>('#pane-annotations button'))b.disabled=false;}}
 function select(record:AnnotationRecord|null){
  selected=record;for(const row of document.querySelectorAll<HTMLElement>('[data-annotation-id]'))row.setAttribute('aria-pressed',String(row.dataset.annotationId===record?.id));$('-detail').hidden=!record;$('-confirm').hidden=true;if(!record)return;
  const {mark,media}=record.document,source=media.find(media=>media.id===mark.mediaId)!;
  $('-title').textContent=`${source.name} · ${formatTime(mark.frame.ptsUs)}`;$('-text').textContent=mark.text;
  $('-author').textContent=`${mark.author?.name ?? '未署名'} · 版本 ${record.revision} · ${new Date(record.updatedAt).toLocaleString()}`;
  const image=$<HTMLImageElement>('-image');image.hidden=false;$('-no-preview').hidden=true;image.onerror=()=>{image.hidden=true;$('-no-preview').hidden=false;};image.src=`/api/annotations/spaces/${space}/${record.id}/preview?revision=${record.revision}`;
  const link=$<HTMLAnchorElement>('-open');link.href=`/?annotation=${record.id}&space=${space}`;link.hidden=record.deleted || !source.source;
  $('-delete').hidden=record.deleted;$('-restore').hidden=!record.deleted;
 }
 type Page={entries:AnnotationRecord[];next:number|null;count:number;previewBytes:number};
 async function load(more=false){
  const page=await client.request<Page>(`/api/annotations/spaces/${space}?list=1&deleted=${Number(deleted)}&search=${encodeURIComponent(search)}${more&&next?`&before=${next}`:''}`);
  next=page.next;$('s-next').hidden=!next;$('-count').textContent=`${page.count} 条`;
  if(!more){$('-list').replaceChildren();select(null);}
  for(const record of page.entries){const button=document.createElement('button');button.className='admin-annotation-row';button.dataset.annotationId=record.id;
   const content=document.createElement('span'),title=document.createElement('strong'),detail=document.createElement('span');title.textContent=record.document.mark.text || '画面标注';detail.textContent=`${record.document.media.find(media=>media.id===record.document.mark.mediaId)?.name} · ${record.document.mark.author?.name??'未署名'}`;content.append(title,detail);button.append(markSymbol(record.id),content);button.onclick=()=>select(record);$('-list').append(button);
  }
  if(!more && !page.entries.length){const empty=document.createElement('p');empty.className='admin-caption';empty.textContent=search?'没有匹配的标注':deleted?'回收站为空':'暂无标注';$('-list').append(empty);}
 }
 async function mutate(action:'delete'|'restore'){if(!selected)return;await client.mutate(space,{operationId:randomUUID(),id:selected.id,revision:selected.revision,action});await load();}
 $('s-refresh').onclick=()=>void act(()=>load());$('s-next').onclick=()=>void act(()=>load(true));
 $('-search-button').onclick=()=>{search=$<HTMLInputElement>('-search').value.trim();void act(()=>load());};$('-search').onkeydown=event=>{if(event.key==='Enter')$('-search-button').click();};
 for(const [suffix,value]of [['active',false],['trash',true]] as const)$(`s-${suffix}`).onclick=()=>{deleted=value;$('s-active').setAttribute('aria-pressed',String(!deleted));$('s-trash').setAttribute('aria-pressed',String(deleted));void act(()=>load());};
 $('-delete').onclick=()=>{$('-confirm').hidden=false;};$('-cancel').onclick=()=>{$('-confirm').hidden=true;};$('-confirm-delete').onclick=()=>void act(()=>mutate('delete'));$('-restore').onclick=()=>void act(()=>mutate('restore'));
 $('-export').onclick=()=>{if(!selected)return;const url=URL.createObjectURL(new Blob([JSON.stringify(annotationWorkspace([selected.document],location.origin+'/'),null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=`VoidPlayer-annotation-${selected.id}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};

 return {activate(){void act(async()=>{const spaces=await client.spaces();for(const space of spaces)spaceNames.set(space.id,space.name);choice.setOptions(spaces.map(space=>({value:space.id,label:space.name})));choice.sync(space,spaces.find(item=>item.id===space)?.name??space,true);await load();});}};
}
