import { onLanguageChange, t, msg } from '../i18n.ts';
import { prefetchThumbnailStatuses } from '../thumbnails/client.ts';
import { installLibraryColumns } from '../ui/library-columns.ts';
import { createIconButton } from '../ui/controls.ts';
import { icon } from '../ui/icons.ts';
import { installMenu } from '../ui/menu.ts';
import { installLibraryBrowser } from '../ui/library-browser.ts';
import { createLibraryFileRow, installLibraryListing, librarySurfaceShell, patchLibraryRow } from '../ui/library-view.ts';
import { installLibraryThumbnails } from '../ui/library-thumbnails.ts';
import { installLibraryFileMenu } from '../ui/library-file-menu.ts';
import { libraryFileLink } from '../ui/library-link.ts';
import { sourceKey } from '../ui/source-catalog.ts';
import type { SourceItem } from '../ui/source-catalog.ts';
import { installSourceScrollbar } from '../ui/source-scrollbar.ts';
import { installTooltips } from '../ui/tooltips.ts';

/** Administration supplies navigation actions, never a hidden player session. */
export function installAdminLibraryBrowser(signal: AbortSignal, notify: (message: string) => void) {
  const host = document.getElementById('admin-library-browser')!;
  host.innerHTML = librarySurfaceShell();
  const find = (id: string) => host.querySelector<HTMLElement>(`#${id}`)!;
  const list = find('source-list'), foot = find('source-foot');
  const viewKey = 'voidplayer.admin.library-view';
  let mode:'list'|'columns' = 'columns';
  try {if(localStorage.getItem(viewKey)==='list')mode='list';} catch {}
  host.dataset.libraryView=mode;
  const listBody=document.createElement('div'); listBody.className='library-list-view'; listBody.dataset.libraryViewSurface='list';
  const columnsHost=document.createElement('div'); columnsHost.className='library-columns'; columnsHost.dataset.libraryViewSurface='columns';
  listBody.hidden=mode!=='list'; columnsHost.hidden=mode!=='columns'; list.append(listBody,columnsHost);
  const viewButton=createIconButton({glyph:'columns',label:t(msg('adminLibrary.viewMode','浏览视图')),className:'library-view-choice',attributes:{id:'admin-library-view','data-tooltip-suppressed':''}});
  let columns:ReturnType<typeof installLibraryColumns>;

  let active = false;
  const act = async (action: () => unknown | Promise<unknown>) => {
    try {await action();} catch (error) {if (!signal.aborted) notify((error as Error).message);}
  };
  const menu = installLibraryFileMenu(list, act, notify, signal);
  const thumbnails = installLibraryThumbnails([list], signal);
  const browser = installLibraryBrowser({list,tools:find('source-tools'),foot,visible:() => active,trailing:viewButton,
    nearEnd:() => mode==='columns' ? !!columns?.nearEnd() : list.scrollHeight-list.scrollTop-list.clientHeight<180}, page => {
    if (page) prefetchThumbnailStatuses(page.entries,60,page.thumbnailEpoch);
    render();
  }, signal, undefined, notify);
  const listing = installLibraryListing(listBody, {fileRow,navigate:browser.navigate,registerMount:menu.registerMount,collapsible:false,recent:false});
  columns = installLibraryColumns(list,columnsHost,signal,{fileRow:(item,home) => fileRow(item,false,home),navigate:browser.navigate,registerMount:menu.registerMount,more:browser.more,collapsible:false,recent:false,
    localizeRow:(row,item,home) => patchLibraryRow(row,fileRow(item,true,home))});
  columns.setEnabled(mode==='columns');
  const scrollbar = installSourceScrollbar(list, find('source-scrollbar'), find('source-scrollbar-thumb'), signal);
  const disposeTooltips = installTooltips(host);
  const viewMenu=document.createElement('div'); viewMenu.id='admin-library-view-menu'; viewMenu.className='choice-menu'; document.body.append(viewMenu);
  const choices: {value:'list'|'columns'; button:HTMLButtonElement}[] = ['list','columns'].map(value => {
    const button=document.createElement('button'); button.type='button'; button.dataset.value=value; button.setAttribute('role','menuitemradio');
    viewMenu.append(button); button.onclick=() => setMode(value as 'list'|'columns');
    return {value:value as 'list'|'columns',button};
  });
  const viewControl=installMenu(viewButton,viewMenu,{selected:() => choices.find(choice => choice.value===mode)?.button});
  function modeLabel(value:'list'|'columns') {return value==='list'?t(msg('adminLibrary.listView','列表视图')):t(msg('adminLibrary.columnView','分栏视图'));}
  function syncChoice() {
    viewButton.innerHTML=icon(mode==='list'?'listBullets':'columns')+icon('caretUpDown');
    viewButton.setAttribute('aria-label',`${t(msg('adminLibrary.viewMode','浏览视图'))} · ${modeLabel(mode)}`);
    viewMenu.setAttribute('aria-label',t(msg('adminLibrary.viewMode','浏览视图')));
    for (const choice of choices) {
      choice.button.setAttribute('aria-checked',String(choice.value===mode)); choice.button.setAttribute('aria-label',modeLabel(choice.value));
      choice.button.innerHTML=icon(choice.value==='list'?'listBullets':'columns');
      const label=document.createElement('span'); label.textContent=modeLabel(choice.value); choice.button.append(label);
    }
  }
  function setMode(value:'list'|'columns') {
    if(value===mode)return;
    mode=value; host.dataset.libraryView=mode; list.scrollTop=0; list.scrollLeft=0;
    listBody.hidden=mode!=='list'; columnsHost.hidden=mode!=='columns'; columns.setEnabled(mode==='columns');
    try {localStorage.setItem(viewKey,mode);} catch {}
    syncChoice(); render();
  }
  syncChoice();

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
    if (mode==='columns') {if(page)columns.render({location:browser.appliedLocation(),page,recent:[]});}
    else listing.render({home,query,page,items,fingerprint});
    scrollbar.update();
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
    listing.localize(browser.page(),browser.isRoot(),browser.filter()); columns.localize(); syncChoice();
  },signal);
  signal.addEventListener('abort', () => {cancelAnimationFrame(footFrame); footSize.disconnect(); disposeTooltips(); viewControl.dispose(); viewMenu.remove();}, {once:true});
  return {activate(value: boolean) {
    active = value;
    if (value) void browser.load();
  }, refresh:() => browser.load()};
}
