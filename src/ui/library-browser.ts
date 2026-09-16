import { fetchLibraryPage, LibraryChangedError, requestLibraryScan } from '../library.ts';
import type { LibraryPage } from '../library.ts';
import { installChoiceMenu } from './choice-menu.ts';
import { createIconButton } from './controls.ts';
import { icon } from './icons.ts';

/** Continuous browsing with bounded requests and atomic result replacement. */
export function installLibraryBrowser(change: (page: LibraryPage | null, status: string) => void, signal: AbortSignal, onScope?: (recent: boolean) => void) {
  let page: LibraryPage | null = null, root = '', directory = '', search = '', appliedSearch = '', all = false, recent = false;
  let request: AbortController | undefined, sequence = 0, loading = false, pendingSearch = false;
  const available = () => !recent;
  let note = '', optionsSignature = '', appliedScope = '', searchTimer: ReturnType<typeof setTimeout> | undefined;
  const list = document.getElementById('source-list')!;
  const tools = document.getElementById('source-tools')!;
  // Single row: back | scope dropdown (shows the full path) | copy | search.
  const nav = document.createElement('div'); nav.className = 'library-navigation'; nav.id = 'library-navigation';
  const button = document.createElement('button'); button.type = 'button'; button.id = 'library-root'; button.className = 'choice-trigger'; button.setAttribute('aria-label', '媒体库范围');
  nav.append(button);
  const back = createIconButton({ glyph: 'caretLeft', label: '返回上一级', className: 'crumbs-back' });
  const copy = createIconButton({ glyph: 'copy', label: '复制当前路径', className: 'crumbs-copy' });
  const toggle = createIconButton({ glyph: 'search', label: '搜索片源', className: 'crumbs-search-toggle', attributes: { id: 'sources-search-toggle', 'aria-expanded': 'false' } });
  const field = document.createElement('label'); field.className = 'search-field crumbs-search-field'; field.id = 'source-search-field'; field.hidden = true;
  const searchIcon = document.createElement('span'); searchIcon.className = 'crumbs-search-icon'; searchIcon.innerHTML = icon('search');
  const input = document.createElement('input'); input.id = 'source-search'; input.type = 'search'; input.placeholder = '搜索片源'; input.setAttribute('aria-label', '搜索片源');
  const close = createIconButton({ glyph: 'close', label: '关闭搜索', className: 'crumbs-search-close', attributes: { id: 'source-search-close' } });
  close.dataset.tooltip = '关闭搜索并清空';
  field.append(searchIcon, input, close);
  tools.replaceChildren(back, nav, copy, toggle, field);
  const key = (id: string, path = '') => JSON.stringify([id, path]);
  const menu = installChoiceMenu(button.id, [], value => {
    if (value === 'recent') { setRecent(true); return; }
    if (value === 'all') { all = true; root = directory = ''; setRecent(false); reset(); }
    else { const [id, path] = JSON.parse(value); navigate(id, path ?? ''); }
  });
  function setRecent(value: boolean) {
    if (recent === value) { onScope?.(recent); return; }
    recent = value;
    clearTimeout(searchTimer); request?.abort(); sequence++; loading = false; pendingSearch = false; note = '';
    controls();
    if (!recent) requestAnimationFrame(more);
    onScope?.(recent);
  }
  // (removed: old second-row crumbs bar; back/copy/search now share the single tools row above)
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
  copy.onclick = () => {
    const value = displayPath();
    void (async () => {
      try { await navigator.clipboard.writeText(value); } catch { /* Clipboard may be unavailable; keep the path visible. */ }
      copy.dataset.tooltip = `已复制：${value}`;
      window.setTimeout(() => { if (copy.isConnected) copy.dataset.tooltip = `复制当前路径：${value}`; }, 1600);
    })();
  };
  function renderRow() {
    const value = displayPath();
    copy.dataset.tooltip = `复制当前路径：${value}`;
    const canGoBack = available() && !recent && !all && (!!directory || !!root);
    back.disabled = !canGoBack;
    copy.disabled = !available();
    back.hidden = !available();
    copy.hidden = !available();
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
    renderRow();
    input.placeholder = recent ? '搜索最近打开' : `搜索${all ? '全部媒体' : directory || roots.find(r => r.id === root)?.name || '媒体库'}`;
    input.title = input.placeholder;
    list.setAttribute('aria-busy', String(available() && (loading || pendingSearch)));
  }
  function render() {
    controls();
    const job = page?.job;
    const status = note || (page?.scanning ? `扫描中 · ${job?.files ?? 0} 个视频` : job?.errors ? `${job.errors} 处路径无法读取` : page?.roots.some(r => r.state === 'offline') ? '部分存储离线，显示上次索引' : '');
    change(page, status);
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
      page = value; appliedSearch = search; appliedScope = scope; note = '';
    } catch (error) {
      if (ticket !== sequence || signal.aborted) return;
      if (error instanceof LibraryChangedError && !restarted) { await load(false, resetView, true); return; }
      note = error instanceof Error ? error.message : '媒体库读取失败';
    } finally {
      if (ticket === sequence && !signal.aborted) {
        loading = false; render();
        if (resetView) list.scrollTop = 0;
        if (!note) requestAnimationFrame(more);
      }
    }
  }
  function more() {
    if (available() && !loading && !pendingSearch && page?.nextOffset != null && list.clientHeight > 0 && list.scrollHeight - list.scrollTop - list.clientHeight < 180) void load(true);
  }
  function reset() { note = ''; void load(false, true); }
  function navigate(id: string, path: string) { all = false; root = id; directory = path; setRecent(false); reset(); }
  async function refresh() {
    try { await requestLibraryScan('refresh'); note = ''; } catch (error) { note = (error as Error).message; }
    await load(false, pendingSearch);
  }
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
      page = null; appliedScope = ''; appliedSearch = search; pendingSearch = false; note = '';
      render();
      await load(false, true);
    },
    navigate, page: () => page, refresh, filter: () => appliedSearch,
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
