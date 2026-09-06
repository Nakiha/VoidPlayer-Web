import { fetchLibraryPage, LibraryChangedError, requestLibraryScan } from '../library.ts';
import type { LibraryPage } from '../library.ts';
import { createIconButton } from './controls.ts';

/** Shared source browser state; decoded media still loads through ReviewSession. */
export function installLibraryBrowser(change: (page: LibraryPage | null, status: string) => void, signal: AbortSignal) {
  let page: LibraryPage | null = null, root = '', directory = '', search = '', all = false;
  let offset = 0, revision: number | undefined, request: AbortController | undefined, sequence = 0;
  let loading = false, note = '', rootsSignature = '', breadcrumbSignature = '', searchTimer: ReturnType<typeof setTimeout>;
  const nav = document.createElement('div'); nav.className = 'library-navigation'; nav.id = 'library-navigation';
  const select = document.createElement('select'); select.setAttribute('aria-label', '媒体根目录'); select.id = 'library-root';
  const breadcrumbs = document.createElement('nav'); breadcrumbs.className = 'library-breadcrumbs'; breadcrumbs.setAttribute('aria-label', '媒体目录');
  nav.append(select, breadcrumbs);
  const scope = document.createElement('div'); scope.className = 'library-scope segmented'; scope.setAttribute('role', 'group'); scope.setAttribute('aria-label', '搜索范围');
  const choices = ['当前目录', '全部媒体'];
  choices.forEach((label, i) => {
    const button = document.createElement('button'); button.textContent = label; button.dataset.libraryScope = i ? 'all' : 'directory'; button.setAttribute('aria-pressed', String(!i));
    button.onclick = () => { all = !!i; for (const b of scope.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b === button)); reset(); };
    scope.append(button);
  });
  const field = document.querySelector('#sources-panel .search-field')!;
  field.before(nav); field.after(scope);
  const footer = document.createElement('div'); footer.className = 'library-pagination'; footer.id = 'library-pagination';
  const previous = createIconButton({ glyph: 'previous', label: '上一页片源' });
  const next = createIconButton({ glyph: 'next', label: '下一页片源' });
  const count = document.createElement('span'); count.setAttribute('role', 'status');
  const cancel = document.createElement('button'); cancel.textContent = '停止扫描'; cancel.className = 'library-cancel';
  cancel.onclick = () => void refresh('cancel');
  footer.append(previous, count, next, cancel); document.getElementById('source-list')!.after(footer);
  select.onchange = () => navigate(select.value, '');
  previous.onclick = () => { offset = Math.max(0, offset - 60); void load(); };
  next.onclick = () => { if (page?.nextOffset !== null && page?.nextOffset !== undefined) { offset = page.nextOffset; void load(); } };
  function render() {
    if (page) {
      const signature = JSON.stringify(page.roots);
      if (signature !== rootsSignature) {
        rootsSignature = signature; select.replaceChildren(new Option('所有媒体库', ''));
        for (const item of page.roots) select.append(new Option(`${item.name}${item.state === 'offline' ? ' · 离线' : ''}`, item.id));

      }
    }
    select.value = root;
    const signature = `${root}/${directory}`;
    if (signature !== breadcrumbSignature) {
      breadcrumbSignature = signature; breadcrumbs.replaceChildren();
      const crumb = (label: string, value: string) => {
        const button = document.createElement('button'); button.textContent = label; button.title = label; button.onclick = () => navigate(root, value);
        button.setAttribute('aria-current', value === directory ? 'location' : 'false'); breadcrumbs.append(button);
      };
      crumb('根目录', '');
      let path = ''; for (const part of directory.split('/').filter(Boolean)) { const slash = document.createElement('span'); slash.textContent = '/'; breadcrumbs.append(slash); path += (path ? '/' : '') + part; crumb(part, path); }
      breadcrumbs.scrollLeft = breadcrumbs.scrollWidth;
    }
    previous.disabled = loading || offset === 0; next.disabled = loading || !page || page.nextOffset === null;
    count.textContent = page ? `第 ${Math.floor(offset / 60) + 1} 页 · ${page.total} 个视频` : loading ? '载入中…' : '暂无结果';
    cancel.hidden = !page?.scanning; cancel.disabled = loading;
    const job = page?.job;
    const status = note || (page?.scanning ? `扫描中 · ${job?.visited ?? 0} 个目录 · ${job?.files ?? 0} 个视频` : job?.errors ? `${job.errors} 处路径无法读取，保留上次索引` : page?.roots.some(r => r.state === 'offline') ? '部分存储离线，正在显示上次索引' : job?.state === 'cancelled' ? '扫描已停止，刷新可继续校准' : '');
    change(page, status);
  }
  async function load(restarted = false) {
    const ticket = ++sequence; request?.abort(); request = new AbortController(); loading = true; render();
    try {
      const value = await fetchLibraryPage({ root: all && search ? undefined : root, directory: all && search ? '' : directory, search, recursive: !!search && all, offset, limit: 60, revision }, AbortSignal.any([signal, request.signal, AbortSignal.timeout(5000)]));
      if (ticket !== sequence || signal.aborted) return;
      page = value; revision = value.revision;
      if (note !== '媒体库已更新，已返回第一页') note = '';
    } catch (error) {
      if (ticket !== sequence || signal.aborted) return;
      if (error instanceof LibraryChangedError && !restarted) { offset = 0; revision = undefined; note = error.message; await load(true); return; }
      note = error instanceof Error ? error.message : '媒体库读取失败';
    } finally { if (ticket === sequence && !signal.aborted) { loading = false; render(); } }
  }
  function reset() { offset = 0; revision = undefined; page = null; note = ''; void load(); }
  function navigate(id: string, path: string) { root = id; directory = path; reset(); }
  async function refresh(action: 'refresh' | 'cancel' = 'refresh') {
    try { await requestLibraryScan(action); note = ''; } catch (error) { note = (error as Error).message; }
    await load();
  }
  const timer = setInterval(() => { if (!document.hidden && !loading && !signal.aborted && document.activeElement !== select && (!document.getElementById('sources-panel')!.hidden || !document.getElementById('empty-A')!.hidden)) void load(); }, 3000);
  signal.addEventListener('abort', () => { clearInterval(timer); clearTimeout(searchTimer); request?.abort(); }, { once: true });
  return {
    navigate, page: () => page, refresh,
    load: () => load(),
    search(value: string) { search = value.trim(); clearTimeout(searchTimer); searchTimer = setTimeout(reset, 200); },
    visible(visible: boolean) { nav.hidden = scope.hidden = footer.hidden = !visible; },
  };
}
