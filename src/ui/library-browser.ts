import { fetchLibraryPage, LibraryChangedError, requestLibraryScan } from '../library.ts';
import type { LibraryPage } from '../library.ts';
import { installChoiceMenu } from './choice-menu.ts';

/** Continuous browsing with bounded requests and atomic result replacement. */
export function installLibraryBrowser(change: (page: LibraryPage | null, status: string) => void, signal: AbortSignal) {
  let page: LibraryPage | null = null, root = '', directory = '', search = '', appliedSearch = '', all = false;
  let request: AbortController | undefined, sequence = 0, loading = false, pendingSearch = false, available = true;
  let note = '', optionsSignature = '', appliedScope = '', searchTimer: ReturnType<typeof setTimeout> | undefined;
  const list = document.getElementById('source-list')!;
  const field = document.querySelector('#sources-panel .search-field')!;
  const input = document.getElementById('source-search') as HTMLInputElement;
  const nav = document.createElement('div'); nav.className = 'library-navigation'; nav.id = 'library-navigation';
  const button = document.createElement('button'); button.type = 'button'; button.id = 'library-root'; button.className = 'choice-trigger'; button.setAttribute('aria-label', '媒体库范围');
  nav.append(button); field.before(nav);
  const key = (id: string, path = '') => JSON.stringify([id, path]);
  const menu = installChoiceMenu(button.id, [], value => {
    if (value === 'all') { all = true; root = directory = ''; reset(); }
    else { const [id, path] = JSON.parse(value); navigate(id, path); }
  });
  function controls() {
    const roots = page?.roots ?? [];
    const options = [{ value: 'all', label: '全部媒体' }, { value: key(''), label: '所有媒体库' },
      ...roots.map(item => ({ value: key(item.id), label: `${item.name}${item.state === 'offline' ? ' · 离线' : ''}` }))];
    let path = '';
    for (const part of directory.split('/').filter(Boolean)) {
      path += (path ? '/' : '') + part;
      options.push({ value: key(root, path), label: `${roots.find(r => r.id === root)?.name ?? ''} / ${path}` });
    }
    const signature = JSON.stringify(options);
    if (signature !== optionsSignature) { optionsSignature = signature; menu.setOptions(options); }
    const value = all ? 'all' : key(root, directory);
    const label = options.find(o => o.value === value)?.label ?? '所有媒体库';
    menu.sync(value, available ? label : '最近打开', available);
    input.placeholder = available ? `搜索${all ? '全部媒体' : directory || roots.find(r => r.id === root)?.name || '媒体库'}` : '搜索最近打开';
    input.title = input.placeholder;
    list.setAttribute('aria-busy', String(available && (loading || pendingSearch)));
  }
  function render() {
    controls();
    const job = page?.job;
    const status = note || (page?.scanning ? `扫描中 · ${job?.files ?? 0} 个视频` : job?.errors ? `${job.errors} 处路径无法读取` : page?.roots.some(r => r.state === 'offline') ? '部分存储离线，显示上次索引' : '');
    change(page, status);
  }
  async function load(append = false, resetView = false, restarted = false): Promise<void> {
    clearTimeout(searchTimer); pendingSearch = false;
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
    if (available && !loading && !pendingSearch && page?.nextOffset != null && list.clientHeight > 0 && list.scrollHeight - list.scrollTop - list.clientHeight < 180) void load(true);
  }
  function reset() { note = ''; void load(false, true); }
  function navigate(id: string, path: string) { all = false; root = id; directory = path; reset(); }
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
    async restore(state: { root: string; directory: string; search: string; all: boolean }) {
      clearTimeout(searchTimer); request?.abort(); sequence++;
      ({ root, directory, search, all } = state);
      page = null; appliedScope = ''; appliedSearch = search; pendingSearch = false; note = '';
      render();
      await load(false, true);
    },
    navigate, page: () => page, refresh, filter: () => appliedSearch,
    load: () => load(),
    search(value: string) {
      value = value.trim(); if (value === search) return;
      search = value; clearTimeout(searchTimer); request?.abort(); sequence++; loading = false; pendingSearch = true; controls();
      searchTimer = setTimeout(reset, 200);
    },
    visible(value: boolean) { available = value; controls(); if (value) requestAnimationFrame(more); },
  };
}
