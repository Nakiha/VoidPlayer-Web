import { onLanguageChange, t, msg } from '../i18n.ts';
import { installLibraryColumns } from '../ui/library-columns.ts';
import { installLibraryBrowser } from '../ui/library-browser.ts';
import { createLibraryFileRow, installLibraryListing, installLibraryViews, librarySurfaceShell, patchLibraryRow } from '../ui/library-view.ts';
import { installLibraryThumbnails } from '../ui/library-thumbnails.ts';
import { installLibraryFileMenu } from '../ui/library-file-menu.ts';
import { libraryFileLink } from '../ui/library-link.ts';
import { sourceKey } from '../ui/source-catalog.ts';
import type { SourceItem } from '../ui/source-catalog.ts';
import { installSourceScrollbar } from '../ui/source-scrollbar.ts';
import {installLibrarySelection} from './library-selection.ts';

/** Administration supplies navigation actions, never a hidden player session. */
export function installAdminLibraryBrowser(signal: AbortSignal, notify: (message: string) => void) {
  const host = document.getElementById('admin-library-browser')!;
  host.innerHTML = librarySurfaceShell();
  const find = (id: string) => host.querySelector<HTMLElement>(`#${id}`)!;
  const list = find('source-list'), foot = find('source-foot');
  let columns:ReturnType<typeof installLibraryColumns>;
  const views = installLibraryViews(host,list,signal,{id:'admin-library-view',preferenceKey:'voidplayer.admin.library-view',defaultMode:'columns',
    changed() {columns.setEnabled(views.mode() === 'columns'); render();}});
  const {listBody,columnsHost} = views;
  let selection:ReturnType<typeof installLibrarySelection>|undefined;

  const rowEntries=new WeakMap<HTMLElement,SourceItem>();
  let active = false;
  const act = async (action: () => unknown | Promise<unknown>) => {
    try {await action();} catch (error) {if (!signal.aborted) notify((error as Error).message);}
  };
  const menu = installLibraryFileMenu(list, act, notify, signal);
  const thumbnails = installLibraryThumbnails([list], signal);
  const browser = installLibraryBrowser({list,tools:find('source-tools'),foot,visible:() => active,view:views.button,
    nearEnd:() => views.mode()==='columns' ? !!columns?.nearEnd() : list.scrollHeight-list.scrollTop-list.clientHeight<180}, page => {
    render();
  }, signal, undefined, notify);
  const listing = installLibraryListing(listBody, {fileRow,navigate:browser.navigate,registerMount:menu.registerMount,collapsible:false,recent:false});
  columns = installLibraryColumns(list,columnsHost,signal,{fileRow:(item,home) => fileRow(item,false,home),navigate:browser.navigate,registerMount:menu.registerMount,more:browser.more,collapsible:false,recent:false,pathClass:'library-column-path',
    localizeRow:(row,item,home) => patchLibraryRow(row,fileRow(item,true,home))});
  columns.setEnabled(views.mode()==='columns');
  selection=installLibrarySelection(host,list,signal,{navigate:browser.navigate,location:browser.appliedLocation,refresh:browser.load,closeMenu:menu.close,notify,
    selectFile:row=>browser.selectFile(row && rowEntries.get(row)?.library)});
  const scrollbar = installSourceScrollbar(list, find('source-scrollbar'), find('source-scrollbar-thumb'), signal);
  let footFrame = 0, footHeight = -1;
  const footSize = new ResizeObserver(() => {
    cancelAnimationFrame(footFrame);
    footFrame = requestAnimationFrame(() => {
      if (signal.aborted) return;
      const height = foot.getBoundingClientRect().height;
      if (height !== footHeight) {footHeight = height; host.style.setProperty('--foot-h', `${height}px`); scrollbar.update();}
    });
  });
  footSize.observe(foot);
  function openInPlayer(item: SourceItem) {
    if (item.library) window.open(libraryFileLink(item.library,location.href), '_blank', 'noopener');
  }
  function fileRow(item: SourceItem, copyOnly = false, home = browser.isRoot()) {
    const offline = browser.page()?.roots.some(root => root.id === item.library?.rootId && root.state === 'offline');
    const disabled = !!offline || !item.library?.version || !!item.library?.state && item.library.state !== 'ready';
    const row = createLibraryFileRow(item, {home,offline,tooltip:item.name,readOnly:true,
      label:item.name, open:() => {}});
    if (!copyOnly) {
      rowEntries.set(row,item);
      thumbnails.attach(row,item);
      menu.register(row,item.library,() => ({id:'browse-in-player',label:t(msg('adminLibrary.openInPlayer', '在播放器中浏览')),glyph:'play',disabled,run:() => openInPlayer(item)}));
      row.tabIndex = 0;
    }
    return row;
  }
  function render() {
    const home = browser.isRoot(), query = browser.filter().toLocaleLowerCase(), page = browser.page();
    const items = home ? [] : currentItems().filter(item => item.name.toLocaleLowerCase().includes(query));
    const fingerprint = (item: SourceItem) => JSON.stringify([home,item.key,item.name,item.size,item.lastModified,item.openedAt,item.library?.version,item.library?.state,
      page?.roots.map(root => [root.id,root.name,root.state])]);
    if (views.mode()==='columns') {if(page)columns.render({location:browser.appliedLocation(),page,recent:[]});}
    else listing.render({home,query,page,items,fingerprint});
    selection?.sync();scrollbar.update();
  }
  function currentItems(): SourceItem[] {
    return browser.page()?.entries.map(entry => ({...entry,key:sourceKey(entry,entry.id),library:entry})) ?? [];
  }
  onLanguageChange(() => {
    const items = new Map(currentItems().map(item => [item.key,item]));
    for (const row of list.querySelectorAll<HTMLElement>('.source-file')) {
      const item = items.get(row.dataset.sourceKey!); if (!item) continue;
      const fresh = fileRow(item,true,row.closest('.library-column')?.getAttribute('data-root')==='' || (!row.closest('.library-column') && browser.isRoot()));
      patchLibraryRow(row,fresh);
    }
    listing.localize(browser.page(),browser.isRoot(),browser.filter()); columns.localize();
  },signal);
  signal.addEventListener('abort', () => {cancelAnimationFrame(footFrame); footSize.disconnect();}, {once:true});
  return {activate(value: boolean) {
    active = value;
    if (value) void browser.load();
  }, refresh:() => browser.load()};
}
