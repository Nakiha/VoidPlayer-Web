import { fetchLibraryPage, LibraryChangedError } from '../services/library.ts';
import { PollingCadence } from '../services/polling-cadence.ts';
import type { LibraryPage, LibraryEntry, LibraryRoot } from '../services/library.ts';
import { onLanguageChange, t, msg } from '../i18n.ts';
import { createIconButton } from './controls.ts';
import { icon } from './icons.ts';
import { installContextMenu } from './context-menu.ts';
import { libraryLocationExpression, parseLibraryLocationInput, parseLibraryLocationLink } from './library-link.ts';

export type LibraryBrowserElements = { list: HTMLElement; tools: HTMLElement; foot: HTMLElement; visible(): boolean; manage?: boolean; trailing?: HTMLElement; nearEnd?(): boolean };

/** One directory owner for mounted libraries, scoped search and path navigation. */
export function installLibraryBrowser(elements: LibraryBrowserElements, change: (page: LibraryPage | null) => void, signal: AbortSignal, onScope?: (home: boolean) => void,
  notify: (message: string) => void = () => {}, observeRecent: () => boolean = () => false) {
  let initial = { root: '', directory: '', all: false };
  if (new URL(location.href).searchParams.has('library')) {
    try { initial = parseLibraryLocationLink(location.href, location.href); } catch { /* Ignore malformed startup links. */ }
  }
  let root = initial.all ? '' : initial.root, directory = initial.all ? '' : initial.directory;
  let publishedRoot = root, publishedDirectory = directory;
  let page: LibraryPage | null = null, roots: LibraryRoot[] = [], search = '', appliedSearch = '';
  let request: AbortController | undefined, sequence = 0, loading = false, pendingSearch = false;
  type Location = { root: string; directory: string; search: string };
  let history: Location[] = [{root,directory,search}], historyIndex = 0;
  let pathSignature = '', appliedScope = '', searchTimer: ReturnType<typeof setTimeout> | undefined;
  const cadence = new PollingCadence(3000);
  const {list,tools,foot} = elements;
  const densityKey = 'voidplayer.library-compact';
  let compact = false;
  try {compact = (localStorage.getItem(densityKey) ?? localStorage.getItem('voidplayer.admin.library-compact')) === 'true';} catch {}
  const compactButton = createIconButton({glyph:'compactRows',label:t(msg('libraryBrowser.compactList','紧凑列表')),attributes:{id:'library-compact'}});
  function syncDensity() {
    list.dataset.libraryDensity = compact ? 'compact' : 'comfortable';
    compactButton.setAttribute('aria-pressed',String(compact));
    const label = t(msg('libraryBrowser.compactList','紧凑列表'));
    compactButton.setAttribute('aria-label',label); compactButton.dataset.tooltip=label;
    list.dispatchEvent(new Event('library-density-change'));
  }
  compactButton.addEventListener('click',() => {
    compact=!compact;
    try {localStorage.setItem(densityKey,String(compact));} catch {}
    syncDensity();
  },{signal});
  window.addEventListener('storage',event => {
    if (event.key!==densityKey) return;
    compact=event.newValue==='true'; syncDensity();
  },{signal});
  syncDensity();
  const nav = document.createElement('div'); nav.className = 'library-navigation'; nav.id = 'library-navigation';
  const address = document.createElement('input'); address.id = 'library-location'; address.className = 'library-location';
  address.type = 'search'; address.autocomplete = 'off'; address.spellcheck = false;
  const manage = document.createElement('a'); manage.id = 'library-manage'; manage.className = 'icon-button library-manage';
  manage.href = '/admin#library'; manage.target = '_blank'; manage.rel = 'opener'; manage.innerHTML = icon('externalLink');
  function localizeManage() {
    manage.setAttribute('aria-label', t(msg('libraryBrowser.manage', '媒体库管理')));
    manage.dataset.tooltip = t(msg('libraryBrowser.openManagement', '在新标签页打开媒体库管理'));
  }
  localizeManage();
  nav.append(address);
  const back = createIconButton({ glyph: 'caretLeft', label: t(msg('libraryBrowser.goBack', '后退')), className: 'crumbs-back', attributes:{'data-tooltip-suppressed':''} });
  const forward = createIconButton({ glyph: 'caretRight', label: t(msg('libraryBrowser.goForward', '前进')), className: 'crumbs-forward', attributes:{'data-tooltip-suppressed':''} });
  const historyControls = document.createElement('div'); historyControls.className = 'library-history';
  historyControls.append(back, forward); tools.replaceChildren(historyControls, nav, compactButton);
  if (elements.manage) tools.append(manage);
  if (elements.trailing) tools.append(elements.trailing);
  const pathbar = document.createElement('nav'); pathbar.id = 'library-pathbar'; pathbar.className = 'library-pathbar';
  foot.prepend(pathbar);
  pathbar.addEventListener('click', event => {
    const target = (event.target as Element).closest('li')?.querySelector<HTMLButtonElement>('button[data-root]');
    if (target && !target.hasAttribute('aria-current')) navigate(target.dataset.root ?? '', target.dataset.directory ?? '');
  }, { signal });
  const pathResize = new ResizeObserver(() => { pathbar.scrollLeft = pathbar.scrollWidth; });
  pathResize.observe(pathbar);
  installContextMenu(pathbar, {
    id: 'library-path-menu', selector: '.library-path-item', signal, popover: 'manual',
    actions(target) {
      return [{ id: 'copy-library-path', label: t(msg('libraryFileMenu.copyLibraryPath', '拷贝媒体库路径')), glyph: 'copy', run() {
        try {
          const value = libraryLocationExpression({ root: target.dataset.root ?? '', directory: target.dataset.directory ?? '', all: false });
          void navigator.clipboard.writeText(value).then(() => notify(t(msg('libraryFileMenu.copied', '已拷贝'))), error => notify(String(error.message ?? error)));
        } catch (error) { notify((error as Error).message); }
      } }];
    },
  });
  const locationInput = () => /^(library:|https?:\/\/)/i.test(address.value.trim());
  address.addEventListener('focus', () => { address.value = search; controls(); });
  address.addEventListener('blur', () => { address.removeAttribute('aria-invalid'); controls(); });
  const edit = () => {
    address.removeAttribute('aria-invalid');
    if (locationInput()) {
      clearTimeout(searchTimer); request?.abort(); sequence++; loading = false; pendingSearch = false;
      search = appliedSearch; controls();
    } else searchFor(address.value);
  };
  address.addEventListener('input', event => { if (!(event as InputEvent).isComposing) edit(); }, { signal });
  address.addEventListener('compositionend', edit, { signal });
  address.addEventListener('keydown', event => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') { event.preventDefault(); searchFor(''); address.blur(); return; }
    if (event.key !== 'Enter') return;
    event.preventDefault();
    if (!locationInput()) { clearTimeout(searchTimer); if (pendingSearch) reset(); return; }
    try {
      const target = parseLibraryLocationInput(address.value, location.href);
      if (target.root && !roots.some(item => item.id === target.root)) throw new Error(t(msg('libraryBrowser.unknownLibrary', '此媒体库在当前服务中不存在')));
      navigate(target.all ? '' : target.root, target.all ? '' : target.directory); address.blur();
    } catch (error) { address.setAttribute('aria-invalid', 'true'); notify((error as Error).message); address.select(); }
  }, { signal });
  function displayName() {
    return directory.split('/').at(-1) || roots.find(item => item.id === root)?.name || t(msg('libraryBrowser.library', '媒体库'));
  }
  function renderPathbar() {
    pathbar.setAttribute('aria-label', t(msg('libraryBrowser.pathLabel', '媒体库路径')));
    const crumbs: { label: string; glyph: Parameters<typeof icon>[0]; root: string; directory: string }[] = [
      { label: t(msg('libraryBrowser.library', '媒体库')), glyph: 'film', root: '', directory: '' },
    ];
    if (root) {
      crumbs.push({ label: roots.find(item => item.id === root)?.name ?? root, glyph: 'libraryVolume', root, directory: '' });
      const parts = directory.split('/').filter(Boolean);
      for (const [index, label] of parts.entries()) crumbs.push({ label, glyph: 'open', root, directory: parts.slice(0, index + 1).join('/') });
    }
    const signature = JSON.stringify(crumbs);
    if (signature === pathSignature) return;
    pathSignature = signature;
    const trail = document.createElement('ol');
    for (const [index, crumb] of crumbs.entries()) {
      const entry = document.createElement('li');
      const part = document.createElement('button'); part.type = 'button'; part.className = 'library-path-item';
      part.dataset.root = crumb.root; part.dataset.directory = crumb.directory; part.dataset.kind = crumb.glyph === 'open' ? 'folder' : 'library';
      part.dataset.tooltipSuppressed = ''; part.innerHTML = icon(crumb.glyph); part.setAttribute('aria-haspopup', 'menu');
      if (index) {
        const separator = document.createElement('span'); separator.className = 'library-path-separator';
        separator.setAttribute('aria-hidden', 'true'); separator.innerHTML = icon('pathSeparator'); entry.append(separator);
      }
      if (index === crumbs.length - 1) part.setAttribute('aria-current', 'location');
      const label = document.createElement('span'); label.className = 'library-path-label'; label.textContent = crumb.label;
      part.append(label); entry.append(part); trail.append(entry);
    }
    pathbar.replaceChildren(trail); pathbar.scrollLeft = pathbar.scrollWidth;
  }
  const currentLocation = (): Location => ({root,directory,search});
  function rememberNavigation(next: Location) {
    history[historyIndex] = currentLocation();
    if (JSON.stringify(history[historyIndex]) === JSON.stringify(next)) return;
    history.splice(historyIndex + 1); history.push(next); historyIndex++;
    if (history.length > 100) {history.shift(); historyIndex--;}
  }
  function traverse(delta: number) {
    const next = historyIndex + delta;
    if (next < 0 || next >= history.length) return;
    history[historyIndex] = currentLocation(); historyIndex = next;
    ({root,directory,search} = history[historyIndex]); address.value = search; reset();
  }
  back.onclick = () => traverse(-1);
  forward.onclick = () => traverse(1);
  function controls() {
    back.disabled = historyIndex === 0;
    forward.disabled = historyIndex === history.length - 1;
    address.setAttribute('aria-label', t(msg('libraryBrowser.locationLabel', '搜索当前目录或输入媒体库路径')));
    address.placeholder = t(msg('libraryBrowser.searchUnder', '{scope} 下搜索'), { scope: displayName() });
    if (document.activeElement !== address) address.value = search || displayName();
    renderPathbar();
    list.setAttribute('aria-busy', String(loading || pendingSearch));
  }
  function render() { controls(); change(page); }
  async function load(append = false, resetView = false, restarted = false): Promise<void> {
    clearTimeout(searchTimer); pendingSearch = false;
    const scope = JSON.stringify([root, directory, search]);
    resetView ||= scope !== appliedScope;
    const ticket = ++sequence; request?.abort(); request = new AbortController(); loading = true; controls();
    let published = false;
    const previous = page, targetCount = resetView ? 60 : Math.max(60, previous?.entries.length ?? 0, previous?.directories.length ?? 0);
    const abort = AbortSignal.any([signal, request.signal, AbortSignal.timeout(10000)]);
    try {
      const query = { root: root || undefined, directory, search: root ? search : '', recursive: !!root && !!search, limit: 60 };
      let value = await fetchLibraryPage({ ...query, offset: append ? previous?.nextOffset ?? 0 : 0, revision: resetView || restarted ? undefined : previous?.revision }, abort,
        !append && !resetView && !restarted ? previous ?? undefined : undefined);
      if (!root) value = { ...value, entries: [], directories: [], nextOffset: null, total: 0 };
      if (append && previous) value = { ...value, entries: [...previous.entries, ...value.entries], directories: [...previous.directories, ...value.directories] };
      else if (!resetView && previous?.revision === value.revision && previous.thumbnailEpoch === value.thumbnailEpoch) {
        const fresh = new Map(value.entries.map(entry => [entry.id, entry]));
        value = { ...value, entries: previous.entries.map(entry => fresh.get(entry.id) ?? entry),
          directories: previous.directories, nextOffset: previous.nextOffset };
      }
      else while (Math.max(value.entries.length, value.directories.length) < targetCount && value.nextOffset !== null) {
        const more = await fetchLibraryPage({ ...query, offset: value.nextOffset, revision: value.revision }, abort);
        value = { ...value, entries: [...value.entries, ...more.entries], directories: [...value.directories, ...more.directories], nextOffset: more.nextOffset };
      }
      if (ticket !== sequence || signal.aborted) return;
      page = value; roots = value.roots; appliedSearch = search; appliedScope = scope; publishedRoot = root; publishedDirectory = directory; published = true;
      cadence.observe([scope, page.revision, page.thumbnailEpoch, page.entries.length, page.roots.map(r => [r.id, r.state, r.error])],
        page.scanning || page.entries.some(entry => entry.state === 'pending'));
    } catch (error) {
      if (ticket !== sequence || signal.aborted) return;
      if (error instanceof LibraryChangedError && !restarted) { await load(false, resetView, true); return; }
    } finally {
      if (ticket === sequence && !signal.aborted) {
        loading = false; render();
        if (published && resetView) onScope?.(!publishedRoot);
        if (resetView) list.scrollTop = 0;
        requestAnimationFrame(more);
      }
    }
  }
  function more() {
    if (root && appliedScope === JSON.stringify([root,directory,search]) && !loading && !pendingSearch && page?.nextOffset != null && list.clientHeight > 0
      && (elements.nearEnd?.() ?? list.scrollHeight - list.scrollTop - list.clientHeight < 180)) void load(true);
  }
  function reset() { void load(false, true); }
  function navigate(id: string, path: string) {
    rememberNavigation({root:id,directory:path,search:''});
    root = id; directory = path; search = ''; address.value = ''; reset();
  }
  function searchFor(value: string) {
    value = value.trim();
    if (value === search) { controls(); return; }
    search = value; history[historyIndex] = currentLocation(); clearTimeout(searchTimer); request?.abort(); sequence++; loading = false;
    if (!root) { appliedSearch = search; pendingSearch = false; render(); return; }
    pendingSearch = true; controls(); searchTimer = setTimeout(reset, 200);
  }
  list.addEventListener('scroll', more, { signal, passive: true });
  const resize = new ResizeObserver(more); resize.observe(list);
  const timer = setInterval(() => {
    const visible = !document.hidden && !signal.aborted && (elements.visible() || observeRecent());
    if (cadence.ready(visible) && !loading && !pendingSearch) void load();
  }, 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) cadence.reset(); }, { signal });
  const stopLanguage = onLanguageChange(() => {
    if (signal.aborted) return;
    syncDensity();
    for (const [button,label] of [[back,t(msg('libraryBrowser.goBack', '后退'))],[forward,t(msg('libraryBrowser.goForward', '前进'))]] as const) {
      button.setAttribute('aria-label', label); button.dataset.tooltip = label;
    }
    localizeManage();
    controls();
  }, signal);
  signal.addEventListener('abort', () => {
    stopLanguage(); clearInterval(timer); clearTimeout(searchTimer); request?.abort(); resize.disconnect();
    pathResize.disconnect(); pathbar.remove();
  }, { once: true });
  controls();
  return {
    snapshot: () => ({ root, directory, search, all: false }),
    async restore(state: { root: string; directory: string; search: string; all: boolean; recent?: boolean; query?: string }) {
      clearTimeout(searchTimer); request?.abort(); sequence++;
      root = state.all || state.recent ? '' : state.root;
      directory = root ? state.directory : '';
      search = state.recent ? state.query ?? state.search : state.search;
      appliedScope = ''; pendingSearch = false;
      history = [currentLocation()]; historyIndex = 0;
      address.value = search; await load(false, true);
    },
    async reveal(entry: LibraryEntry) {
      const targetRoot = entry.rootId ?? '';
      const targetDir = entry.name.includes('/') ? entry.name.slice(0, entry.name.lastIndexOf('/')) : '';
      // Fast path: already visible — highlight only, no list rebuild (avoids full flicker).
      if (!!root && search === '' && appliedSearch === '' && page?.entries.some(item => item.id === entry.id)) return true;
      const sameScope = root === targetRoot && directory === targetDir && search === '' && appliedSearch === '' && !!page;
      clearTimeout(searchTimer); request?.abort(); sequence++;
      rememberNavigation({root:targetRoot,directory:targetDir,search:''});
      root = targetRoot; directory = targetDir;
      search = ''; address.value = ''; pendingSearch = false;
      // Keep the current page visible until the new one publishes: no
      // page=null + render() empty flash. load() updates controls and swaps atomically.
      let append = sameScope;
      do {
        const previousOffset = (page as LibraryPage | null)?.nextOffset;
        const pending = load(append, !append), ticket = sequence;
        await pending;
        // A newer navigation wins over this locate request.
        if (signal.aborted || sequence !== ticket) return false;
        const current = page as LibraryPage | null; // load publishes asynchronously.
        if (current?.entries.some(item => item.id === entry.id)) return true;
        if (append && current?.nextOffset === previousOffset) return false;
        append = true;
      } while ((page as LibraryPage | null)?.nextOffset != null);
      return false;
    },
    appliedLocation: () => ({root:publishedRoot,directory:publishedDirectory,search:appliedSearch}),
    more, navigate, page: () => page, filter: () => appliedSearch, isRoot: () => !publishedRoot,
    load: () => load(),
    clearSearch() { address.value = ''; searchFor(''); },
  };
}
