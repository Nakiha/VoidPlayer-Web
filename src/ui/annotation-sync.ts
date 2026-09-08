import type { ReviewSession } from '../session.ts';
import { AnnotationStorage } from '../annotation-storage.ts';
import type { AnnotationDraft } from '../annotation-storage.ts';
import { AnnotationClient } from '../annotation-client.ts';
import type { AnnotationDocument, AnnotationRecord } from '../annotation-record.ts';
import { annotationMediaKey, annotationWorkspace } from '../annotation-record.ts';
import { currentActor, identityHealth } from '../identity.ts';
import { randomUUID } from '../uuid.ts';
import { installChoiceMenu } from './choice-menu.ts';
import { icon } from './icons.ts';
import { annotationThumbnails, thumbnailSignature } from './annotation-thumbnails.ts';

export function installAnnotationSync(session: ReviewSession, editing: () => boolean) {
  const storage = new AnnotationStorage(), life = new AbortController(), client = new AnnotationClient(life.signal);
  let previewEpoch = 0, editGeneration=0, localFailure='';
  const unsaved=new Map<string,{id:string;document:AnnotationDocument|null;base:number;space:string;actorId:string}>();
  let scope = 'default', available = false, working = false, cursor = 0, generation = 0, error = '', saving = 0;
  let spaces = [{ id: 'default', name: '共享评审' }], drafts: AnnotationDraft[] = [];
  const versions = new Map<string, number>(), managed = new Set<string>();
  let owner = randomUUID();
  try { if (performance.getEntriesByType('navigation').some(entry => (entry as PerformanceNavigationTiming).type === 'reload')) owner = sessionStorage.getItem('voidplayer.annotation-window') || owner; sessionStorage.setItem('voidplayer.annotation-window', owner); scope=sessionStorage.getItem('voidplayer.annotation-space')||'default'; } catch {}
  let actor = currentActor()?.id ?? 'local';
  try { actor=currentActor()?.id ?? JSON.parse(localStorage.getItem('voidplayer.identity') ?? 'null')?.id ?? 'local'; } catch {}
  const button = document.createElement('button'); button.className = 'icon-button'; button.id = 'annotation-save-state'; button.setAttribute('aria-label', '标注保存'); button.innerHTML = icon('check');
  document.querySelector('.annotation-strip-tools')!.append(button);
  const dialog = document.createElement('dialog'); dialog.id = 'annotation-sync-dialog'; dialog.setAttribute('aria-label','标注保存');
  dialog.innerHTML = `<header class="dialog-heading"><h2>标注保存</h2><button class="icon-button" aria-label="关闭标注保存">${icon('close')}</button></header><div class="annotation-sync-scope"><button id="annotation-space-choice" class="choice-trigger" aria-label="评审空间"></button><button id="annotation-sync-now" class="icon-button" aria-label="重新同步">${icon('refresh')}</button></div><p id="annotation-sync-status" role="status"></p><div class="annotation-new-space"><input id="annotation-space-name" maxlength="120" aria-label="新评审空间名称" placeholder="新评审空间名称"><button id="annotation-space-create">创建空间</button></div><div id="annotation-conflicts"></div><div id="annotation-other-drafts"></div><div class="annotation-sync-actions"><button id="annotation-drafts-export">导出本机草稿</button><button id="annotation-publish">将当前标注另存到空间</button></div>`;
  document.body.append(dialog);
  const $ = <T extends HTMLElement = HTMLElement>(id: string) => dialog.querySelector<T>(`#${id}`)!;
  const choice = installChoiceMenu('annotation-space-choice',[], value => { if (value !== scope) void switchSpace(value); });
  dialog.querySelector('header button')!.addEventListener('click',()=>dialog.close()); button.onclick=()=>{dialog.showModal();void refreshDrafts();};
  const currentDrafts = () => drafts.filter(draft=>draft.space===scope && draft.actor===actor && draft.key.startsWith(`${actor}/${scope}/${owner}/`));
  let choiceSignature='', conflictSignature='', otherSignature='';
  function state() {
    const pending=currentDrafts(), conflicts=pending.filter(draft=>draft.conflict);
    const message=localFailure || error || (saving ? '正在保存到本机…' : conflicts.length ? `${conflicts.length} 条标注需要处理` : pending.length ? available && scope!=='local' ? '已存本机 · 等待同步' : '已存本机' : available && scope!=='local' ? '已同步' : '已存本机');
    button.title=`${spaces.find(space=>space.id===scope)?.name ?? '本机快照'} · ${message}`;
    button.dataset.state=localFailure || error || conflicts.length?'error':saving || pending.length?'pending':'saved';
    button.innerHTML=icon(localFailure || error || conflicts.length?'info':saving || pending.length?'refresh':'check');
    $('annotation-sync-status').textContent=message;
    const choices=[{value:'local',label:'本机快照'},...spaces.map(space=>({value:space.id,label:space.name}))];
    const signature=JSON.stringify(choices);if(signature!==choiceSignature){choiceSignature=signature;choice.setOptions(choices);}
    choice.sync(scope, spaces.find(space=>space.id===scope)?.name ?? '本机快照', !editing() && !unsaved.size);
    $<HTMLButtonElement>('annotation-space-create').disabled=!available || editing();
    $<HTMLButtonElement>('annotation-publish').textContent=scope==='local'?'另存到共享评审':'将当前标注另存到空间';
    $<HTMLButtonElement>('annotation-publish').disabled=!available || editing() || !session.getState().marks.length;
    const others=drafts.filter(draft=>draft.actor===actor && draft.space===scope && !draft.key.startsWith(`${actor}/${scope}/${owner}/`));
    const nextOthers=JSON.stringify(others);
    if(nextOthers!==otherSignature){otherSignature=nextOthers;$('annotation-other-drafts').replaceChildren(...others.map(draft=>{
      const row=document.createElement('div');row.className='annotation-conflict';const text=document.createElement('p');text.textContent=`其他页面的草稿：${draft.desired?.mark.text || '画面标注'}`;
      const button=document.createElement('button');button.textContent='在这里继续';button.onclick=()=>void(async()=>{try{await storage.claim(draft.key,`${actor}/${scope}/${owner}/${draft.id}`);await apply();void sync();}catch(e){error=(e as Error).message;state();}})();row.append(text,button);return row;
    }));}
    const nextConflicts=JSON.stringify(conflicts);if(nextConflicts===conflictSignature)return;conflictSignature=nextConflicts;
    const rows=conflicts.map(draft=>{
      const row=document.createElement('div'); row.className='annotation-conflict';
      const text=document.createElement('p');text.textContent=draft.desired?.mark.text || '标注已被修改或删除';
      const message=document.createElement('p');message.className='muted';message.textContent=draft.conflict!;
      const reload=document.createElement('button');reload.textContent='采用服务器版本'; reload.onclick=()=>void resolve(draft,false);
      const copy=document.createElement('button');copy.textContent='草稿另存为标注';copy.disabled=!draft.desired;copy.onclick=()=>void resolve(draft,true);
      row.append(text,message,reload,copy);return row;
    }); $('annotation-conflicts').replaceChildren(...rows);
  }
  async function refreshDrafts() { try { drafts=await storage.drafts(); state(); } catch(e) {error=(e as Error).message;state();} }
  async function enqueue(id: string, document: AnnotationDocument | null, base = versions.get(id) ?? 0, destination={space:scope,actorId:actor}) {
    if(document)document={mark:structuredClone(document.mark),media:document.media.map(media=>({...media,...(media.source?{source:{...media.source,url:new URL(media.source.url,location.href).href}}:{})}))};
    const {space,actorId}=destination,key=`${actorId}/${space}/${owner}/${id}`;
    editGeneration++;const pending={id,document,base,space,actorId};unsaved.set(key,pending);
    if(space===scope && actorId===actor)managed.add(id);saving++;state();
    try {
      await storage.change(key,previous=>({key,space,actor:actorId,id,base:previous?.base ?? base,desired:document,generation:(previous?.generation ?? 0)+1,...(previous?.attempt?{attempt:previous.attempt,sentGeneration:previous.sentGeneration}:{}),...(previous?.conflict?{conflict:previous.conflict}:{})}));
      if(unsaved.get(key)===pending)unsaved.delete(key);if(!unsaved.size)localFailure='';
    } catch(e) {localFailure=`本机保存失败：${(e as Error).message}`;} finally {saving--;await refreshDrafts();}
  }
  const unsubscribeMarks=session.subscribeMarkChanges((id,document)=>{void enqueue(id,document);});
  async function apply() {
    if (editing() || saving || unsaved.size) return;
    const captured=generation,edited=editGeneration, records=await storage.records(scope); await refreshDrafts(); if(captured!==generation || editing())return;
    const pending=currentDrafts(), protectedIds=new Set(pending.map(draft=>draft.id));
    const documents:AnnotationDocument[]=[];
    for(const record of records){
      if(protectedIds.has(record.id))continue;
      versions.set(record.id,record.revision);managed.add(record.id);
      if(!record.deleted)documents.push(record.document);
      const existingPreview=annotationThumbnails.get(record.id);
      if(!record.deleted && available && (!existingPreview || (existingPreview.url.startsWith('/api/annotations/') && existingPreview.url!==`/api/annotations/spaces/${scope}/${record.id}/preview?revision=${record.revision}`) || (existingPreview.signature && existingPreview.signature!==thumbnailSignature(record.document.mark)))) {
        annotationThumbnails.set(record.id,{url:`/api/annotations/spaces/${scope}/${record.id}/preview?revision=${record.revision}`,width:320,height:180,signature:thumbnailSignature(record.document.mark)});
      }
    }
    for(const draft of pending){managed.add(draft.id);if(draft.desired)documents.push(draft.desired);}
    for(const document of documents){const preview=await storage.preview(scope,document.mark.id);if(preview?.signature===thumbnailSignature(document.mark))annotationThumbnails.set(document.mark.id,preview);}
    if(captured!==generation || edited!==editGeneration || editing() || saving || unsaved.size)return;
    // Identical shared library versions remap to this window's ephemeral media IDs.
    session.applyStoredAnnotations(documents,[...managed]);
  }
  const uploaded = new Map<string,string>();
  async function uploadPreviews(space: string, actorId: string) {
    if(session.getState().playing || editing())return;
    const records=await storage.records(space);let count=0;
    for(const record of records){
      if(record.deleted || count>=4)continue;
      const token=`${record.revision}/${thumbnailSignature(record.document.mark)}`,key=`${space}/${record.id}`;
      if(uploaded.get(key)===token)continue;
      const preview=await storage.preview(space,record.id);
      if(!preview || preview.signature!==thumbnailSignature(record.document.mark))continue;
      count++;
      const blob=await fetch(preview.url).then(response=>response.blob());
      const response=await fetch(`/api/annotations/spaces/${space}/${record.id}/preview?revision=${record.revision}&epoch=${previewEpoch}`,{method:'PUT',headers:{'x-voidplayer-action':'annotation','x-voidplayer-actor':actorId,'content-type':'image/jpeg'},body:blob,signal:AbortSignal.any([life.signal,AbortSignal.timeout(10000)])});
      if(response.ok)uploaded.set(key,token);
    }
  }
  window.addEventListener('voidplayer-annotation-preview',event=>{
    const {id,preview}=(event as CustomEvent).detail;
    const mark=session.getState().marks.find(mark=>mark.id===id);
    if(mark && thumbnailSignature(mark)===preview.signature)void storage.savePreview(scope,id,preview).catch(()=>{});
  },{signal:life.signal});
  async function sync() {
    if(working || life.signal.aborted)return;working=true;const captured=generation,space=scope,actorId=actor;
    try {
      for(const value of [...unsaved.values()])await enqueue(value.id,value.document,value.base,{space:value.space,actorId:value.actorId});
      if(unsaved.size)return;
      await refreshDrafts();
      if(available && space!=='local') {
        for(const queued of currentDrafts().filter(draft=>!draft.conflict)) {
          if(captured!==generation)break;
          const draft=await storage.change(queued.key,current=>{
            if(!current || current.conflict)return current;
            if(!current.attempt){current.attempt={operationId:randomUUID(),id:current.id,revision:current.base,action:current.desired?'put':'delete',...(current.desired?{document:current.desired}:{})};current.sentGeneration=current.generation;}
            return current;
          });
          if(!draft?.attempt)continue;
          // Never send a local-only deletion that has not created a remote record.
          if(draft.base===0 && !draft.desired && !draft.attempt.document){await storage.change(draft.key,()=>undefined);continue;}
          try {
            const record=await client.mutate(space,draft.attempt,actorId); await storage.remember([record]);
            await storage.change(draft.key,current=>{
              if(!current || current.attempt?.operationId!==draft.attempt!.operationId)return current;
              return current.generation===current.sentGeneration ? undefined : {...current,base:record.revision,attempt:undefined,sentGeneration:undefined};
            });
            if(captured===generation)versions.set(record.id,Math.max(versions.get(record.id)??0,record.revision));
          } catch(e) {
            const status=(e as {status?:number}).status;
            if(status===409 || (status && status>=400 && status<500 && status!==408 && status!==429))await storage.change(draft.key,current=>current?{...current,conflict:(e as Error).message}:undefined);
            else throw e;
          }
        }
        if(captured!==generation)return;
        let page;
        do {page=await client.changes(space,cursor);await storage.remember(page.entries);if(captured!==generation)return;cursor=page.cursor;previewEpoch=page.previewEpoch??0;}while(page.more);
        error='';
      }
      if(captured===generation)await apply();
      if(captured===generation && available && space!=='local')await uploadPreviews(space,actorId).catch(()=>{});
    } catch(e){if(captured===generation){error=available?'连接中断 · 本机草稿保留':(e as Error).message;}}finally{working=false;await refreshDrafts();}
  }
  async function switchSpace(next:string) {
    if(editing() || unsaved.size)return;
    generation++;scope=next;try{sessionStorage.setItem('voidplayer.annotation-space',scope);}catch{}cursor=0;versions.clear();session.applyStoredAnnotations([], [...managed]);managed.clear();
    await apply();void sync();
  }
  let resolving=false;
  async function resolve(draft:AnnotationDraft,copy:boolean) {
    if(resolving)return;
    if(editing()){error='请先结束当前标注编辑。';state();return;}
    resolving=true;
    try {
      const record=await client.read(draft.space,draft.id);await storage.remember([record]);
      let replacement:AnnotationDraft|undefined;
      if(copy && draft.desired){const document=structuredClone(draft.desired);document.mark.id=randomUUID();replacement={key:`${actor}/${scope}/${owner}/${document.mark.id}`,space:scope,actor,id:document.mark.id,base:0,desired:document,generation:1};}
      await storage.resolve(draft,replacement);await apply();void sync();
    } catch(e){error=(e as Error).message;state();}finally{resolving=false;}
  }
  $('annotation-sync-now').onclick=()=>void sync();
  $('annotation-space-create').onclick=()=>void(async()=>{try{const space=await client.createSpace($<HTMLInputElement>('annotation-space-name').value);spaces=await client.spaces();await switchSpace(space.id);$<HTMLInputElement>('annotation-space-name').value='';}catch(e){error=(e as Error).message;state();}})();
  $('annotation-publish').onclick=()=>void(async()=>{
    const snapshot=session.exportWorkspace(location.origin+'/');
    // Keep the snapshot in memory while changing destination; never overwrite its old IDs.
    if(scope==='local')await switchSpace('default');
    for(const mark of snapshot.marks){const ids=new Set([mark.mediaId,...mark.comparison.map(item=>item.mediaId)]);const document={mark:{...mark,id:randomUUID()},media:snapshot.media.filter(media=>ids.has(media.id))};await enqueue(document.mark.id,document,0);}
    await apply();void sync();
  })();
  $('annotation-drafts-export').onclick=()=>void(async()=>{
    try{
      const drafts=(await storage.drafts().catch(()=>[])).filter(draft=>draft.actor===actor && draft.desired);
      const payload=annotationWorkspace([...drafts.map(draft=>draft.desired!),...[...unsaved.values()].flatMap(value=>value.document?[value.document]:[])],location.origin+'/');
      const url=URL.createObjectURL(new Blob([JSON.stringify(payload,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='VoidPlayer-annotation-drafts.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    }catch(e){error=(e as Error).message;state();}
  })();
  let trackSignature='';
  const unsubscribe=session.subscribe(()=>{
    const state=session.getState(), signature=state.tracks.map(track=>annotationMediaKey(track)).join('|');
    if(signature!==trackSignature){trackSignature=signature;void apply();}
  });
  window.addEventListener('beforeunload',event=>{if(saving || unsaved.size || localFailure){event.preventDefault();event.returnValue='';}},{signal:life.signal});
  const interval=setInterval(()=>{if(!document.hidden)void sync();},3000);
  async function connect(){try{const health=await identityHealth();actor=health.actor?.id??actor;available=!!health.capabilities?.annotations;if(available)spaces=await client.spaces();await apply();void sync();}catch{void apply();}}
  window.addEventListener('online',()=>void connect(),{signal:life.signal});
  window.addEventListener('focus',()=>void sync(),{signal:life.signal});
  window.addEventListener('voidplayer-identity-change',()=>{
    const next=currentActor()?.id ?? 'local';if(next===actor)return;
    generation++;actor=next;cursor=0;versions.clear();void apply();
  },{signal:life.signal});
  void connect();
  state();
  return {
    openSpace: switchSpace,
    snapshotMode(){if(unsaved.size)throw new Error('本机草稿尚未保存，请先重试或导出。');const previous=scope;generation++;scope='local';try{sessionStorage.setItem('voidplayer.annotation-space',scope);}catch{}cursor=0;versions.clear();managed.clear();state();return ()=>{void switchSpace(previous);};},
    async captureSnapshot(){const snapshot=session.exportWorkspace(location.origin+'/');for(const mark of snapshot.marks){const ids=new Set([mark.mediaId,...mark.comparison.map(item=>item.mediaId)]);await enqueue(mark.id,{mark,media:snapshot.media.filter(media=>ids.has(media.id))},0);}},
    dispose(){life.abort();clearInterval(interval);unsubscribe();unsubscribeMarks();choice.dispose();dialog.remove();button.remove();},
  };
}
