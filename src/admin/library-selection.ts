import {t,msg} from '../i18n.ts';
import {icon} from '../ui/icons.ts';
import {mutateLibraryFiles,LibraryFileOutcomeUnknownError} from '../services/library-files.ts';
import {LIBRARY_FILE_BATCH_LIMIT} from '../../shared/service/library-files.ts';
import type {LibraryFileRef,LibraryFileTarget} from '../../shared/service/library-files.ts';

type Drag = {id:number; row:HTMLElement; scope:string; key:string; x:number; y:number; clientX:number; clientY:number; refs?:LibraryFileRef[]; ghost?:HTMLElement; target?:LibraryFileTarget; highlight?:HTMLElement};

/** Administration owns selection and explicit moves; browsing stays session-free. */
export function installLibrarySelection(host:HTMLElement, list:HTMLElement, signal:AbortSignal, options:{
  navigate(root:string,directory:string):void;
  location():{root:string;directory:string};
  refresh():Promise<unknown>;
  closeMenu():void;
  notify(message:string):void;
}) {
  host.dataset.fileManager='';
  let scope='',anchor='',selected=new Set<string>(),busy=false,drag:Drag|undefined,swallowClick=false,scrollFrame=0;
  const events={signal}, capture={signal,capture:true};
  const rows=() => [...list.querySelectorAll<HTMLElement>('[data-library-kind]')].filter(row => !!row.getClientRects().length);
  const rowAt=(target:EventTarget|null) => target instanceof Element?target.closest<HTMLElement>('.source-row[data-library-kind]'):null;
  const columnOf=(row:HTMLElement) => row.closest<HTMLElement>('.library-column, .library-list-view')!;
  const scopeOf=(row:HTMLElement) => {
    const column=columnOf(row);
    return column.classList.contains('library-column')?JSON.stringify([column.dataset.root,column.dataset.directory]):'list';
  };
  const inColumn=(row:HTMLElement) => rows().filter(other => scopeOf(other)===scopeOf(row));
  const keyOf=(row:HTMLElement) => JSON.stringify([row.dataset.rootId,row.dataset.libraryPath,row.dataset.libraryKind]);
  const chosen=() => rows().filter(row => scopeOf(row)===scope&&selected.has(keyOf(row)));
  function sync() {
    const visible=rows(),keys=new Set(visible.filter(row => scopeOf(row)===scope).map(keyOf));
    selected=new Set([...selected].filter(key => keys.has(key)));
    for (const row of visible) {
      const yes=scopeOf(row)===scope&&selected.has(keyOf(row));
      row.classList.toggle('library-item-selected',yes);
      row.setAttribute('role','option'); row.setAttribute('aria-selected',String(yes)); row.tabIndex=0;
      const column=columnOf(row); column.setAttribute('role','listbox'); column.setAttribute('aria-multiselectable','true');
    }
  }
  function select(row:HTMLElement, shift=false, toggle=false) {
    const nextScope=scopeOf(row),key=keyOf(row);
    if (scope!==nextScope) {selected.clear();anchor='';scope=nextScope;}
    const siblings=inColumn(row),from=siblings.findIndex(row => keyOf(row)===anchor),to=siblings.indexOf(row);
    if (shift&&from>=0) {
      if (!toggle) selected.clear();
      for (const sibling of siblings.slice(Math.min(from,to),Math.max(from,to)+1)) selected.add(keyOf(sibling));
    } else if (toggle) {
      if (selected.has(key)) selected.delete(key); else selected.add(key);
      anchor=key;
    } else {selected=new Set([key]);anchor=key;}
    sync();
  }
  function clear() {selected.clear();anchor='';sync();}
  function open(row:HTMLElement) {
    if (row.dataset.libraryKind==='file') return;
    options.navigate(row.dataset.rootId!,row.dataset.libraryPath!);
  }
  host.addEventListener('click',event => {
    const row=rowAt(event.target);
    if (!row||!list.contains(row)) return;
    event.preventDefault();event.stopImmediatePropagation();
    if (busy) return;
    select(row,event.shiftKey,event.metaKey||event.ctrlKey);
    row.focus({preventScroll:true});
    if (!event.shiftKey&&!event.metaKey&&!event.ctrlKey) open(row);
  },capture);
  host.addEventListener('contextmenu',event => {
    const row=rowAt(event.target);
    if (row&&list.contains(row)&&!row.classList.contains('library-item-selected')&&!busy) select(row);
  },capture);
  list.addEventListener('click',event => {
    if (!rowAt(event.target)&&!(event.target as Element).closest('.library-column-splitter, .source-scrollbar')) clear();
  },events);
  host.addEventListener('keydown',event => {
    const row=rowAt(event.target);
    if (!row||busy||event.altKey) return;
    if (event.key==='Escape') {event.preventDefault();stopDrag();clear();return;}
    const siblings=inColumn(row);
    if ((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='a') {
      event.preventDefault();scope=scopeOf(row);selected=new Set(siblings.map(keyOf));anchor=keyOf(row);sync();return;
    }
    if (event.key==='Enter'||event.key==='ArrowRight') {event.preventDefault();select(row);open(row);return;}
    if (event.key==='ArrowUp'||event.key==='ArrowDown') {
      event.preventDefault();
      const next=siblings[Math.max(0,Math.min(siblings.length-1,siblings.indexOf(row)+(event.key==='ArrowUp'?-1:1)))];
      if (next) {
        select(next,event.shiftKey);next.focus({preventScroll:true});next.scrollIntoView({block:'nearest',inline:'nearest'});
        if (!event.shiftKey) open(next);
      }
    }
  },events);
  const ref=(row:HTMLElement):LibraryFileRef => ({rootId:row.dataset.rootId!,path:row.dataset.libraryPath!,kind:row.dataset.libraryKind as LibraryFileRef['kind'],
    ...(row.dataset.libraryVersion?{version:row.dataset.libraryVersion}:{})});
  function destination(x:number,y:number) {
    const element=document.elementFromPoint(x,y);
    if (!element||!host.contains(element)) return;
    if (element.closest('.panel-splitter, .library-horizontal-scrollbar, .source-scrollbar')) return;
    const folder=element.closest<HTMLElement>('.library-folder[data-library-kind]');
    if (folder) return {target:{rootId:folder.dataset.rootId!,directory:folder.dataset.libraryPath!},highlight:folder};
    const crumb=element.closest<HTMLElement>('.library-path-item[data-root]');
    if (crumb?.dataset.root) return {target:{rootId:crumb.dataset.root,directory:crumb.dataset.directory??''},highlight:crumb};
    const column=element.closest<HTMLElement>('.library-column');
    if (column?.dataset.root) return {target:{rootId:column.dataset.root,directory:column.dataset.directory??''},highlight:column};
    if (!column&&host.dataset.libraryView==='list'&&list.contains(element)) {
      const location=options.location();
      if (location.root) return {target:{rootId:location.root,directory:location.directory},highlight:list};
    }
  }
  const validTarget=(target:LibraryFileTarget) => !!drag?.refs?.every(source => source.rootId!==target.rootId
    || target.directory!==source.path&&!(source.kind==='directory'&&target.directory.startsWith(source.path+'/'))
    && target.directory!==source.path.split('/').slice(0,-1).join('/'));
  function track() {
    if (!drag?.ghost) return;
    const bounds=drag.ghost.getBoundingClientRect();
    drag.ghost.style.transform=`translate(${Math.max(4,Math.min(drag.clientX+14,innerWidth-bounds.width-4))}px,${Math.max(4,Math.min(drag.clientY+12,innerHeight-bounds.height-4))}px)`;
    const found=destination(drag.clientX,drag.clientY);
    drag.highlight?.classList.remove('library-drop-target');
    drag.target=found&&validTarget(found.target)?found.target:undefined;
    drag.highlight=drag.target?found!.highlight:undefined;
    drag.highlight?.classList.add('library-drop-target');
    drag.ghost.dataset.allowed=String(!!drag.target);
  }
  function scrollDrag() {
    if (!drag?.ghost) return;
    const box=list.getBoundingClientRect(),edge=28;
    if (drag.clientY>box.top&&drag.clientY<box.bottom) {
      list.scrollLeft+=drag.clientX<box.left+edge?-10:drag.clientX>box.right-edge?10:0;
      const column=document.elementFromPoint(drag.clientX,drag.clientY)?.closest<HTMLElement>('.library-column')??list;
      const rect=column.getBoundingClientRect();
      column.scrollTop+=drag.clientY<rect.top+edge?-10:drag.clientY>rect.bottom-edge?10:0;
    }
    track();scrollFrame=requestAnimationFrame(scrollDrag);
  }
  function beginDrag(event:PointerEvent) {
    if (!drag) return;
    const liveRow=rows().find(row => scopeOf(row)===drag!.scope&&keyOf(row)===drag!.key);
    if (!liveRow) {drag=undefined;return;}
    drag.row=liveRow;
    if (!drag.row.classList.contains('library-item-selected')) select(drag.row,event.shiftKey,event.metaKey||event.ctrlKey);
    const picked=chosen();
    if (!picked.length||picked.some(row => row.dataset.libraryKind==='mount'||row.getAttribute('aria-disabled')==='true')) {drag=undefined;return;}
    if (picked.length>LIBRARY_FILE_BATCH_LIMIT) {options.notify(t(msg('adminLibrary.moveLimit','每次最多移动 100 个项目')));drag=undefined;return;}
    drag.refs=picked.map(ref);
    const ghost=document.createElement('div');ghost.className='library-drag-preview';ghost.setAttribute('aria-hidden','true');
    for (const row of picked.slice(0,5)) {
      const line=document.createElement('div');line.className='library-drag-item';
      const cover=row.querySelector<HTMLImageElement>('.source-thumb img[data-thumb-decoded=true]');
      const glyph=document.createElement('span');glyph.className='library-drag-icon';
      if (cover) glyph.append(cover.cloneNode(true)); else glyph.innerHTML=icon(row.dataset.libraryKind==='directory'?'open':'film');
      const name=document.createElement('span');name.textContent=row.querySelector('.filename')?.textContent??'';
      line.append(glyph,name);ghost.append(line);
    }
    const count=document.createElement('span');count.className='library-drag-count';count.textContent=String(picked.length);ghost.append(count);
    document.body.append(ghost);drag.ghost=ghost;
    options.closeMenu();host.classList.add('library-files-dragging');host.setPointerCapture(event.pointerId);
    scrollDrag();
  }
  function stopDrag() {
    cancelAnimationFrame(scrollFrame);
    if (!drag) return;
    const previous=drag;drag=undefined;
    previous.highlight?.classList.remove('library-drop-target');previous.ghost?.remove();host.classList.remove('library-files-dragging');
    if (host.hasPointerCapture(previous.id)) host.releasePointerCapture(previous.id);
  }
  async function moveFiles(sources:LibraryFileRef[], target:LibraryFileTarget) {
    busy=true;host.setAttribute('aria-busy','true');
    try {
      const result=await mutateLibraryFiles({operation:'move',sources,target});
      if (signal.aborted) return;
      const failed=result.results.filter(item => !item.ok);
      if (failed.length) options.notify(t(msg('adminLibrary.movePartial','已移动 {moved} 项，{failed} 项失败'),{moved:result.results.length-failed.length,failed:failed.length})+'\n'+failed.map(item => item.error).filter(Boolean).join('\n'));
      else options.notify(t(msg('adminLibrary.movedItems','已移动 {count} 个项目'),{count:result.results.length}));
      const location=options.location();
      const relocated=result.results.find(item => item.ok&&item.destination&&item.source.kind==='directory'&&item.source.rootId===location.root
        && (location.directory===item.source.path||location.directory.startsWith(item.source.path+'/')));
      if (relocated?.destination) options.navigate(relocated.destination.rootId,relocated.destination.path+location.directory.slice(relocated.source.path.length));
      clear();await options.refresh();
      if (!result.indexRefreshed) options.notify(t(msg('adminLibrary.moveIndexPending','文件操作已完成，目录索引尚未刷新，请重新扫描')));
    } catch (error) {
      if (!signal.aborted) {
        options.notify(error instanceof LibraryFileOutcomeUnknownError?t(msg('adminLibrary.moveUnknown','移动结果未确认，正在刷新目录，请核对后再操作')):(error as Error).message);
        await options.refresh();
      }
    } finally {busy=false;host.removeAttribute('aria-busy');}
  }
  host.addEventListener('pointerdown',event => {
    swallowClick=false;
    const row=rowAt(event.target);
    if (event.button!==0||event.pointerType==='touch'||event.pointerType==='pen'||!row||!list.contains(row)||busy) return;
    drag={id:event.pointerId,row,scope:scopeOf(row),key:keyOf(row),x:event.clientX,y:event.clientY,clientX:event.clientX,clientY:event.clientY};
  },events);
  document.addEventListener('pointermove',event => {
    if (!drag||drag.id!==event.pointerId) return;
    drag.clientX=event.clientX;drag.clientY=event.clientY;
    if (!drag.ghost&&Math.hypot(event.clientX-drag.x,event.clientY-drag.y)>6) beginDrag(event);
    if (drag?.ghost) {event.preventDefault();track();}
  },capture);
  document.addEventListener('pointerup',event => {
    if (!drag||drag.id!==event.pointerId) return;
    if (drag.ghost) {
      drag.clientX=event.clientX;drag.clientY=event.clientY;
      track();
    }
    const {ghost,refs,target}=drag;
    if (ghost) {event.preventDefault();event.stopImmediatePropagation();swallowClick=true;}
    stopDrag();
    if (ghost&&refs&&target) void moveFiles(refs,target);
  },capture);
  document.addEventListener('click',event => {
    if (!swallowClick) return;
    swallowClick=false;event.preventDefault();event.stopImmediatePropagation();
  },capture);
  document.addEventListener('pointercancel',stopDrag,capture);
  document.addEventListener('keydown',event => {if (event.key==='Escape'&&drag?.ghost) {event.preventDefault();event.stopImmediatePropagation();stopDrag();swallowClick=true;}},capture);
  window.addEventListener('blur',stopDrag,events);
  host.addEventListener('lostpointercapture',event => {if (drag?.id===event.pointerId) stopDrag();},events);
  host.addEventListener('dragstart',event => event.preventDefault(),events);
  const observer=new MutationObserver(sync);observer.observe(list,{childList:true,subtree:true});
  signal.addEventListener('abort',() => {stopDrag();observer.disconnect();},{once:true});
  return {sync,clear};
}
