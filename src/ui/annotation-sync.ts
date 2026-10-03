import { t, msg, th, onLanguageChange } from '../i18n.ts';
import type { ReviewSession } from '../session.ts';
import { AnnotationStorage } from '../annotation-storage.ts';
import type { AnnotationDraft } from '../annotation-storage.ts';
import { AnnotationClient } from '../annotation-client.ts';
import type { AnnotationDocument, AnnotationRecord } from '../annotation-record.ts';
import { annotationMediaKey, annotationWorkspace } from '../annotation-record.ts';
import { currentActor, identityHealth } from '../identity.ts';
import { randomUUID } from '../uuid.ts';
import { AnnotationPendingQueue } from '../annotation-pending.ts';
import type { PendingEdit } from '../annotation-pending.ts';
import { annotationThumbnails, thumbnailSignature } from './annotation-thumbnails.ts';
import { publishMarkPreview } from './mark-preview-publish.ts';

export function installAnnotationSync(session: ReviewSession, editing: () => boolean) {
  const storage = new AnnotationStorage(), life = new AbortController(), client = new AnnotationClient(life.signal);
  let previewEpoch = 0, editGeneration=0, localFailure: string | (() => string) = '';
  // REVIEW-01：待保存队列按 key 串行、重试不产生新编辑版本。
  // stage() 只在用户新编辑时调用并递增 seq；sync() 重试复用快照 pending，
  // 两次核对身份后才落盘，过期直接跳过，不覆盖更新的 B-new/删除。
  const pendingQueue = new AnnotationPendingQueue();
  let scope = 'local', available = false, working = false, cursor = 0, generation = 0, error: string | (() => string) = '', saving = 0;
  let syncIdle: Promise<void> = Promise.resolve();
  let drafts: AnnotationDraft[] = [];
  const versions = new Map<string, number>(), managed = new Set<string>();
  let owner = randomUUID();
  try { if (performance.getEntriesByType('navigation').some(entry => (entry as PerformanceNavigationTiming).type === 'reload')) owner = sessionStorage.getItem('voidplayer.annotation-window') || owner; sessionStorage.setItem('voidplayer.annotation-window', owner); if (performance.getEntriesByType('navigation').some(entry => (entry as PerformanceNavigationTiming).type === 'reload')) scope=sessionStorage.getItem('voidplayer.annotation-space')||'local'; } catch {}
  let actor = currentActor()?.id ?? 'local';
  try { actor=currentActor()?.id ?? JSON.parse(localStorage.getItem('voidplayer.identity') ?? 'null')?.id ?? 'local'; } catch {}
  const pane = document.getElementById('settings-pane-workspace')!;
  const $ = <T extends HTMLElement = HTMLElement>(id: string) => pane.querySelector<T>(`#${id}`)!;
  const currentDrafts = () => drafts.filter(draft=>draft.space===scope && draft.actor===actor && draft.key.startsWith(`${actor}/${scope}/${owner}/`));
  let conflictSignature='', otherSignature='';
  function state() {
    const pending=currentDrafts(), conflicts=pending.filter(draft=>draft.conflict);
    const failure=localFailure || error;
    const message=(typeof failure === 'function' ? failure() : failure) || (saving ? t(msg("sync.savingLocal", "正在保存到本机…")) : conflicts.length ? t(msg("sync.pendingCount", "{n, plural, other {# 条标注需要处理}}"), { n: conflicts.length }) : pending.length ? available && scope!=='local' ? t(msg("sync.savedPendingSync", "已存本机 · 等待同步")) : t(msg("sync.savedLocal", "已存本机")) : available && scope!=='local' ? t(msg("sync.synced", "已同步")) : t(msg("sync.savedLocal", "已存本机")));
    const saveState=localFailure || error || conflicts.length?'error':saving || (pending.length && scope!=='local')?'pending':'saved';
    window.dispatchEvent(new CustomEvent('voidplayer-annotation-status', { detail: { space: scope, message, state: saveState } }));
    const others=drafts.filter(draft=>draft.actor===actor && draft.space===scope && !draft.key.startsWith(`${actor}/${scope}/${owner}/`));
    const trouble=!!(localFailure || error || conflicts.length || others.length);
    $('annotation-recovery').hidden=!trouble;
    $<HTMLButtonElement>('annotation-sync-now').disabled=working || saving>0;
    $('annotation-drafts-export').hidden=!trouble || !(pending.some(draft=>draft.desired) || others.some(draft=>draft.desired) || pendingQueue.size);
    $('annotation-drafts-section').hidden=!others.length;
    const nextOthers=JSON.stringify(others);
    if(nextOthers!==otherSignature){otherSignature=nextOthers;$('annotation-other-drafts').replaceChildren(...others.map(draft=>{
      const row=document.createElement('div');row.className='annotation-conflict';const text=document.createElement('p');text.textContent=t(msg("sync.otherDrafts", "其他页面的草稿：{text}"), { text: draft.desired?.mark.text || t(msg("sync.frameMark", "画面标注")) });
      const button=document.createElement('button');button.textContent=t(msg("sync.continueHere", "在这里继续"));button.onclick=()=>void(async()=>{try{await storage.claim(draft.key,`${actor}/${scope}/${owner}/${draft.id}`);await apply();void sync();}catch(e){error=(e as Error).message;state();}})();row.append(text,button);return row;
    }));}
    const nextConflicts=JSON.stringify(conflicts);$('annotation-conflicts-section').hidden=!conflicts.length;if(nextConflicts===conflictSignature)return;conflictSignature=nextConflicts;
    const rows=conflicts.map(draft=>{
      const row=document.createElement('div'); row.className='annotation-conflict';
      const text=document.createElement('p');text.textContent=draft.desired?.mark.text || t(msg("sync.conflictChanged", "标注已被修改或删除"));
      const message=document.createElement('p');message.className='muted';message.textContent=draft.conflict!;
      const reload=document.createElement('button');reload.textContent=t(msg("sync.useServerVersion", "采用服务器版本")); reload.onclick=()=>void resolve(draft,false);
      const copy=document.createElement('button');copy.textContent=t(msg("sync.saveDraftAsMark", "草稿另存为标注"));copy.disabled=!draft.desired;copy.onclick=()=>void resolve(draft,true);
      row.append(text,message,reload,copy);return row;
    }); $('annotation-conflicts').replaceChildren(...rows);
  }
  async function refreshDrafts() { try { drafts=await storage.drafts(); state(); } catch(e) {error=(e as Error).message;state();} }
  async function enqueue(id: string, document: AnnotationDocument | null, base = versions.get(id) ?? 0, destination={space:scope,actorId:actor}) {
    if(document)document={mark:structuredClone(document.mark),media:document.media.map(media=>({...media,...(media.source?{source:{...media.source,url:new URL(media.source.url,location.href).href}}:{})}))};
    const {space,actorId}=destination,key=`${actorId}/${space}/${owner}/${id}`;
    // 用户新编辑：产生新的 seq 与 editGeneration，重试不得走这条路径。
    const pending=pendingQueue.stage(key,{id,document,base,space,actorId});editGeneration++;
    if(space===scope && actorId===actor)managed.add(id);saving++;state();
    try {
      await pendingQueue.runIfCurrent(key,pending,async()=>{
        await storage.change(key,previous=>({key,space,actor:actorId,id,base:previous?.base ?? base,desired:document,generation:(previous?.generation ?? 0)+1,...(previous?.attempt?{attempt:previous.attempt,sentGeneration:previous.sentGeneration}:{}),...(previous?.conflict?{conflict:previous.conflict}:{})}));
        pendingQueue.removeIfCurrent(key,pending);if(!pendingQueue.size)localFailure='';
      });
    } catch(e) {localFailure=()=>t(msg("sync.localSaveFailed", "本机保存失败：{error}"), { error: (e as Error).message });} finally {saving--;await refreshDrafts();}
  }
  async function persistRetry(key: string, pending: PendingEdit) {
    if(pendingQueue.get(key)!==pending)return;
    saving++;state();
    try {
      await pendingQueue.runIfCurrent(key,pending,async()=>{
        await storage.change(key,previous=>({key,space:pending.space,actor:pending.actorId,id:pending.id,base:previous?.base ?? pending.base,desired:pending.document,generation:(previous?.generation ?? 0)+1,...(previous?.attempt?{attempt:previous.attempt,sentGeneration:previous.sentGeneration}:{}),...(previous?.conflict?{conflict:previous.conflict}:{})}));
        pendingQueue.removeIfCurrent(key,pending);if(!pendingQueue.size)localFailure='';
      });
    } catch(e) {localFailure=()=>t(msg("sync.localSaveFailed", "本机保存失败：{error}"), { error: (e as Error).message });} finally {saving--;await refreshDrafts();}
  }
  const unsubscribeMarks=session.subscribeMarkChanges((id,document)=>{void enqueue(id,document);});
  async function apply(removeIds: string[] = []) {
    if (editing() || saving || pendingQueue.size) return;
    const captured=generation,edited=editGeneration, records=await storage.records(scope); await refreshDrafts(); if(captured!==generation || editing())return;
    const pending=currentDrafts(), protectedIds=new Set(pending.map(draft=>draft.id));
    const documents:AnnotationDocument[]=[];
    for(const record of records){
      if(protectedIds.has(record.id))continue;
      versions.set(record.id,record.revision);managed.add(record.id);
      if(!record.deleted)documents.push(record.document);
      const existingPreview=annotationThumbnails.get(record.id);
      if(!record.deleted && available && (!existingPreview || (existingPreview.url.startsWith('/api/annotations/') && existingPreview.url!==`/api/annotations/spaces/${scope}/${record.id}/preview?revision=${record.revision}`) || (existingPreview.signature && existingPreview.signature!==thumbnailSignature(record.document.mark)))) {
        publishMarkPreview(record.id,{url:`/api/annotations/spaces/${scope}/${record.id}/preview?revision=${record.revision}`,width:320,height:180,signature:thumbnailSignature(record.document.mark)});
      }
    }
    for(const draft of pending){managed.add(draft.id);if(draft.desired)documents.push(draft.desired);}
    for(const document of documents){const preview=await storage.preview(scope,document.mark.id);if(preview?.signature===thumbnailSignature(document.mark))publishMarkPreview(document.mark.id,preview);}
    if(captured!==generation || edited!==editGeneration || editing() || saving || pendingQueue.size)return;
    // Identical shared library versions remap to this window's ephemeral media IDs.
    // Stale ids are removed only with a completed load: dropping live marks
    // before the replacement is readable leaves a window where failed imports
    // or skipped syncs observably erase annotations.
    session.applyStoredAnnotations(documents,[...managed, ...removeIds]);
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
      if(!preview || !preview.url.startsWith('data:image/jpeg;base64,') || preview.signature!==thumbnailSignature(record.document.mark))continue;
      count++;
      const blob=await fetch(preview.url).then(response=>response.blob());
      const response=await fetch(`/api/annotations/spaces/${space}/${record.id}/preview?revision=${record.revision}&epoch=${previewEpoch}`,{method:'PUT',headers:{'x-voidplayer-action':'annotation','x-voidplayer-actor':actorId,'content-type':'image/jpeg'},body:blob,signal:AbortSignal.any([life.signal,AbortSignal.timeout(10000)])});
      if(response.ok)uploaded.set(key,token);
    }
  }
  window.addEventListener('voidplayer-annotation-preview',event=>{
    const {id,preview}=(event as CustomEvent).detail;
    const mark=session.getState().marks.find(mark=>mark.id===id);
    if(mark && preview.url.startsWith('data:image/jpeg;base64,') && thumbnailSignature(mark)===preview.signature)void storage.savePreview(scope,id,preview).catch(()=>{});
  },{signal:life.signal});
  async function sync() {
    if(life.signal.aborted)return;
    if(working)return syncIdle;
    working=true;let release!:()=>void;syncIdle=new Promise(resolve=>{release=resolve;});
    const captured=generation,space=scope,actorId=actor;
    try {
      // REVIEW-01：重试复用快照 pending，不产生新 seq；过期（被新编辑/删除取代）直接跳过。
      for(const [key, pending] of pendingQueue.snapshot())await persistRetry(key,pending);
      if(pendingQueue.size)return;
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
    } catch(e){if(captured===generation){error=available?()=>t(msg("sync.disconnectedKeepDrafts", "连接中断 · 本机草稿保留")):(e as Error).message;}}finally{working=false;await refreshDrafts();release();}
  }
  async function switchSpace(next:string) {
    if(editing() || pendingQueue.size || saving)throw new Error(t(msg("sync.waitForDrafts", "请先结束标注并等待本机草稿保存完成。")));
    // Restoring the current scope (e.g. failed-import rollback) must not
    // touch live marks: there is nothing to load that the session lacks.
    if(next===scope)return;
    generation++;scope=next;try{sessionStorage.setItem('voidplayer.annotation-space',scope);}catch{}cursor=0;versions.clear();
    const previous=[...managed];managed.clear();
    await syncIdle; await apply(previous); await sync();
  }
  let resolving=false;
  async function resolve(draft:AnnotationDraft,copy:boolean) {
    if(resolving)return;
    if(editing()){error=()=>t(msg("sync.finishEditingFirst", "请先结束当前标注编辑。"));state();return;}
    resolving=true;
    try {
      const record=await client.read(draft.space,draft.id);await storage.remember([record]);
      let replacement:AnnotationDraft|undefined;
      if(copy && draft.desired){const document=structuredClone(draft.desired);document.mark.id=randomUUID();replacement={key:`${actor}/${scope}/${owner}/${document.mark.id}`,space:scope,actor,id:document.mark.id,base:0,desired:document,generation:1};}
      await storage.resolve(draft,replacement);await apply();void sync();
    } catch(e){error=(e as Error).message;state();}finally{resolving=false;}
  }
  $('annotation-sync-now').onclick=()=>void sync();
  $('annotation-drafts-export').onclick=()=>void(async()=>{
    try{
      const drafts=(await storage.drafts().catch(()=>[])).filter(draft=>draft.actor===actor && draft.space===scope && draft.desired);
      const payload=annotationWorkspace([...drafts.map(draft=>draft.desired!),...pendingQueue.snapshot().flatMap(([,value])=>value.actorId===actor && value.space===scope && value.document?[value.document]:[])],location.origin+'/');
      const url=URL.createObjectURL(new Blob([JSON.stringify(payload,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='VoidPlayer-annotation-drafts.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    }catch(e){error=(e as Error).message;state();}
  })();
  let trackSignature='';
  const unsubscribe=session.subscribe(()=>{
    const state=session.getState(), signature=state.tracks.map(track=>annotationMediaKey(track)).join('|');
    if(signature!==trackSignature){trackSignature=signature;void apply();}
  });
  window.addEventListener('beforeunload',event=>{if(saving || pendingQueue.size || localFailure){event.preventDefault();event.returnValue='';}},{signal:life.signal});
  const interval=setInterval(()=>{if(!document.hidden)void sync();},3000);
  async function connect(){try{const health=await identityHealth();actor=health.actor?.id??actor;available=!!health.capabilities?.annotations;await apply();void sync();}catch{void apply();}}
  window.addEventListener('online',()=>void connect(),{signal:life.signal});
  window.addEventListener('focus',()=>void sync(),{signal:life.signal});
  document.getElementById('settings')!.addEventListener('settings-pane-change',event=>{
    if((event as CustomEvent).detail==='workspace')void refreshDrafts();
  },{signal:life.signal});
  window.addEventListener('voidplayer-identity-change',()=>{
    const next=currentActor()?.id ?? 'local';if(next===actor)return;
    generation++;actor=next;cursor=0;versions.clear();void apply();
  },{signal:life.signal});
  onLanguageChange(() => {
    for(const [index,row] of [...$('annotation-other-drafts').children].entries()) {
      const draft=drafts.filter(d=>d.actor===actor && d.space===scope && !d.key.startsWith(`${actor}/${scope}/${owner}/`))[index];
      if(!draft)continue;
      row.querySelector('p')!.textContent=t(msg("sync.otherDrafts", "其他页面的草稿：{text}"), { text: draft.desired?.mark.text || t(msg("sync.frameMark", "画面标注")) });
      row.querySelector('button')!.textContent=t(msg("sync.continueHere", "在这里继续"));
    }
    for(const row of $('annotation-conflicts').children) {
      const buttons=row.querySelectorAll('button');
      buttons[0].textContent=t(msg("sync.useServerVersion", "采用服务器版本"));
      buttons[1].textContent=t(msg("sync.saveDraftAsMark", "草稿另存为标注"));
    }
    state();
  }, life.signal);
  void connect();
  state();
  return {
    openSpace: switchSpace,
    scope: () => scope,
    async attachWorkspace(space: string, seededIds: string[] = []) {
      // Read the seeded records before switching scope so edits made during the
      // request keep their local draft. Set all bases before staging remote edits.
      const records=new Map<string,AnnotationRecord>();
      let after=0,page;
      do { page=await client.changes(space,after);await storage.remember(page.entries);after=page.cursor;for(const record of page.entries)records.set(record.id,record); } while(page.more);
      await syncIdle;
      if (pendingQueue.size || saving) throw new Error(t(msg("sync.savingDrafts", "本机草稿正在保存，请稍后重试。")));
      const snapshot=session.exportWorkspace(location.origin+'/');
      generation++; scope=space; cursor=after; versions.clear(); managed.clear();
      for(const record of records.values())versions.set(record.id,record.revision);
      try{sessionStorage.setItem('voidplayer.annotation-space',space);}catch{}
      const ids=new Set([...snapshot.marks.map(mark=>mark.id),...seededIds]);
      for (const id of ids) {
        // Re-read each mark in case another edit occurred while earlier drafts saved.
        const current=session.exportWorkspace(location.origin+'/'),mark=current.marks.find(mark=>mark.id===id),remote=records.get(id);
        if(!mark){if(remote && !remote.deleted)await enqueue(id,null,remote.revision);continue;}
        const mediaIds=new Set([mark.mediaId,...mark.comparison.map(item=>item.mediaId)]);
        if (!remote || remote.deleted || JSON.stringify(mark)!==JSON.stringify(remote.document.mark)) await enqueue(id,{mark,media:current.media.filter(media=>mediaIds.has(media.id))},remote?.revision??0);
      }
      await sync();
    },
    snapshotMode(){if(pendingQueue.size)throw new Error(t(msg("sync.draftsUnsaved", "本机草稿尚未保存，请先重试或导出。")));const previous=scope;generation++;scope='local';try{sessionStorage.setItem('voidplayer.annotation-space',scope);}catch{}cursor=0;versions.clear();managed.clear();state();return ()=>switchSpace(previous);},
    async captureSnapshot(){const snapshot=session.exportWorkspace(location.origin+'/');for(const mark of snapshot.marks){const ids=new Set([mark.mediaId,...mark.comparison.map(item=>item.mediaId)]);await enqueue(mark.id,{mark,media:snapshot.media.filter(media=>ids.has(media.id))},0);}},
    dispose(){life.abort();clearInterval(interval);unsubscribe();unsubscribeMarks();},
  };
}
