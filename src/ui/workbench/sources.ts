import { createLibraryFileRow, installLibraryListing, sizeText, storageText, openedText, sourceDisplayName, patchLibraryRow } from '../library-view.ts';
import { installLibraryThumbnails } from '../library-thumbnails.ts';
import { loadStageLabel } from '../media-progress.ts';
import type { MediaLoadStage } from '../media-progress.ts';
import { t, msg } from '../../i18n.ts';
import { SLOTS } from '../../../shared/review/model.ts';
import type { Slot } from '../../../shared/review/model.ts';
import { icon } from '../icons.ts';
import { currentActor } from '../../services/identity.ts';
import { fetchLibraryItem, openLibraryItem } from '../../services/library.ts';
import type { LibraryEntry } from '../../services/library.ts';
import { prefetchThumbnailStatus, prefetchThumbnailStatuses } from '../../thumbnails/client.ts';
import { referenceVersion } from '../../../shared/media/io/media-reference.ts';
import { openMedia } from '../../media/source.ts';
import { installLibraryBrowser } from '../library-browser.ts';
import { installLibraryFileMenu } from '../library-file-menu.ts';
import { installSourceScrollbar } from '../source-scrollbar.ts';
import { sourceInUse, sourceKey } from '../source-catalog.ts';
import { FileHandleError, handleKey, hasFileHandle, pickVideoFiles, restoreHandleSource, saveFileHandle, supportsFileHandles } from '../../services/file-handles.ts';
import type { SourceItem } from '../source-catalog.ts';
import { localAccessMessage } from '../source-access-message.ts';
import type { LibraryAccessProblem, LocalAccessProblem } from '../../../shared/media/io/source-access.ts';
import { log } from '../../logging/log.ts';
import type { WorkbenchShared, WorkbenchState } from './shared.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const text = (tag: string, value: string, className = '') => {
  const el = document.createElement(tag); el.textContent = value; el.className = className; return el;
};
/** Source catalog + library browser + load transactions. Owns source signatures. */
export function createSourcesPane(shared: WorkbenchShared) {
  const { session, act, view, catalog, lifecyle } = shared;
  const save = () => shared.save();
  const fileMenu = installLibraryFileMenu($('source-list'), act, shared.notify, lifecyle.signal);
  let refreshing: Promise<void> | undefined;
  let libraryChecked = false;
  let disposed = false;
  let sourceSignature = '';
  let startSignature = '';
  let currentIds = '';
  let loadingSource: { key: string; status: () => string; stage?: MediaLoadStage } | null = null;
  let loadingConfirmed = false;
  let confirmTimer: ReturnType<typeof setTimeout> | undefined;
  let sourceLoadError: { key: string; message: string } | null = null;
  let recentRevision = -1;
  let recentRootsState = '', recentRetry = false;
  let recentRequest = 0;
  // History keeps local-file metadata only: after reload the live File is gone
  // and the row cannot load until the user re-picks the file. Remember which
  // row asked so the picker result can continue straight into that load.
  let pendingReselect: string | null = null;
  // Handle availability per history key: true once a stored handle is known,
  // false/unknown renders the stale hint. Looked up async (IndexedDB) only
  // for stale local rows; resolved lookups rebuild just that row via the
  // start-list fingerprint below.
  const handleKnown = new Map<string, boolean>();
  const handlePending = new Set<string>();
  function refreshHandleAvailability(items: SourceItem[]) {
    if (!supportsFileHandles()) return;
    for (const item of items) {
      if (item.file || item.library || item.libraryId || handleKnown.has(item.key) || handlePending.has(item.key)) continue;
      handlePending.add(item.key);
      void hasFileHandle(item.key).then(known => {
        handlePending.delete(item.key);
        if (disposed || handleKnown.get(item.key) === known) return;
        handleKnown.set(item.key, known);
        renderSources();
      });
    }
  }

  const libraryBrowser = installLibraryBrowser({list:$('source-list'),tools:$('source-tools'),foot:$('source-foot'),
    visible:() => !$('sources-panel').hidden, manage:true}, page => {
    const rootsChanged = page ? catalog.setLibraryRoots(page.roots.map(root => root.id)) : false;
    catalog.setLibrary(page?.entries ?? []);
    // Warm thumbnail presence/epochs beside listing; never blocks opening.
    if (page) prefetchThumbnailStatuses(page.entries, 60, page.thumbnailEpoch);
    const rootsState = JSON.stringify(page?.roots.map(root => [root.id, root.state]));
    if (page && (rootsChanged || recentRevision !== page.revision || rootsState !== recentRootsState || recentRetry)) {
      recentRevision = page.revision; recentRootsState = rootsState; void refreshRecent();
    }
    renderSources();
  }, lifecyle.signal, home => {
    if (home) void refreshRecent();
    renderSources();
  }, shared.notify, () => !document.getElementById('empty-A')!.hidden && catalog.referencesToResolve().length > 0);
  const listing = installLibraryListing($('source-list'), {fileRow:sourceRow, navigate:libraryBrowser.navigate, registerMount:fileMenu.registerMount});
  const recentGroup = {section:listing.recentGroup};
  const thumbnails = installLibraryThumbnails(['source-list','local-list','start-library-list'].map(id => $(id)), lifecyle.signal);
  const attachThumb = thumbnails.attach;
  const recentLookups = new Map<string, { at: number; value: Promise<LibraryEntry | null> }>();
  async function refreshRecent() {
    const ticket = ++recentRequest;
    const ids = [...new Set(catalog.referencesToResolve().flatMap(item => item.libraryId ? [item.libraryId] : []))];
    const problems: [string, LibraryAccessProblem][] = [];
    const entries = await Promise.all(ids.map(async id => {
      try {
        const key = JSON.stringify([currentActor()?.id, id, libraryBrowser.page()?.etag]), now = Date.now();
        let lookup = recentLookups.get(key);
        if (!lookup || now - lookup.at > 1000) {
          const value = fetchLibraryItem(id, AbortSignal.any([lifecyle.signal, AbortSignal.timeout(5000)]));
          lookup = { at: now, value }; recentLookups.set(key, lookup);
          void value.catch(() => { if (recentLookups.get(key)?.value === value) recentLookups.delete(key); });
          while (recentLookups.size > 128) recentLookups.delete(recentLookups.keys().next().value!);
        }
        const entry = await lookup.value;
        if (!entry) problems.push([id, 'missing']);
        return entry ? [id, entry] as [string, LibraryEntry] : null;
      } catch { problems.push([id, 'unavailable']); return null; }
    }));
    if (disposed || ticket !== recentRequest) return;
    recentRetry = problems.some(([, reason]) => reason === 'unavailable');
    const unavailableRoots = new Set(libraryBrowser.page()?.roots.filter(root => root.state !== 'ready').map(root => root.id));
    catalog.setRecentLibrary(entries.filter((item): item is [string, LibraryEntry] => item !== null), problems, unavailableRoots);
    save(); renderSources();
  }

  async function load(item: SourceItem, slot: Slot) {
    if (loadingSource?.key === item.key || (!item.file && !item.library) || sourceInUse(item, session.getState().tracks)) return;
    // Parallel cache-status warm for the frozen upload epoch; never awaited.
    if (item.library?.id) prefetchThumbnailStatus(item.library.id, item.library.version);
    const pendingLoad: NonNullable<typeof loadingSource> = { key: item.key, status: () => t(msg("sources.loading", "正在载入")) };
    loadingSource = pendingLoad; loadingConfirmed = false; sourceLoadError = null;
    clearTimeout(confirmTimer);
    // Loading visuals only appear once the load proves it is not instant;
    // fast loads never touch the list DOM.
    confirmTimer = setTimeout(() => { if (loadingSource === pendingLoad) { loadingConfirmed = true; renderSources(); } }, 250);
    renderSources();
    const progress = (stage: MediaLoadStage) => {
      if (loadingSource !== pendingLoad) return;
      pendingLoad.stage = stage; pendingLoad.status = () => loadStageLabel(stage);
      renderSources();
    };
    try {
      await act(async () => {
        try {
          await session.load(slot, async (signal, report, configuration) => {
            const onProgress = (stage: MediaLoadStage) => { progress(stage); report(stage); };
            const source = await (item.file ? openMedia(item.file, undefined, onProgress, signal, configuration) : openLibraryItem(item.library!, onProgress, signal, configuration));
            if (loadingSource === pendingLoad) { pendingLoad.status = () => t(msg("sources.showingFirstFrame", "正在显示首帧")); renderSources(); }
            return source;
          }, item.name);
          catalog.remember(item, item.library?.id, item.library?.version, item.library?.rootId); save();
        } catch (error) {
          if (error instanceof Error && error.name === 'AbortError') return;
          if (loadingSource === pendingLoad) sourceLoadError = { key: item.key, message: error instanceof Error ? error.message : String(error) };
          throw error;
        }
      }, 'ui.source-load', { name: item.name, slot });
    } finally { clearTimeout(confirmTimer); if (loadingSource === pendingLoad) { loadingSource = null; loadingConfirmed = false; } renderSources(); }
  }

  function addToView(item: SourceItem) {
    if (loadingSource?.key === item.key || sourceInUse(item, session.getState().tracks)) return;
    const offline = libraryBrowser.page()?.roots.some(root => root.id === item.library?.rootId && root.state === 'offline');
    if (offline || item.library?.state && item.library.state !== 'ready') return;
    if (!item.file && !item.library) { if (!item.libraryId) void reselectLocal(item); return; }
    const empty = SLOTS.find(slot => !session.getState().tracks.some(track => track.slot === slot));
    if (empty) void load(item, empty);
    else void act(() => { throw new Error(t(msg('sources.noEmptyTracks', '没有空轨道，请先关闭一个视频。'))); }, 'ui.source-full');
  }
  function removeFromView(item: SourceItem) {
    void act(async () => {
      if (session.getState().busy || loadingSource) return;
      const tracks = session.getState().tracks.filter(track => sourceInUse(item, [track]));
      for (const track of tracks) {
        if (session.getState().tracks.some(current => current.slot === track.slot && current.id === track.id)) await session.removeTrack(track.slot);
      }
    }, 'ui.source-remove', {name:item.name});
  }

  function sourceRow(item: SourceItem, copyOnly = false) {
    const slots = session.getState().tracks.filter(track => sourceInUse(item, [track])).map(track => track.slot);
    const tooltip = item.library ? t(msg('sources.tooltipLibrary', '{name}（{root}）'), {name:item.name,root:item.library.root}) : item.libraryId ? item.name
      : item.file ? t(msg('sources.tooltipLocalOnly', '{name}（本地文件，仅本机预览）'), {name:item.name})
      : localAccessMessage(item.name, supportsFileHandles() ? 'unavailable' : 'unsupported');
    const row = createLibraryFileRow(item, {
      slots, tooltip, home:libraryBrowser.isRoot(),
      loading:loadingSource?.key === item.key && loadingConfirmed ? loadingSource.status() : null,
      failed:sourceLoadError?.key === item.key ? sourceLoadError.message : null,
      offline:libraryBrowser.page()?.roots.some(root => root.id === item.library?.rootId && root.state === 'offline'),
      removeDisabled:session.getState().busy || !!loadingSource, open:() => addToView(item), remove:() => removeFromView(item),
    });
    if (!copyOnly) attachThumb(row, item);
    if (!copyOnly) fileMenu.register(row, item.library, () => {
      const used = sourceInUse(item, session.getState().tracks), state = session.getState();
      const offline = libraryBrowser.page()?.roots.some(root => root.id === item.library?.rootId && root.state === 'offline');
      return {id:used?'remove-from-view':'add-to-view', label:used?t(msg('sources.takeOff', '下屏')):t(msg('sources.putOn', '上屏')),
        glyph:used?'close':'plus', disabled:used?state.busy || !!loadingSource:!!offline || item.library?.state === 'pending' || loadingSource?.key === item.key,
        run:() => {if(used)removeFromView(item);else addToView(item);}};
    });
    return row;
  }

  function startRow(item: SourceItem, copyOnly = false) {
    const row = document.createElement('button');
    row.className = 'start-recent-row';
    // Local metadata without a live File still needs browser file access.
    const staleLocal = !item.file && !item.library && !item.libraryId;
    // A stored handle means one click restores silently — no re-pick needed.
    const restorable = staleLocal && handleKnown.get(item.key) === true;
    row.setAttribute('aria-label', staleLocal && !restorable ? t(msg("sources.reselectRowName", "重新选择：{name}"), { name: item.name }) : t(msg("sources.openName", "打开：{name}"), { name: item.name }));
    const { base, dir } = sourceDisplayName(item.name);
    const name = text('span', base, 'filename');
    const origin = item.library ? [item.library.root, dir].filter(Boolean).join(' / ') : '';
    const opened = openedText(item.openedAt);
    const meta = text('span', item.library || item.libraryId ? `${sizeText(item.size)} · ${t(msg("sources.startMetaLibrary", "媒体库"))}${origin ? ` · ${origin}` : ''}${opened ? ` · ${opened}` : ''}` : `${sizeText(item.size)} · ${t(msg('sources.localTag', '(本地)'))}${staleLocal && !restorable ? t(msg("sources.reselectNeeded", " · 需重新选择")) : ''}${opened ? ` · ${opened}` : ''}`, 'source-meta');
    const go = document.createElement('span'); go.className = 'start-recent-go'; go.setAttribute('aria-hidden', 'true'); go.innerHTML = icon('caretRight');
    const info = document.createElement('span'); info.className = 'source-info'; info.append(name, meta);
    row.append(info, go);
    row.dataset.sourceKey = item.key;
    if (!copyOnly) attachThumb(row, item);
    row.dataset.tooltip = staleLocal && !restorable ? localAccessMessage(item.name, supportsFileHandles() ? 'unavailable' : 'unsupported') : item.name;
    row.onclick = () => {
      if (session.getState().busy || sourceInUse(item, session.getState().tracks)) return;
      if (staleLocal) { void reselectLocal(item); return; }
      if (item.libraryId && !item.library) return;
      const tracks = session.getState().tracks;
      const empty = SLOTS.find(slot => !tracks.some(t => t.slot === slot));
      if (empty) void load(item, empty);
      else shared.setPanel('sources', true);
    };
    return row;
  }

  /** Reopen a stale local row: silent restore when the stored handle still
   * grants access, otherwise the system picker (which also stores a handle
   * for next time), otherwise the legacy file input. */
  async function reselectLocal(item: SourceItem) {
    if (session.getState().busy || sourceInUse(item, session.getState().tracks)) return;
    const openLive = (file: File,previousKey?:string) => {
      if(previousKey)catalog.restoreFile(previousKey,file);else catalog.addFile(file);save();
      const live: SourceItem = { key: handleKey(file), name: file.name, size: file.size, lastModified: file.lastModified, file };
      const empty = SLOTS.find(slot => !session.getState().tracks.some(t => t.slot === slot));
      if (empty) void load(live, empty);
      else shared.setPanel('sources', true);
    };
    let reason: LocalAccessProblem = supportsFileHandles() ? 'unavailable' : 'unsupported';
    if (supportsFileHandles()) {
      try {
        const restored=await restoreHandleSource(item.key);
        handleKnown.set(restored.key,true);handleKnown.set(item.key,true);
        openLive(restored.file,item.key);
        return;
      } catch (error) {
        if (error instanceof FileHandleError) reason = error.kind;
        handleKnown.set(item.key, false); renderSources();
      }
      try {
        const picked = await pickVideoFiles(false);
        if (!picked) return;
        const [{ file, handle }] = picked;
        await saveFileHandle(handleKey(file), handle, file).catch(() => {});
        handleKnown.set(handleKey(file), true);
        openLive(file);
        return;
      } catch (error) {
        // The picker itself being unusable (policy, headless, transient
        // failure) falls back to the legacy input, same as unsupported browsers.
        if (!(error instanceof FileHandleError) || !['unavailable', 'unsupported'].includes(error.kind)) {
          if (error instanceof FileHandleError) shared.notify(error.message);
          return;
        }
      }
    }
    pendingReselect = item.key;
    $<HTMLInputElement>('source-files').click();
    const message = localAccessMessage(item.name, reason);
    log.warn('ui', '本地历史文件需要重新选择', { name: item.name, reason, persistentLocalFiles: supportsFileHandles(), message });
    shared.notify(message);
  }

  /** Panel-level reselect: same handle-storing picker, but only adds to the
   * catalog — the user picks the target slot with the row action. */
  async function reselectIntoCatalog() {
    pendingReselect = null;
    if (supportsFileHandles()) {
      try {
        const picked = await pickVideoFiles(true);
        if (!picked) return;
        for (const { file, handle } of picked) {
          catalog.addFile(file);
          await saveFileHandle(handleKey(file), handle, file).catch(() => {});
        }
        save(); renderSources();
        return;
      } catch (error) {
        if (!(error instanceof FileHandleError) || !['unavailable', 'unsupported'].includes(error.kind)) {
          if (error instanceof FileHandleError) shared.notify(error.message);
          return;
        }
      }
    }
    $<HTMLInputElement>('source-files').click();
  }

  function renderStartLibrary() {
    const list = $('start-library-list');
    if (!list) return;
    const items = catalog.recent();
    const tracks = session.getState().tracks;
    // Stable identity only: thumbnail readiness must NOT rebuild rows —
    // completion patches the placeholder <img> in place via notify.
    const fingerprintOfStart = (item: SourceItem) => JSON.stringify([
      !!item.file, item.library?.id ?? item.libraryId ?? null,
      item.library?.version ?? item.version ?? null, item.library?.state ?? null,
      item.name, item.size, item.openedAt ?? null, sourceInUse(item, tracks),
      (!item.file && !item.library && !item.libraryId) ? handleKnown.get(item.key) ?? 'unknown' : null,
    ]);
    const signature = JSON.stringify(items.map(item => [item.key, fingerprintOfStart(item)]));
    if (signature === startSignature) return;
    startSignature = signature;
    const existing = new Map([...list.querySelectorAll<HTMLElement>('[data-source-key]')].map(node => [node.dataset.sourceKey, node]));
    const rows: HTMLElement[] = [];
    for (const item of items) {
      const fingerprint = fingerprintOfStart(item);
      const old = existing.get(item.key);
      const row = old?.dataset.fingerprint === fingerprint ? old : startRow(item);
      row.dataset.sourceKey = item.key;
      row.dataset.fingerprint = fingerprint;
      rows.push(row);
    }
    rows.forEach((row, index) => { if (list.children[index] !== row) list.insertBefore(row, list.children[index] ?? null); });
    while (list.children.length > rows.length) list.lastElementChild!.remove();
    refreshHandleAvailability(items);
    if (!items.length) {
      const empty = document.createElement('div'); empty.className = 'start-library-empty';
      const symbol = document.createElement('span'); symbol.innerHTML = icon('sidebar', 'mirror'); empty.append(symbol);
      const label = document.createElement('span'); label.textContent = t(msg("sources.noRecentVideos", "还没有最近打开的视频")); empty.append(label);
      list.append(empty);
    }
    startScrollbar.update();
  }

  function renderSources() {
    const home = libraryBrowser.isRoot();
    const query = libraryBrowser.filter().toLocaleLowerCase();
    const pool = home ? catalog.recent() : catalog.available();
    if (home) for (const item of catalog.available()) {
      if (item.file && !item.library && !pool.some(current => current.key === item.key)) pool.push(item);
    }
    const scoped = pool.filter(item => item.name.toLocaleLowerCase().includes(query));
    // Local files live in their own section pinned above the activity panel.
    const local = home ? [] : scoped.filter(item => item.file && !item.library);
    const items = home ? scoped : scoped.filter(item => !(item.file && !item.library));
    const page = libraryBrowser.page();
    const folders = home ? [] : page?.directories ?? [];
    const mounts = home ? (page?.roots ?? []).filter(mount => mount.name.toLocaleLowerCase().includes(query)) : [];
    const loadingKey = loadingSource?.key ?? null;
    const failedKey = sourceLoadError?.key ?? null;
    // Only source and navigation state affect the list. A seek must not
    // disable every row or rebuild any of their action controls.
    const sourceSlots = (item: SourceItem) => session.getState().tracks.filter(track => sourceInUse(item, [track])).map(track => track.slot);
    const signature = JSON.stringify([home, query, loadingKey, loadingConfirmed, loadingConfirmed ? loadingSource?.stage ?? 'loading' : null, failedKey, sourceLoadError?.message ?? null, folders, mounts.map(mount => [mount.id, mount.name, mount.state, storageText(mount)]), page?.roots.map(root => [root.id, root.name, root.state]), items.map(item => [item.key, !!item.file, item.library?.version, item.library?.state, item.openedAt ?? null, sourceSlots(item)]), local.map(item => [item.key, item.openedAt ?? null, sourceSlots(item)])]);
    const list = $('source-list');
    // Stable per-row identity: thumbnail presence/URLs must NOT rebuild rows.
    // Volatile fields (scannedAt, thumbnail flag, full roots objects) are
    // excluded; completion patches the placeholder <img> via notify.
    const stableRoots = page?.roots.map(root => [root.id, root.name, root.state]);
    const fingerprintOf = (item: SourceItem) => JSON.stringify([home, !!item.file, item.library?.id ?? item.libraryId ?? null, item.library?.version ?? item.version ?? null, item.library?.state ?? null, item.library?.root ?? null, item.library?.rootId ?? null, item.name, item.size, item.lastModified, item.openedAt ?? null, loadingKey === item.key && loadingConfirmed ? loadingSource?.stage ?? 'loading' : null, failedKey === item.key ? sourceLoadError?.message : null, sourceSlots(item), stableRoots]);
    const syncRowAvailability = (container: HTMLElement, pool: SourceItem[]) => {
      const byKey = new Map(pool.map(entry => [entry.key, entry]));
      for (const row of container.querySelectorAll<HTMLElement>('.source-row')) {
        const item = byKey.get(row.dataset.sourceKey ?? '');
        if (!item) continue;
        const used = sourceInUse(item, session.getState().tracks);
        const pending = item.library?.state === 'pending';
        const offline = page?.roots.some(root => root.id === item.library?.rootId && root.state === 'offline');
        const blocked = loadingSource?.key === item.key || !!pending || !!offline || !!item.libraryId && !item.library;
        row.setAttribute('aria-disabled', String(!used && !!blocked));
        row.querySelector('.source-open')?.setAttribute('aria-disabled', String(used || !!blocked));
        row.querySelector('.source-remove')?.setAttribute('aria-disabled', String(session.getState().busy || !!loadingSource));
      }
    };
    if (signature !== sourceSignature) {
      sourceSignature = signature;
      listing.render({home,query,page,items,fingerprint:fingerprintOf});
      syncRowAvailability(list, items);
      const localList = $('local-list');
      $('local-sources').hidden = local.length === 0;
      $('local-sources-heading').textContent = local.length ? t(msg("sources.localFilesCount", "本地文件（{n}）"), { n: local.length }) : t(msg("sources.localFiles", "本地文件"));
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
      syncRowAvailability(localList, local);
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
      void refreshRecent();
      if (view.panels.sources) renderSources();
      else renderStartLibrary();
    }
  }

  /** Loading-stage visuals; called from the core render path after syncCatalog. */
  function syncLoadVisuals(state: WorkbenchState) {
    if (loadingSource && state.mediaLoad?.state === 'loading' && loadingSource.stage !== state.mediaLoad.stage) { const stage = state.mediaLoad.stage; loadingSource.stage = stage; loadingSource.status = () => loadStageLabel(stage); renderSources(); }
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
    if (sources.recent || sources.tab === 'recent') recentGroup.section.open = true;
    return libraryBrowser.restore({ ...sources, recent: sources.recent ?? sources.tab === 'recent' });
  }

  async function finishRestore(browsing: Promise<unknown>) {
    await browsing;
    if (libraryBrowser.isRoot()) await refreshRecent();
  }

  let locateRequest: AbortController | undefined;
  let locateHighlight: ReturnType<typeof setTimeout> | undefined;
  async function locateTrack(slot: Slot) {
    locateRequest?.abort(); locateRequest = new AbortController();
    const request = locateRequest;
    const signal = AbortSignal.any([lifecyle.signal, request.signal]);
    const track = session.getState().tracks.find(track => track.slot === slot);
    if (!track) return;
    let key: string;
    if (track.source) {
      let entry: LibraryEntry | null;
      try { entry = await fetchLibraryItem(track.source.id, signal); }
      catch (error) { if (signal.aborted) return; throw error; }
      if (signal.aborted || session.getState().tracks.find(current => current.slot === slot)?.source?.id !== track.source.id) return;
      if (!entry || entry.state === 'missing') { shared.notify(t(msg('sources.locateUnavailable', '片源已不在媒体库中。'))); return; }
      libraryBrowser.clearSearch();
      if (!await libraryBrowser.reveal(entry) || signal.aborted || session.getState().tracks.find(current => current.slot === slot)?.source?.id !== track.source.id) return;
      key = sourceKey(entry, entry.id);
    } else {
      libraryBrowser.clearSearch(); recentGroup.section.open = true; renderSources(); key = sourceKey(track);
    }
    const row = [...document.querySelectorAll<HTMLElement>('#source-list .source-row, #local-list .source-row')].find(row => row.dataset.sourceKey === key);
    if (!row || signal.aborted) return;
    clearTimeout(locateHighlight);
    for (const existing of document.querySelectorAll<HTMLElement>('.source-row.is-located')) {
      if (existing !== row) existing.classList.remove('is-located');
    }
    // Same-row rapid clicks must restart the CSS animation: remove + reflow + add.
    row.classList.remove('is-located');
    void row.offsetWidth;
    row.classList.add('is-located');
    const list = row.closest<HTMLElement>('#source-list, .local-sources')!;
    const box = row.getBoundingClientRect(), bounds = list.getBoundingClientRect();
    const top = bounds.top + parseFloat(getComputedStyle(list).paddingTop || '0');
    const bottom = list.id === 'source-list' ? $('source-foot').getBoundingClientRect().top : bounds.bottom;
    if (box.top < top) list.scrollTop += box.top - top;
    else if (box.bottom > bottom) list.scrollTop += box.bottom - bottom;
    scrollbar.update();
    locateHighlight = setTimeout(() => row.classList.remove('is-located'), 1800);
  }
  lifecyle.signal.addEventListener('abort', () => { locateRequest?.abort(); clearTimeout(locateHighlight); }, { once: true });

  function sourcesLayout() {
    const snapshot = libraryBrowser.snapshot();
    return { ...snapshot, tab: 'available' as const, query: snapshot.search };
  }

  const scrollbar = installSourceScrollbar($('source-list'), $('source-scrollbar'), $('source-scrollbar-thumb'), lifecyle.signal);
  const startScrollbar = installSourceScrollbar($('start-library-list'), $('start-scrollbar'), $('start-scrollbar-thumb'), lifecyle.signal);
  let refreshIdentity: () => void = () => {};
  function wireSourceControls() {
    const more = $('start-library-more');
    if (more) more.onclick = () => shared.setPanel('sources', true);
    const identity = $('start-identity');
    const showIdentity = () => { if (identity) {
      const actorName = currentActor()?.name ?? t(msg("sources.guest", "访客"));
      const name = document.createElement('span'); name.className = 'start-identity-name'; name.textContent = actorName;
      const prefix = document.createElement('span'); prefix.className = 'start-identity-prefix'; prefix.textContent = t(msg("sources.currentIdentityPrefix", "当前身份 · "));
      identity.replaceChildren(prefix, name);
      identity.title = t(msg("sources.identityTitle", "点击打开用户设置（当前身份：{name}）"), {name:actorName});
      identity.setAttribute('aria-label', t(msg("sources.identityAria", "当前身份：{name}，打开用户设置"), {name:actorName}));
    } };
    showIdentity();
    refreshIdentity = showIdentity;
    window.addEventListener('voidplayer-identity-change', showIdentity, { signal: lifecyle.signal });
    $('source-files').onchange = () => {
      const input = $<HTMLInputElement>('source-files');
      const files = [...input.files ?? []];
      for (const file of files) catalog.addFile(file);
      input.value = ''; save(); renderSources();
      // Continue a start-panel reselect straight into the load when the
      // picked file matches the row that asked (name/size/mtime identity).
      if (pendingReselect) {
        const key = pendingReselect; pendingReselect = null;
        const match = files.find(file => sourceKey(file) === key);
        if (match && !session.getState().busy) {
          const item: SourceItem = { key, name: match.name, size: match.size, lastModified: match.lastModified, file: match };
          const empty = SLOTS.find(slot => !session.getState().tracks.some(t => t.slot === slot));
          if (empty) void load(item, empty);
          else shared.setPanel('sources', true);
        }
      }
    };
    $('source-files').oncancel = () => { pendingReselect = null; };
    $('local-add').onclick = () => { void reselectIntoCatalog(); };
  }

  /** Relabel cached nodes in place; keep row focus and event handlers. */
  function localize() {
    const items = new Map([...catalog.recent(), ...catalog.available()].map(item=>[item.key,item]));
    for(const row of document.querySelectorAll<HTMLElement>('.source-row[data-source-key], .start-recent-row[data-source-key]')) {
      const item=items.get(row.dataset.sourceKey!); if(item)patchLibraryRow(row,row.classList.contains('start-recent-row')?startRow(item,true):sourceRow(item,true));
    }
    listing.localize(libraryBrowser.page(), libraryBrowser.isRoot(), libraryBrowser.filter());
    const startEmpty=document.querySelector('.start-library-empty > span:last-child');
    if(startEmpty)startEmpty.textContent=t(msg("sources.noRecentVideos", "还没有最近打开的视频"));
    sourceSignature = ''; // Reuses unchanged rows and updates source heading/count/status controls.
    refreshIdentity();
    renderSources();
  }

  return {
    async openLibraryFile(id: string, version: string) {
      const entry = await fetchLibraryItem(id,AbortSignal.any([lifecyle.signal,AbortSignal.timeout(10000)]));
      if (disposed || session.getState().tracks.length || session.getState().busy) return;
      if (!entry || entry.version !== version) throw new Error(t(msg('sources.linkUnavailable','该媒体库文件已不存在或版本已变化。')));
      await load({...entry,key:sourceKey(entry,entry.id),library:entry},'A');
    },
    renderSources, renderStartLibrary, refreshLibrary, ensureLibrary, rememberFile, localize,
    syncCatalog, syncLoadVisuals, beginRestore, finishRestore, sourcesLayout, wireSourceControls, locateTrack,
    markDisposed() { disposed = true; },
  };
}
