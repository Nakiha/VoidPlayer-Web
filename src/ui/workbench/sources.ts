import { loadStages } from '../../media-progress.ts';
import type { MediaLoadStage } from '../../media-progress.ts';
import { SLOTS } from '../../model.ts';
import type { Slot } from '../../model.ts';
import { createIconButton } from '../controls.ts';
import { icon } from '../icons.ts';
import { currentActor } from '../../identity.ts';
import { fetchLibraryItem, openLibraryItem } from '../../library.ts';
import type { LibraryEntry } from '../../library.ts';
import { localCacheKey, serverCacheKey } from '../../thumbnails/contract.ts';
import { fillThumbnailImage, getLiveObjectUrl, materializeThumbnailUrl, onThumbnailReady, prefetchThumbnailStatus, prefetchThumbnailStatuses, serverThumbnailImageUrl } from '../../thumbnails/client.ts';
import { getLocalThumbnail } from '../../thumbnails/local-store.ts';
import { thumbnailState } from '../../thumbnails/state.ts';
import { referenceVersion } from '../../media-reference.ts';
import { openMedia } from '../../media.ts';
import { installLibraryBrowser } from '../library-browser.ts';
import { installSourceScrollbar } from '../source-scrollbar.ts';
import { sourceInUse, sourceKey } from '../source-catalog.ts';
import { FileHandleError, handleKey, hasFileHandle, pickVideoFiles, restoreHandleFile, saveFileHandle, supportsFileHandles } from '../../file-handles.ts';
import type { SourceItem } from '../source-catalog.ts';
import type { WorkbenchShared, WorkbenchState } from './shared.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const sizeText = (n: number) => n >= 2 ** 30 ? `${(n / 2 ** 30).toFixed(1)} GB` : `${(n / 2 ** 20).toFixed(1)} MB`;
const openedText = (value?: number) => {
  if (!Number.isFinite(value)) return '';
  try { return new Date(value as number).toLocaleString(); } catch { return ''; }
};
const text = (tag: string, value: string, className = '') => {
  const el = document.createElement(tag); el.textContent = value; el.className = className; return el;
};

/** Source catalog + library browser + load transactions. Owns source signatures. */
export function createSourcesPane(shared: WorkbenchShared) {
  const { session, act, view, catalog, lifecyle } = shared;
  const save = () => shared.save();
  let refreshing: Promise<void> | undefined;
  let libraryChecked = false;
  let disposed = false;
  let sourceSignature = '';
  let startSignature = '';
  let currentIds = '';
  let sourceBusy = false;
  let loadingSource: { key: string; status: string } | null = null;
  let loadingConfirmed = false;
  let confirmTimer: ReturnType<typeof setTimeout> | undefined;
  let sourceLoadError: { key: string; message: string } | null = null;
  let recentRevision = -1;
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

  const libraryBrowser = installLibraryBrowser(page => {
    catalog.setLibrary(page?.entries ?? []);
    // Warm thumbnail presence/epochs beside listing; never blocks opening.
    if (page) prefetchThumbnailStatuses(page.entries);
    if (page && recentRevision !== page.revision) { recentRevision = page.revision; void refreshRecent(); }
    renderSources();
  }, lifecyle.signal, recent => {
    if (recent) void refreshRecent();
    renderSources();
  }, shared.notify);
  // Source key -> thumbnail cache key, so completion can fill the placeholder
  // <img> of the matching row in place. Bounded: rows re-register on render.
  const thumbKeyBySource = new Map<string, string>();
  // Thumbnail cache key -> last known server image URL (derived from the key
  // when status turns ready). Lets a server-ready notify patch rows without
  // waiting for an unrelated full-list rebuild.
  const serverUrlByThumbKey = new Map<string, string>();
  const rememberThumbKey = (sourceKey: string, thumbKey: string, serverUrl?: string) => {
    if (thumbKeyBySource.size > 500) thumbKeyBySource.clear();
    thumbKeyBySource.set(sourceKey, thumbKey);
    if (serverUrl) {
      if (serverUrlByThumbKey.size > 500) serverUrlByThumbKey.clear();
      serverUrlByThumbKey.set(thumbKey, serverUrl);
    }
  };
  function serverUrlForThumbKey(key: string): string | undefined {
    const cached = serverUrlByThumbKey.get(key);
    if (cached) return cached;
    // serverCacheKey format: v1|lib|<mediaId>|<mediaVersion>|... — derive the
    // image URL without needing the original library entry.
    if (!key.startsWith('v1|lib|')) return undefined;
    const parts = key.split('|');
    if (parts.length < 4 || !parts[2] || !parts[3]) return undefined;
    try {
      return serverThumbnailImageUrl(decodeURIComponent(parts[2]), decodeURIComponent(parts[3]));
    } catch {
      return serverThumbnailImageUrl(parts[2], parts[3]);
    }
  }
  // Thumbnail completion patches in place: refresh an existing <img> or
  // insert a cover once into a row that rendered coverless (0占位). No list
  // rebuild, no focus/scroll/selection movement. Stable fingerprints keep
  // rows alive, so insertion happens at most once per row.
  const patchThumbnails = (key: string) => {
    const live = getLiveObjectUrl(key);
    let serverUrl: string | undefined;
    if (!live && key.startsWith('v1|lib|')) {
      const ready = thumbnailState.statusCache.get(key)?.ready
        || thumbnailState.completed.has(key)
        || serverUrlByThumbKey.has(key);
      if (ready) serverUrl = serverUrlForThumbKey(key);
    }
    const url = live ?? serverUrl;
    // Truly missing stays 0占位: no placeholder, no empty box.
    if (!url) return;
    for (const id of ['source-list', 'local-list', 'start-library-list']) {
      const list = document.getElementById(id);
      if (!list) continue;
      for (const img of list.querySelectorAll<HTMLImageElement>('img[data-thumb-key]')) {
        if (img.dataset.thumbKey !== key) continue;
        if (img.dataset.thumbSrc === url) continue;
        fillThumbnailImage(img, key, live ? undefined : serverUrl);
      }
      for (const row of list.querySelectorAll<HTMLElement>('[data-source-key]')) {
        if (thumbKeyBySource.get(row.dataset.sourceKey ?? '') !== key) continue;
        if (row.querySelector(':scope > .source-thumb')) continue;
        row.prepend(makeThumbBox(key, url));
      }
    }
  };
  const offThumbnails = onThumbnailReady(patchThumbnails);
  lifecyle.signal.addEventListener('abort', offThumbnails);

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
    // Parallel cache-status warm for the frozen upload epoch; never awaited.
    if (item.library?.id) prefetchThumbnailStatus(item.library.id, item.library.version);
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

  /** Versioned thumbnail identity; missing version stays imageless. */
  function thumbIdentity(item: SourceItem): { key: string; serverUrl?: string } | null {
    const libraryId = item.library?.id ?? item.libraryId;
    const version = item.library?.version ?? item.version;
    if (libraryId && version) {
      const key = serverCacheKey({ mediaId: libraryId, mediaVersion: version });
      const known = item.library?.thumbnail || thumbnailState.statusCache.get(key)?.ready || !!thumbnailState.completed.has(key);
      return { key, ...(known ? { serverUrl: serverThumbnailImageUrl(libraryId, version) } : {}) };
    }
    if (item.file || (!item.library && !item.libraryId)) {
      return { key: localCacheKey(item.name, item.size, item.lastModified) };
    }
    return null;
  }

  /** Cover box. Removed on load failure so missing thumbnails take 0 space. */
  function makeThumbBox(key: string, url: string): HTMLElement {
    const box = document.createElement('div');
    box.className = 'source-thumb';
    box.setAttribute('aria-hidden', 'true');
    const img = document.createElement('img');
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.dataset.thumbKey = key;
    img.onerror = () => { box.remove(); };
    fillThumbnailImage(img, key, url.startsWith('blob:') ? undefined : url);
    box.append(img);
    return box;
  }

  /**
   * No blank slots: a row gets a cover box only when an image is available
   * synchronously (live object URL or known-ready server image). Otherwise
   * the row stays coverless (0占位), and a stored local artifact inserts the
   * box once its lookup resolves; generation completion arrives via notify.
   * Rows are reused by fingerprint, so insertion happens at most once.
   */
  function attachThumb(row: HTMLElement, item: SourceItem) {
    const identity = thumbIdentity(item);
    if (!identity) return;
    rememberThumbKey(item.key, identity.key, identity.serverUrl);
    const syncUrl = getLiveObjectUrl(identity.key) ?? identity.serverUrl;
    if (syncUrl) { row.prepend(makeThumbBox(identity.key, syncUrl)); return; }
    void getLocalThumbnail(identity.key).then(stored => {
      if (!stored || !row.isConnected || row.querySelector(':scope > .source-thumb')) return;
      row.prepend(makeThumbBox(identity.key, materializeThumbnailUrl(identity.key, stored.blob)));
    });
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
    const opened = openedText(item.openedAt);
    const status = text('span', `${sizeText(item.size)} · ${stateLabel} · ${origin}${opened ? ` · 上次打开 ${opened}` : ''}`, 'source-meta');
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
      button.setAttribute('aria-label', `重新选择 ${item.name}`); button.onclick = () => { void reselectIntoCatalog(); }; actions.append(button);
    }
    row.append(info, actions);
    row.dataset.sourceKey = item.key;
    attachThumb(row, item);
    return row;
  }

  function startRow(item: SourceItem) {
    const row = document.createElement('button');
    row.className = 'start-recent-row';
    // Stale rows (local metadata without a live File, or a library id that no
    // longer resolves) cannot load directly: route to re-selection instead of
    // silently ignoring the click.
    const staleLocal = !item.file && !item.library && !item.libraryId;
    const staleLibrary = !item.file && !item.library && !!item.libraryId;
    // A stored handle means one click restores silently — no re-pick needed.
    const restorable = staleLocal && handleKnown.get(item.key) === true;
    row.setAttribute('aria-label', `${staleLocal && !restorable ? '重新选择' : staleLibrary ? '在片源中重新选择' : '打开'}：${item.name}`);
    const { base, dir } = sourceDisplayName(item.name);
    const name = text('span', base, 'filename');
    const origin = item.library ? [item.library.root, dir].filter(Boolean).join(' / ') : '本机（不上传）';
    const opened = openedText(item.openedAt);
    const meta = text('span', item.library ? `${sizeText(item.size)} · 媒体库 · ${origin}${opened ? ` · ${opened}` : ''}` : `${sizeText(item.size)} · 本地文件${staleLocal && !restorable ? ' · 需重新选择' : ''}${opened ? ` · ${opened}` : ''}`, 'source-meta');
    const go = document.createElement('span'); go.className = 'start-recent-go'; go.setAttribute('aria-hidden', 'true'); go.innerHTML = icon('arrowRight');
    const info = document.createElement('span'); info.className = 'source-info'; info.append(name, meta);
    row.append(info, go);
    row.dataset.sourceKey = item.key;
    attachThumb(row, item);
    row.dataset.tooltip = item.name;
    row.onclick = () => {
      if (session.getState().busy || sourceInUse(item, session.getState().tracks)) return;
      if (staleLocal) { void reselectLocal(item); return; }
      if (staleLibrary) {
        shared.notify('媒体库中的文件已变化，请在片源中重新选择');
        shared.setPanel('sources', true);
        return;
      }
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
    const openLive = (file: File) => {
      catalog.addFile(file); save();
      const live: SourceItem = { key: handleKey(file), name: file.name, size: file.size, lastModified: file.lastModified, file };
      const empty = SLOTS.find(slot => !session.getState().tracks.some(t => t.slot === slot));
      if (empty) void load(live, empty);
      else shared.setPanel('sources', true);
    };
    if (supportsFileHandles()) {
      try {
        openLive(await restoreHandleFile(item.key));
        handleKnown.set(item.key, true);
        return;
      } catch (error) {
        if (error instanceof FileHandleError && error.kind === 'denied') shared.notify(`已拒绝访问本地文件 ${item.name}，如需打开请重新选择`);
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
        if (!(error instanceof FileHandleError) || error.kind !== 'unavailable') {
          if (error instanceof FileHandleError) shared.notify(error.message);
          return;
        }
      }
    }
    pendingReselect = item.key;
    $<HTMLInputElement>('source-files').click();
    shared.notify(`本地文件访问已过期，请重新选择 ${item.name}`);
  }

  /** Panel-level reselect: same handle-storing picker, but only adds to the
   * catalog — the user picks the target slot with the row action. */
  async function reselectIntoCatalog() {
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
        if (!(error instanceof FileHandleError) || error.kind !== 'unavailable') {
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
    const existing = new Map([...list.children].map(node => [(node as HTMLElement).dataset.sourceKey, node as HTMLElement]));
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
      const label = document.createElement('span'); label.textContent = '还没有最近打开的视频'; empty.append(label);
      list.append(empty);
    }
  }

  function renderSources() {
    const recent = libraryBrowser.isRecent();
    const query = (recent ? $<HTMLInputElement>('source-search').value.trim() : libraryBrowser.filter()).toLocaleLowerCase();
    const scoped = (recent ? catalog.recent() : catalog.available()).filter(item => item.name.toLocaleLowerCase().includes(query));
    // Local files live in their own section pinned above the activity panel.
    const local = scoped.filter(item => item.file && !item.library);
    const items = scoped.filter(item => !(item.file && !item.library));
    const page = libraryBrowser.page();
    const folders = !recent ? page?.directories ?? [] : [];
    const busy = session.getState().busy;
    const loadingKey = loadingSource?.key ?? null;
    const failedKey = sourceLoadError?.key ?? null;
    // The signature tracks which row loads, not the live stage text: stage
    // transitions must not rebuild the list. Per-row fingerprints below stay
    // stable across busy flips (e.g. seeks); disabled states sync in place.
    const signature = JSON.stringify([recent, query, loadingKey, loadingConfirmed, failedKey, sourceLoadError?.message ?? null, busy, folders, page?.roots.map(root => [root.id, root.state]), items.map(item => [item.key, !!item.file, item.library?.version, item.library?.state, item.openedAt ?? null, sourceInUse(item, session.getState().tracks)]), local.map(item => [item.key, item.openedAt ?? null, sourceInUse(item, session.getState().tracks)])]);
    const list = $('source-list');
    // Stable per-row identity: thumbnail presence/URLs must NOT rebuild rows.
    // Volatile fields (scannedAt, thumbnail flag, full roots objects) are
    // excluded; completion patches the placeholder <img> via notify.
    const stableRoots = page?.roots.map(root => [root.id, root.state]);
    const fingerprintOf = (item: SourceItem) => JSON.stringify([!!item.file, item.library?.id ?? item.libraryId ?? null, item.library?.version ?? item.version ?? null, item.library?.state ?? null, item.library?.root ?? null, item.library?.rootId ?? null, item.name, item.size, item.lastModified, item.openedAt ?? null, loadingKey === item.key && loadingConfirmed ? loadingSource?.status : null, failedKey === item.key ? sourceLoadError?.message : null, sourceInUse(item, session.getState().tracks), stableRoots]);
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
    const identity = $('start-identity');
    const showIdentity = () => { if (identity) { identity.textContent = `当前身份 · ${currentActor()?.name ?? '访客'}`; identity.title = identity.textContent; } };
    showIdentity();
    window.addEventListener('voidplayer-identity-change', showIdentity, { signal: lifecyle.signal });
    $('replace-source-close').onclick = () => $<HTMLDialogElement>('replace-source-dialog').close();
    $('source-search').oninput = () => { if (!libraryBrowser.isRecent()) libraryBrowser.search($<HTMLInputElement>('source-search').value); renderSources(); };
    $('sources-search-toggle').onclick = () => setSearching(!$('source-tools').classList.contains('searching'));
    $('source-search-close').onclick = () => setSearching(false);
    $('source-search').onkeydown = event => { if (event.key === 'Escape') { event.preventDefault(); setSearching(false); } };
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
    $('local-add').onclick = () => $<HTMLInputElement>('source-files').click();
  }

  return {
    renderSources, renderStartLibrary, refreshLibrary, ensureLibrary, rememberFile,
    syncCatalog, syncLoadVisuals, beginRestore, finishRestore, sourcesLayout, wireSourceControls,
    markDisposed() { disposed = true; },
  };
}
