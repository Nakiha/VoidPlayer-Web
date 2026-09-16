import { loadStages } from '../../media-progress.ts';
import type { MediaLoadStage } from '../../media-progress.ts';
import { SLOTS } from '../../model.ts';
import type { Slot } from '../../model.ts';
import { createIconButton } from '../controls.ts';
import { icon } from '../icons.ts';
import { fetchLibraryItem, openLibraryItem } from '../../library.ts';
import type { LibraryEntry } from '../../library.ts';
import { referenceVersion } from '../../media-reference.ts';
import { openMedia } from '../../media.ts';
import { installLibraryBrowser } from '../library-browser.ts';
import { installSourceScrollbar } from '../source-scrollbar.ts';
import { sourceInUse } from '../source-catalog.ts';
import type { SourceItem } from '../source-catalog.ts';
import type { WorkbenchShared, WorkbenchState } from './shared.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const sizeText = (n: number) => n >= 2 ** 30 ? `${(n / 2 ** 30).toFixed(1)} GB` : `${(n / 2 ** 20).toFixed(1)} MB`;
const text = (tag: string, value: string, className = '') => {
  const el = document.createElement(tag); el.textContent = value; el.className = className; return el;
};

/** Source catalog + library browser + load transactions. Owns source signatures. */
export function createSourcesPane(shared: WorkbenchShared) {
  const { session, act, view, catalog, lifecyle } = shared;
  const save = () => shared.save();
  let libraryStatus = '';
  let refreshing: Promise<void> | undefined;
  let libraryChecked = false;
  let disposed = false;
  let sourceSignature = '';
  let currentIds = '';
  let sourceBusy = false;
  let loadingSource: { key: string; status: string } | null = null;
  let loadingConfirmed = false;
  let confirmTimer: ReturnType<typeof setTimeout> | undefined;
  let sourceLoadError: { key: string; message: string } | null = null;
  let recentRevision = -1;
  let recentRequest = 0;

  const libraryBrowser = installLibraryBrowser((page, status) => {
    catalog.setLibrary(page?.entries ?? []); libraryStatus = status;
    if (page && recentRevision !== page.revision) { recentRevision = page.revision; void refreshRecent(); }
    renderSources();
  }, lifecyle.signal, recent => {
    if (recent) void refreshRecent();
    renderSources();
  });

  async function refreshRecent() {
    const ticket = ++recentRequest;
    const ids = [...new Set(catalog.serializable().flatMap(item => item.libraryId ? [item.libraryId] : []))];
    const entries = await Promise.all(ids.map(async id => {
      try { const entry = await fetchLibraryItem(id, AbortSignal.any([lifecyle.signal, AbortSignal.timeout(5000)])); return entry ? [id, entry] as [string, LibraryEntry] : null; } catch { return null; }
    }));
    if (disposed || ticket !== recentRequest) return;
    catalog.setRecentLibrary(entries.filter((item): item is [string, LibraryEntry] => item !== null)); save(); renderSources();
  }

  async function load(item: SourceItem, slot: Slot) {
    if (loadingSource?.key === item.key || (session.getState().busy && session.getState().mediaLoad?.state !== 'loading') || (!item.file && !item.library) || sourceInUse(item, session.getState().tracks)) return;
    const pendingLoad = { key: item.key, status: '正在载入' };
    loadingSource = pendingLoad; loadingConfirmed = false; sourceLoadError = null;
    clearTimeout(confirmTimer);
    // Loading visuals only appear once the load proves it is not instant;
    // fast loads never touch the list DOM.
    confirmTimer = setTimeout(() => { if (loadingSource === pendingLoad) { loadingConfirmed = true; renderSources(); } }, 250);
    renderSources();
    const progress = (stage: MediaLoadStage) => {
      if (loadingSource !== pendingLoad) return;
      pendingLoad.status = loadStages[stage];
      renderSources();
    };
    try {
      await act(async () => {
        try {
          await session.load(slot, async (signal, report) => {
            const onProgress = (stage: MediaLoadStage) => { progress(stage); report(stage); };
            const source = await (item.file ? openMedia(item.file, undefined, onProgress, signal) : openLibraryItem(item.library!, onProgress, signal));
            if (loadingSource === pendingLoad) { pendingLoad.status = '正在显示首帧'; renderSources(); }
            return source;
          }, item.name);
          catalog.remember(item, item.library?.id, item.library?.version); save();
        } catch (error) {
          if (error instanceof Error && error.name === 'AbortError') return;
          if (loadingSource === pendingLoad) sourceLoadError = { key: item.key, message: error instanceof Error ? error.message : String(error) };
          throw error;
        }
      }, 'ui.source-load', { name: item.name, slot });
    } finally { clearTimeout(confirmTimer); if (loadingSource === pendingLoad) { loadingSource = null; loadingConfirmed = false; } renderSources(); }
  }

  function sourceDisplayName(name: string) {
    const base = name.split('/').pop() ?? name;
    return { base, dir: name.includes('/') ? name.slice(0, name.lastIndexOf('/')) : '' };
  }

  function sourceRow(item: SourceItem) {
    const row = document.createElement('div'); row.className = 'source-row';
    const used = sourceInUse(item, session.getState().tracks);
    const loading = loadingSource?.key === item.key && loadingConfirmed ? loadingSource.status : null;
    const failed = sourceLoadError?.key === item.key ? sourceLoadError.message : null;
    const blocked = !!loadingSource || session.getState().busy;
    row.setAttribute('aria-busy', String(!!loading));
    row.classList.toggle('in-use', used);
    const info = document.createElement('div'); info.className = 'source-info';
    const { base, dir } = sourceDisplayName(item.name);
    const name = text('span', base, 'filename');
    const origin = item.library ? [item.library.root, dir].filter(Boolean).join(' / ') : '本机（不上传）';
    // Full path lives in the tooltip; the visible name stays a basename.
    row.dataset.tooltip = item.library ? `${item.name}（${item.library.root}）` : `${item.name}（本地文件，仅本机预览）`;
    const isLocal = !!item.file && !item.library;
    const pending = item.library?.state === 'pending';
    const offline = libraryBrowser.page()?.roots.some(root => root.id === item.library?.rootId && root.state === 'offline');
    const stateLabel = loading ?? (failed ? `载入失败：${failed}` : used ? '使用中' : offline ? '存储离线' : pending ? '写入中' : isLocal ? '本地文件' : '媒体库');
    const status = text('span', `${sizeText(item.size)} · ${stateLabel} · ${origin}`, 'source-meta');
    status.dataset.tooltip = row.dataset.tooltip;
    if (loading || failed) { status.setAttribute('role', 'status'); }
    const titleLine = document.createElement('span'); titleLine.className = 'source-title';
    titleLine.append(name);
    name.dataset.tooltip = row.dataset.tooltip;
    info.append(titleLine, status);
    const actions = document.createElement('div'); actions.className = 'source-actions';
    if (used) {
      const button = createIconButton({ glyph: 'close', label: '从视图移除' });
      button.classList.add('remove-track');
      button.disabled = blocked;
      button.setAttribute('aria-label', `从视图移除：${item.name}`);
      button.onclick = () => void act(async () => {
        if (loadingSource || session.getState().busy) return;
        button.disabled = true;
        try {
          const tracks = session.getState().tracks.filter(track => sourceInUse(item, [track]));
          for (const track of tracks) {
            // Do not remove a replacement loaded into this slot while awaiting.
            if (session.getState().tracks.some(current => current.slot === track.slot && current.id === track.id)) await session.removeTrack(track.slot);
          }
        } finally { button.disabled = false; }
      }, 'ui.source-remove', { name: item.name });
      actions.append(button);
    }
    else if (loading) {
      const button = createIconButton({ glyph: 'close', label: '取消载入' });
      button.setAttribute('aria-label', `取消载入：${item.name}`);
      button.onclick = () => { session.cancelLoad(); loadingSource = null; renderSources(); };
      actions.append(button);
    }
    else if (item.library || item.file) {
      const button = createIconButton({ glyph: 'plus', label: '添加到视图' });
      button.disabled = (session.getState().busy && session.getState().mediaLoad?.state !== 'loading') || !!pending || !!offline;
      button.dataset.tooltip = session.getState().mediaLoad?.state === 'loading' ? '取消当前载入并添加到视图' : session.getState().busy ? '请等待当前定位完成' : '添加到视图';
      button.title = offline ? '媒体存储离线，请等待重新连接' : pending ? '片源仍在写入，请稍后重试' : '添加到视图'; button.setAttribute('aria-label', `添加到视图：${item.name}`);
      button.onclick = () => {
        if (session.getState().busy && session.getState().mediaLoad?.state !== 'loading') return;
        const tracks = session.getState().tracks;
        if (sourceInUse(item, tracks)) return;
        const empty = SLOTS.find(slot => !tracks.some(t => t.slot === slot));
        if (empty) { void load(item, empty); return; }
        const dialog = $<HTMLDialogElement>('replace-source-dialog');
        $('replace-source-name').textContent = item.name;
        const targets = $('replace-source-targets'); targets.replaceChildren();
        for (const track of tracks) {
          const choose = document.createElement('button'); choose.textContent = track.name; choose.dataset.tooltip = '替换当前轨道';
          choose.onclick = () => { dialog.close(); void load(item, track.slot); }; targets.append(choose);
        }
        dialog.showModal();
      }; actions.append(button);
    } else if (item.libraryId) {
      const button = createIconButton({ glyph: 'refresh', label: '检查媒体引用' });
      button.title = '内容已改变或不可用，请在媒体库中重新选择'; button.onclick = () => void refreshLibrary(); actions.append(button);
    } else {
      const button = createIconButton({ glyph: 'filePlus', label: '重新选择本地文件' }); button.title = '重新选择本地文件';
      button.setAttribute('aria-label', `重新选择 ${item.name}`); button.onclick = () => $<HTMLInputElement>('source-files').click(); actions.append(button);
    }
    row.append(info, actions); return row;
  }

  function renderStartLibrary() {
    const list = $('start-library-list');
    if (!list) return;
    list.replaceChildren();
    const items = catalog.recent().slice(0, 5);
    for (const item of items) {
      const row = document.createElement('button');
      row.className = 'start-recent-row';
      row.setAttribute('aria-label', `打开：${item.name}`);
      const { base } = sourceDisplayName(item.name);
      const name = text('span', base, 'filename');
      const meta = text('span', `${sizeText(item.size)} · ${item.library ? '媒体库' : '本地文件'}`, 'source-meta');
      const go = document.createElement('span'); go.className = 'start-recent-go'; go.setAttribute('aria-hidden', 'true'); go.textContent = '→';
      const info = document.createElement('span'); info.className = 'source-info'; info.append(name, meta);
      row.append(info, go);
      row.dataset.tooltip = item.name;
      row.onclick = () => {
        if (session.getState().busy || sourceInUse(item, session.getState().tracks)) return;
        const tracks = session.getState().tracks;
        const empty = SLOTS.find(slot => !tracks.some(t => t.slot === slot));
        if (empty) void load(item, empty);
        else shared.setPanel('sources', true);
      };
      list.append(row);
    }
    const status = $('start-library-status');
    if (status) status.textContent = items.length ? '' : (libraryStatus || '暂无最近片源，可从右侧媒体库或本地文件开始');
  }

  function renderSources() {
    const recent = libraryBrowser.isRecent();
    const query = (recent ? $<HTMLInputElement>('source-search').value.trim() : libraryBrowser.filter()).toLocaleLowerCase();
    const scoped = (recent ? catalog.recent() : catalog.available()).filter(item => item.name.toLocaleLowerCase().includes(query));
    // Local files live in their own section pinned above the activity panel.
    const local = scoped.filter(item => item.file && !item.library);
    const items = scoped.filter(item => !(item.file && !item.library));
    $('source-status').textContent = libraryStatus;
    $('source-status').hidden = !libraryStatus;
    const page = libraryBrowser.page();
    const folders = !recent ? page?.directories ?? [] : [];
    const busy = session.getState().busy;
    const loadingKey = loadingSource?.key ?? null;
    const failedKey = sourceLoadError?.key ?? null;
    // The signature tracks which row loads, not the live stage text: stage
    // transitions must not rebuild the list. Per-row fingerprints below stay
    // stable across busy flips (e.g. seeks); disabled states sync in place.
    const signature = JSON.stringify([recent, query, loadingKey, loadingConfirmed, failedKey, sourceLoadError?.message ?? null, busy, folders, page?.roots.map(root => [root.id, root.state]), items.map(item => [item.key, !!item.file, item.library?.version, item.library?.state, sourceInUse(item, session.getState().tracks)]), local.map(item => [item.key, sourceInUse(item, session.getState().tracks)])]);
    const list = $('source-list');
    const fingerprintOf = (item: SourceItem) => JSON.stringify([!!item.file, item.library, loadingKey === item.key && loadingConfirmed ? loadingSource?.status : null, failedKey === item.key ? sourceLoadError?.message : null, sourceInUse(item, session.getState().tracks), page?.roots]);
    const syncActions = (container: HTMLElement, pool: SourceItem[]) => {
      const byKey = new Map(pool.map(entry => [entry.key, entry]));
      const mediaLoading = session.getState().mediaLoad?.state === 'loading';
      for (const row of container.querySelectorAll<HTMLElement>('.source-row')) {
        const item = byKey.get(row.dataset.sourceKey ?? '');
        const button = row.querySelector<HTMLButtonElement>(':scope > .source-actions > button');
        if (!item || !button || button.getAttribute('aria-label')?.startsWith('取消载入')) continue;
        const used = sourceInUse(item, session.getState().tracks);
        const pending = item.library?.state === 'pending';
        const offline = page?.roots.some(root => root.id === item.library?.rootId && root.state === 'offline');
        if (used) button.disabled = !!loadingSource || busy;
        else if (item.library || item.file) button.disabled = (busy && !mediaLoading) || !!pending || !!offline;
      }
    };
    if (signature !== sourceSignature) {
      sourceSignature = signature;
      const existing = new Map([...list.children].map(node => [(node as HTMLElement).dataset.sourceKey, node as HTMLElement]));
      const rows: HTMLElement[] = [];
      const reuse = (key: string, fingerprint: string, create: () => HTMLElement) => {
        const old = existing.get(key);
        const row = old?.dataset.fingerprint === fingerprint ? old : create();
        row.dataset.sourceKey = key; row.dataset.fingerprint = fingerprint; rows.push(row);
      };
      for (const folder of folders) {
        reuse(`folder:${folder.rootId}/${folder.path}`, JSON.stringify(folder), () => {
          const row = document.createElement('button'); row.className = 'source-row library-folder';
          const glyph = document.createElement('span'); glyph.innerHTML = icon('open');
          const info = text('span', '', 'source-info');
          info.append(text('span', folder.name, 'filename'), text('span', `媒体库 · ${page?.roots.find(root => root.id === folder.rootId)?.name ?? ''}`, 'source-meta'));
          row.setAttribute('aria-label', `打开目录：${folder.name}`); row.append(glyph, info); row.onclick = () => libraryBrowser.navigate(folder.rootId, folder.path); return row;
        });
      }
      for (const item of items) reuse(item.key, fingerprintOf(item), () => sourceRow(item));
      if (!items.length && !folders.length) reuse('empty', `${recent ? 'recent' : 'available'}/${query}`, () => text('p', query ? '没有匹配的片源' : recent ? '暂无最近片源' : '当前目录没有片源', 'panel-empty'));
      // Keep unchanged nodes and their focus/scroll anchors through refreshes.
      rows.forEach((row, index) => { if (list.children[index] !== row) list.insertBefore(row, list.children[index] ?? null); });
      while (list.children.length > rows.length) list.lastElementChild!.remove();
      syncActions(list, items);
      const localList = $('local-list');
      $('local-sources-heading').textContent = local.length ? `本地文件（${local.length}）` : '本地文件';
      const localExisting = new Map([...localList.children].map(node => [(node as HTMLElement).dataset.sourceKey, node as HTMLElement]));
      const localRows: HTMLElement[] = [];
      for (const item of local) {
        const old = localExisting.get(item.key);
        const fp = fingerprintOf(item);
        const row = old?.dataset.fingerprint === fp ? old : sourceRow(item);
        row.dataset.sourceKey = item.key; row.dataset.fingerprint = fp; localRows.push(row);
      }
      localRows.forEach((row, index) => { if (localList.children[index] !== row) localList.insertBefore(row, localList.children[index] ?? null); });
      while (localList.children.length > localRows.length) localList.lastElementChild!.remove();
      syncActions(localList, local);
    }
    renderStartLibrary();
    scrollbar.update();
  }

  /** Remember freshly loaded tracks; called from the core render path. */
  function syncCatalog(state: WorkbenchState) {
    const ids = state.tracks.map(t => `${t.slot}:${t.id}:${t.metadataRevision ?? 0}`).join('/');
    if (ids !== currentIds) {
      currentIds = ids;
      for (const track of state.tracks) catalog.remember(track, track.source?.id, referenceVersion(track.source?.url));
      save();
      if (view.panels.sources) renderSources();
      else renderStartLibrary();
    }
  }

  /** Loading-stage and busy visuals; called from the core render path after syncCatalog. */
  function syncLoadVisuals(state: WorkbenchState) {
    if (loadingSource && state.mediaLoad?.state === 'loading' && loadingSource.status !== loadStages[state.mediaLoad.stage]) { loadingSource.status = loadStages[state.mediaLoad.stage]; renderSources(); }
    if (sourceBusy !== state.busy) { sourceBusy = state.busy; renderSources(); }
  }

  // The library refreshes itself (3 s poll plus server file watchers); the
  // panel loads once when opened and the list stays live after that.
  function refreshLibrary() {
    if (refreshing) return refreshing;
    libraryChecked = true;
    refreshing = Promise.all([libraryBrowser.load(), refreshRecent()]).then(() => {}).finally(() => { refreshing = undefined; });
    return refreshing;
  }

  function ensureLibrary() { if (!libraryChecked) void refreshLibrary(); }

  function rememberFile(file: File) {
    catalog.addFile(file); save();
    if (view.panels.sources) renderSources();
  }

  /** Start a layout restore without awaiting indexing; finish with finishRestore. */
  function beginRestore(sources: { tab: string; query: string; root: string; directory: string; search: string; all: boolean; recent?: boolean }) {
    $<HTMLInputElement>('source-search').value = sources.query;
    return libraryBrowser.restore({ ...sources, recent: sources.recent ?? sources.tab === 'recent' });
  }

  async function finishRestore(browsing: Promise<unknown>) {
    await browsing;
    if (libraryBrowser.isRecent()) await refreshRecent();
  }

  function sourcesLayout() {
    return { ...libraryBrowser.snapshot(), tab: (libraryBrowser.isRecent() ? 'recent' : 'available') as 'recent' | 'available', query: $<HTMLInputElement>('source-search').value };
  }

  function setSearching(open: boolean) {
    const tools = $('source-tools');
    const field = $('source-search-field');
    const input = $<HTMLInputElement>('source-search');
    const toggle = $('sources-search-toggle');
    if (!open && input.value) {
      input.value = '';
      if (!libraryBrowser.isRecent()) libraryBrowser.search('');
      renderSources();
    }
    tools.classList.toggle('searching', open);
    field.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    if (open) input.focus();
    else toggle.focus();
  }

  const scrollbar = installSourceScrollbar($('source-list'), $('source-scrollbar'), $('source-scrollbar-thumb'), lifecyle.signal);
  function wireSourceControls() {
    const more = $('start-library-more');
    if (more) more.onclick = () => shared.setPanel('sources', true);
    $('replace-source-close').onclick = () => $<HTMLDialogElement>('replace-source-dialog').close();
    $('source-search').oninput = () => { if (!libraryBrowser.isRecent()) libraryBrowser.search($<HTMLInputElement>('source-search').value); renderSources(); };
    $('sources-search-toggle').onclick = () => setSearching(!$('source-tools').classList.contains('searching'));
    $('source-search-close').onclick = () => setSearching(false);
    $('source-search').onkeydown = event => { if (event.key === 'Escape') { event.preventDefault(); setSearching(false); } };
    $('source-files').onchange = () => {
      const input = $<HTMLInputElement>('source-files');
      for (const file of input.files ?? []) catalog.addFile(file);
      input.value = ''; save(); renderSources();
    };
    $('local-add').onclick = () => $<HTMLInputElement>('source-files').click();
  }

  return {
    renderSources, renderStartLibrary, refreshLibrary, ensureLibrary, rememberFile,
    syncCatalog, syncLoadVisuals, beginRestore, finishRestore, sourcesLayout, wireSourceControls,
    markDisposed() { disposed = true; },
  };
}
