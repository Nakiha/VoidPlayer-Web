import { t, msg } from '../i18n.ts';
import { fetchLibraryPage, LibraryChangedError } from '../services/library.ts';
import type { LibraryPage } from '../services/library.ts';
import { sourceKey } from './source-catalog.ts';
import type { SourceItem } from './source-catalog.ts';
import { installLibraryListing } from './library-view.ts';
import { installLibraryColumnLayout } from './library-column-layout.ts';
import { prefetchThumbnailStatuses } from '../thumbnails/client.ts';

type Scope = {root:string; directory:string; search:string};
type Record = {scope:Scope; page?:LibraryPage; stale:boolean; pending?:AbortController; sequence:number; error?:boolean; retryAt:number};
type Column = {key:string; frame:HTMLElement; body:HTMLElement; listing:ReturnType<typeof installLibraryListing>; signature:string; branch?:string; primary:boolean};
const keyOf = (scope:Scope) => JSON.stringify([scope.root,scope.directory,scope.search]);
const nearEnd = (element:HTMLElement) => element.scrollHeight-element.scrollTop-element.clientHeight < 180;

/** Miller columns reuse the same rows and menus. Only visible ancestors are read;
 * the navigation owner retains the current directory's pagination and tickets. */
export function installLibraryColumns(viewport: HTMLElement, host: HTMLElement, signal: AbortSignal, options: {
  fileRow(item:SourceItem, home:boolean): HTMLElement;
  navigate(root:string,directory:string): void;
  registerMount(row:HTMLElement,root:string): void;
  collapsible?: boolean; recent?: boolean;
  more(): void;
  localizeRow(row:HTMLElement,item:SourceItem,home:boolean): void;
}) {
  const records = new Map<string,Record>(), columns = new Map<string,Column>();
  let current: {location:Scope; page:LibraryPage; recent:SourceItem[]} | undefined;
  let enabled = false, version = '', revealed = '', frame = 0;
  const schedule = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      if (!enabled || signal.aborted || !current) return;
      const next = keyOf(current.location);
      if (revealed !== next) {revealed = next; viewport.scrollLeft = viewport.scrollWidth;}
      layout.updateScrollbar();
      ensureVisible();
    });
  };
  const layout = installLibraryColumnLayout(viewport,host,signal,schedule);
  function renderColumn(column:Column) {
    if (!current) return;
    const record = records.get(column.key)!;
    const home = !record.scope.root;
    const page = home ? current.page : record.page;
    column.frame.setAttribute('aria-busy',String(!!record.pending));
    const signature = JSON.stringify([page,home?current.recent:[],column.branch,current.page.roots.map(root => [root.id,root.name,root.state])]);
    if (signature === column.signature) return;
    column.signature = signature;
    if (!page) {
      const message = document.createElement('p'); message.className = 'panel-empty';
      message.textContent = record.error ? t(msg('libraryColumns.unavailable','无法读取目录，请稍后重试。')) : t(msg('libraryColumns.loading','正在读取目录…'));
      column.body.replaceChildren(message); return;
    }
    const query = home ? (!current.location.root ? current.location.search.toLocaleLowerCase() : '') : record.scope.search.toLocaleLowerCase();
    const items = home ? current.recent.filter(item => item.name.toLocaleLowerCase().includes(query)) : page.entries.map(entry => ({...entry,key:sourceKey(entry,entry.id),library:entry}));
    column.listing.render({home,query,page,items,fingerprint:item => JSON.stringify([home,item.key,item.name,item.size,item.lastModified,item.openedAt,item.library?.version,item.library?.state,current!.page.roots.map(root => [root.id,root.name,root.state])])});
    for (const row of column.body.querySelectorAll<HTMLElement>('.library-folder')) {
      const selected = row.dataset.sourceKey === column.branch;
      row.classList.toggle('library-column-selected',selected);
      if (selected) row.setAttribute('aria-current','location'); else row.removeAttribute('aria-current');
    }
    column.listing.localize(page,home,query);
    const selected = column.body.querySelector<HTMLElement>('.library-column-selected');
    if (selected && column.frame.dataset.branch !== column.branch) {
      const bounds = column.frame.getBoundingClientRect(), row = selected.getBoundingClientRect();
      if (row.top < bounds.top) column.frame.scrollTop += row.top-bounds.top;
      else if (row.bottom > bounds.bottom) column.frame.scrollTop += row.bottom-bounds.bottom;
    }
    column.frame.dataset.branch = selected ? column.branch ?? '' : '';
  }
  async function read(record:Record, append = false, restarted = false):Promise<void> {
    if (record.pending || signal.aborted || !enabled) return;
    const controller = record.pending = new AbortController(), ticket = ++record.sequence;
    const previous = record.page;
    const column = columns.get(keyOf(record.scope));
    column?.frame.setAttribute('aria-busy','true');
    try {
      const page = await fetchLibraryPage({root:record.scope.root,directory:record.scope.directory,limit:60,
        offset:append?previous?.nextOffset??0:0,revision:append?previous?.revision:undefined},AbortSignal.any([signal,controller.signal,AbortSignal.timeout(10000)]));
      if (record.sequence !== ticket || controller.signal.aborted || signal.aborted) return;
      record.page = append && previous ? {...page,entries:[...previous.entries,...page.entries],directories:[...previous.directories,...page.directories]} : page;
      prefetchThumbnailStatuses(page.entries,60,page.thumbnailEpoch);
      record.stale = false; record.error = false; record.retryAt = 0;
    } catch (error) {
      if (controller.signal.aborted || signal.aborted || record.sequence !== ticket) return;
      if (error instanceof LibraryChangedError && !restarted) {
        record.pending = undefined; record.stale = true; await read(record,false,true); return;
      }
      record.error = true; record.retryAt = Date.now()+3000;
    } finally {
      if (record.sequence === ticket && !controller.signal.aborted && !signal.aborted) {
        record.pending = undefined;
        const visibleColumn = columns.get(keyOf(record.scope));
        if (visibleColumn) {visibleColumn.signature = ''; renderColumn(visibleColumn); visibleColumn.frame.setAttribute('aria-busy','false');}
        schedule();
      }
    }
  }
  function ensureVisible() {
    if (!enabled || !current || !host.getClientRects().length) return;
    const bounds = viewport.getBoundingClientRect();
    for (const column of columns.values()) {
      if (column.primary || column.key === keyOf({root:'',directory:'',search:''})) continue;
      const box = column.frame.getBoundingClientRect();
      if (box.right < bounds.left-280 || box.left > bounds.right+280) continue;
      const record = records.get(column.key)!;
      if (record.pending || Date.now() < record.retryAt) continue;
      if (!record.page || record.stale) void read(record);
      else if (record.page.nextOffset !== null && (nearEnd(column.frame)
        || column.branch && !record.page.directories.some(folder => `folder:${folder.rootId}/${folder.path}` === column.branch))) void read(record,true);
    }
  }
  function render(value:{location:Scope; page:LibraryPage; recent:SourceItem[]}) {
    current = value;
    if (!enabled) return;
    const nextVersion = JSON.stringify([value.page.revision,value.page.thumbnailEpoch,value.page.roots.map(root => [root.id,root.name,root.state])]);
    if (version !== nextVersion) {
      version = nextVersion;
      for (const record of records.values()) {record.stale = true; record.pending?.abort(); record.pending=undefined; record.sequence++;}
    }
    const {root,directory,search} = value.location, parts = directory.split('/').filter(Boolean);
    const scopes:Scope[] = [{root:'',directory:'',search:''}];
    if (root) for (let depth=0;depth<=parts.length;depth++) scopes.push({root,directory:parts.slice(0,depth).join('/'),search:depth===parts.length?search:''});
    const desired = new Set(scopes.map(keyOf)), primary = root ? keyOf(value.location) : keyOf(scopes[0]);
    for (const [key,column] of columns) if (!desired.has(key)) {
      column.frame.remove(); columns.delete(key);
      const record = records.get(key)!; record.pending?.abort(); record.pending=undefined; record.sequence++;
    }
    for (const [index,scope] of scopes.entries()) {
      const key = keyOf(scope);
      let record = records.get(key);
      if (!record) {record = {scope,stale:true,sequence:0,retryAt:0}; records.set(key,record);}
      if (key === primary && record.page !== value.page) {
        record.pending?.abort(); record.pending = undefined; record.sequence++; record.page = value.page; record.stale = false;
      }
      let column = columns.get(key);
      if (!column) {
        const element = document.createElement('section'); element.className = 'library-column'; element.dataset.directory = scope.directory; element.dataset.root = scope.root;
        const body = document.createElement('div'); element.append(body);
        const listing = installLibraryListing(body,{fileRow:item => options.fileRow(item,!scope.root),navigate:options.navigate,registerMount:options.registerMount,idPrefix:`column-${index}-`,collapsible:options.collapsible,recent:options.recent});
        column = {key,frame:element,body,listing,signature:'',primary:false}; columns.set(key,column);
        element.addEventListener('scroll', () => {if (enabled && columns.get(key)?.primary) options.more(); ensureVisible();}, {signal,passive:true});
      }
      column.primary = key === primary;
      column.branch = index===0 && root ? `mount:${root}` : index>0 && index<scopes.length-1 ? `folder:${root}/${scopes[index+1].directory}` : undefined;
      column.frame.setAttribute('aria-label',!scope.root?t(msg('libraryBrowser.library','媒体库')):scope.directory.split('/').at(-1)||value.page.roots.find(item => item.id===root)?.name||root);
    }
    const ordered = scopes.map(scope => columns.get(keyOf(scope))!);
    layout.render(ordered.map(column => column.frame));
    ordered.forEach(renderColumn);
    for (const [key,record] of records) if (records.size>32 && !desired.has(key)) {record.pending?.abort();records.delete(key);}
    schedule();
  }
  viewport.addEventListener('scroll',ensureVisible,{signal,passive:true});
  const resize = new ResizeObserver(schedule); resize.observe(viewport);
  signal.addEventListener('abort',() => {cancelAnimationFrame(frame);resize.disconnect();for(const record of records.values())record.pending?.abort();},{once:true});
  return {render,nearEnd:() => {
    const column = [...columns.values()].find(column => column.primary);
    return !!column && nearEnd(column.frame);
  },setEnabled(value:boolean) {
    enabled = value;
    layout.setEnabled(value);
    if (!value) for (const record of records.values()) {record.pending?.abort();record.pending=undefined;record.sequence++;}
    else {revealed=''; if(current)render(current);}
  },localize() {
    for (const column of columns.values()) column.signature = '';
    if (current) {
      render(current);
      for (const column of columns.values()) {
        const record = records.get(column.key)!, home = !record.scope.root;
        const items:SourceItem[] = home ? current.recent : record.page?.entries.map(entry => ({...entry,key:sourceKey(entry,entry.id),library:entry})) ?? [];
        for (const item of items) for (const row of column.body.querySelectorAll<HTMLElement>('.source-file')) {
          if (row.dataset.sourceKey===item.key) options.localizeRow(row,item,home);
        }
      }
    }
  }};
}
