import type { SourceItem } from './source-catalog.ts';
import { localCacheKey, serverCacheKey } from '../../shared/thumbnails/contract.ts';
import { fillThumbnailImage, getLiveObjectUrl, materializeThumbnailUrl, onThumbnailReady, serverThumbnailImageUrl } from '../thumbnails/client.ts';
import { getLocalThumbnail } from '../thumbnails/local-store.ts';
import { thumbnailState } from '../thumbnails/state.ts';

/** Covers stay decoded while rows are mounted; each surface owns its target lists. */
export function installLibraryThumbnails(lists: HTMLElement[], signal: AbortSignal) {
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
    for (const list of lists) {
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
  signal.addEventListener('abort', offThumbnails, {once:true});

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

  /** Once a cover slot exists, image errors stay invisible without shifting the row. */
  function makeThumbBox(key: string, url: string): HTMLElement {
    const box = document.createElement('div');
    box.className = 'source-thumb';
    box.setAttribute('aria-hidden', 'true');
    const img = document.createElement('img');
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.dataset.thumbKey = key;
    box.append(img);
    fillThumbnailImage(img, key, url.startsWith('blob:') ? undefined : url, { visibilityTarget: box, retainWhileHidden: true });
    return box;
  }

  /**
   * Unknown covers take no space: a row gets a box only when an image is available
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

  return {attach:attachThumb};
}
