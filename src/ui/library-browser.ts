import { fetchLibraryPage, LibraryChangedError } from '../library.ts';
import type { LibraryPage } from '../library.ts';
import { installChoiceMenu } from './choice-menu.ts';
import { createIconButton } from './controls.ts';
import { icon } from './icons.ts';
import { libraryLocationExpression, parseLibraryLocationInput, parseLibraryLocationLink } from './library-link.ts';

/** Continuous browsing with bounded requests and atomic result replacement. */
export function installLibraryBrowser(change: (page: LibraryPage | null) => void, signal: AbortSignal, onScope?: (recent: boolean) => void, notify: (message: string) => void = () => {}) {
  let initial = { root: '', directory: '', all: false };
  if (new URL(location.href).searchParams.has('library')) {
    try { initial = parseLibraryLocationLink(location.href, location.href); } catch { /* Ignore malformed startup links. */ }
  }
  let page: LibraryPage | null = null, root = initial.root, directory = initial.directory, search = '', appliedSearch = '', all = initial.all, recent = false;
  let request: AbortController | undefined, sequence = 0, loading = false, pendingSearch = false;
  const available = () => !recent;
  let optionsSignature = '', appliedScope = '', searchTimer: ReturnType<typeof setTimeout> | undefined;
  const list = document.getElementById('source-list')!;
  const tools = document.getElementById('source-tools')!;
  // Address-style location field with a separate scope dropdown.
  const nav = document.createElement('div'); nav.className = 'library-navigation'; nav.id = 'library-navigation';
  const address = document.createElement('input'); address.id = 'library-location'; address.className = 'library-location'; address.type = 'text'; address.setAttribute('aria-label', '媒体库路径或链接'); address.autocomplete = 'off'; address.spellcheck = false;
  const button = document.createElement('button'); button.type = 'button'; button.id = 'library-root'; button.className = 'choice-trigger'; button.setAttribute('aria-label', '媒体库范围');
  nav.append(address, button);
  const back = createIconButton({ glyph: 'caretLeft', label: '返回上一级', className: 'crumbs-back' });
  const toggle = createIconButton({ glyph: 'search', label: '搜索片源', className: 'crumbs-search-toggle', attributes: { id: 'sources-search-toggle', 'aria-expanded': 'false' } });
  const field = document.createElement('label'); field.className = 'search-field crumbs-search-field'; field.id = 'source-search-field'; field.hidden = true;
  const searchIcon = document.createElement('span'); searchIcon.className = 'crumbs-search-icon'; searchIcon.innerHTML = icon('search');
  const input = document.createElement('input'); input.id = 'source-search'; input.type = 'search'; input.placeholder = '搜索片源'; input.setAttribute('aria-label', '搜索片源');
  const close = createIconButton({ glyph: 'close', label: '关闭搜索', className: 'crumbs-search-close', attributes: { id: 'source-search-close' } });
  close.dataset.tooltip = '关闭搜索并清空';
  field.append(searchIcon, input, close);
  tools.replaceChildren(back, nav, toggle, field);
  const key = (id: string, path = '') => JSON.stringify([id, path]);
  address.addEventListener('focus', () => { address.value = recent ? '' : libraryLocationExpression({ root, directory, all }); address.select(); });
  address.addEventListener('blur', () => { address.removeAttribute('aria-invalid'); address.value = displayPath(); });
  address.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); address.blur(); return; }
    if (event.key !== 'Enter') return;
    event.preventDefault();
    try {
      const target = parseLibraryLocationInput(address.value, location.href);
      if (target.root && !page?.roots.some(item => item.id === target.root)) throw new Error('此媒体库在当前服务中不存在。');
      search = ''; input.value = ''; all = target.all; root = target.root; directory = target.directory;
      setRecent(false); reset(); address.blur();
    } catch (error) { address.setAttribute('aria-invalid', 'true'); notify((error as Error).message); address.select(); }
  }, { signal });
  const menu = installChoiceMenu(button.id, [], value => {
    if (value === 'recent') { setRecent(true); return; }
    if (value === 'all') { all = true; root = directory = ''; setRecent(false); reset(); }
    else { const [id, path] = JSON.parse(value); navigate(id, path ?? ''); }
  }, undefined, undefined, () => nav.getBoundingClientRect());
  function setRecent(value: boolean) {
    if (recent === value) { onScope?.(recent); return; }
    recent = value;
    clearTimeout(searchTimer); request?.abort(); sequence++; loading = false; pendingSearch = false;
    controls();
    if (!recent) requestAnimationFrame(more);
    onScope?.(recent);
  }
  // Back, location and search share the single tools row above.
  function displayPath() {
    const roots = page?.roots ?? [];
    const rootName = roots.find(r => r.id === root)?.name ?? '';
    if (recent) return '最近使用';
    if (all) return '全部媒体';
    if (!root) return '所有媒体库';
    return directory ? `${rootName} / ${directory}` : rootName;
  }
  back.onclick = () => {
    if (!available() || recent) return;
    if (directory) navigate(root, directory.includes('/') ? directory.slice(0, directory.lastIndexOf('/')) : '');
    else if (root && !all) { root = ''; directory = ''; reset(); }
  };
  function renderRow() {
    const canGoBack = available() && !recent && !all && (!!directory || !!root);
    back.disabled = !canGoBack;
    back.hidden = !available();
  }
  function controls() {
    const roots = page?.roots ?? [];
    // The dropdown selects the scope: 最近使用 lives here instead of a
    // separate tab. Directory navigation lives in the breadcrumb bar and
    // the folder rows.
    const options = [{ value: 'recent', label: '最近使用' }, { value: 'all', label: '全部媒体' }, { value: key(''), label: '所有媒体库' },
      ...roots.map(item => ({ value: key(item.id), label: `${item.name}${item.state === 'offline' ? ' · 离线' : ''}` }))];
    const signature = JSON.stringify(options);
    if (signature !== optionsSignature) { optionsSignature = signature; menu.setOptions(options); }
    const value = recent ? 'recent' : all ? 'all' : key(root);
    menu.sync(value, displayPath(), true);
    if (document.activeElement !== address) address.value = displayPath();
    renderRow();
    input.placeholder = recent ? '搜索最近打开' : `搜索${all ? '全部媒体' : directory || roots.find(r => r.id === root)?.name || '媒体库'}`;
    input.title = input.placeholder;
    list.setAttribute('aria-busy', String(available() && (loading || pendingSearch)));
  }
  function render() {
    controls();
    // 扫描进度与读取错误只在管理后台展示，前端列表不再保留状态行，
    // 避免长文本把片源列表顶下去。
    change(page);
  }
  async function load(append = false, resetView = false, restarted = false): Promise<void> {
    clearTimeout(searchTimer); pendingSearch = false;
    if (recent) { loading = false; render(); return; }
    const scope = JSON.stringify([root, directory, search, all]);
    resetView ||= scope !== appliedScope;
    const ticket = ++sequence; request?.abort(); request = new AbortController(); loading = true; controls();
    const previous = page, targetCount = resetView ? 60 : Math.max(60, previous?.entries.length ?? 0, previous?.directories.length ?? 0);
    const abort = AbortSignal.any([signal, request.signal, AbortSignal.timeout(10000)]);
    try {
      const query = { root: all ? undefined : root, directory: all ? '' : directory, search, recursive: all, limit: 60 };
      let value = await fetchLibraryPage({ ...query, offset: append ? previous?.nextOffset ?? 0 : 0, revision: resetView || restarted ? undefined : previous?.revision }, abort);
      if (append && previous) value = { ...value, entries: [...previous.entries, ...value.entries], directories: [...previous.directories, ...value.directories] };
      else if (!resetView && previous?.revision === value.revision) value = { ...value, entries: previous.entries, directories: previous.directories, nextOffset: previous.nextOffset };
      else while (Math.max(value.entries.length, value.directories.length) < targetCount && value.nextOffset !== null) {
        const more = await fetchLibraryPage({ ...query, offset: value.nextOffset, revision: value.revision }, abort);
        value = { ...value, entries: [...value.entries, ...more.entries], directories: [...value.directories, ...more.directories], nextOffset: more.nextOffset };
      }
      if (ticket !== sequence || signal.aborted) return;
      page = value; appliedSearch = search; appliedScope = scope;
    } catch (error) {
      if (ticket !== sequence || signal.aborted) return;
      if (error instanceof LibraryChangedError && !restarted) { await load(false, resetView, true); return; }
    } finally {
      if (ticket === sequence && !signal.aborted) {
        loading = false; render();
        if (resetView) list.scrollTop = 0;
        requestAnimationFrame(more);
      }
    }
  }
  function more() {
    if (available() && !loading && !pendingSearch && page?.nextOffset != null && list.clientHeight > 0 && list.scrollHeight - list.scrollTop - list.clientHeight < 180) void load(true);
  }
  function reset() { void load(false, true); }
  function navigate(id: string, path: string) { all = false; root = id; directory = path; setRecent(false); reset(); }
  list.addEventListener('scroll', more, { signal, passive: true });
  const resize = new ResizeObserver(more); resize.observe(list);
  const timer = setInterval(() => {
    if (!document.hidden && !loading && !pendingSearch && !signal.aborted && !button.matches('[aria-expanded=true]') && (!document.getElementById('sources-panel')!.hidden || !document.getElementById('empty-A')!.hidden)) void load();
  }, 3000);
  signal.addEventListener('abort', () => { clearInterval(timer); clearTimeout(searchTimer); request?.abort(); resize.disconnect(); menu.dispose(); }, { once: true });
  return {
    snapshot: () => ({ root, directory, search, all }),
    async restore(state: { root: string; directory: string; search: string; all: boolean; recent?: boolean }) {
      clearTimeout(searchTimer); request?.abort(); sequence++;
      ({ root, directory, search, all } = state);
      recent = state.recent ?? false;
      page = null; appliedScope = ''; appliedSearch = search; pendingSearch = false;
      render();
      await load(false, true);
    },
    navigate, page: () => page, filter: () => appliedSearch,
    load: () => load(),
    isRecent: () => recent,
    selectRecent() { setRecent(true); },
    search(value: string) {
      value = value.trim(); if (value === search) return;
      search = value; clearTimeout(searchTimer); request?.abort(); sequence++; loading = false; pendingSearch = true; controls();
      searchTimer = setTimeout(reset, 200);
    },
  };
}
