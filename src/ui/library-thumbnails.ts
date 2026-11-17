import type { SourceItem } from './source-catalog.ts';
import { localCacheKey, serverCacheKey, thumbnailImageUrl } from '../../shared/thumbnails/contract.ts';
import { fillThumbnailImage, getLiveObjectUrl, materializeThumbnailUrl, onThumbnailReady } from '../thumbnails/client.ts';
import { getLocalThumbnail } from '../thumbnails/local-store.ts';

/** Covers stay decoded while rows are mounted; each surface owns its target lists. */
export function installLibraryThumbnails(lists: HTMLElement[], signal: AbortSignal) {
  const patchThumbnails = (key: string) => {
    const url = getLiveObjectUrl(key);
    if (!url) return;
    for (const list of lists) for (const row of list.querySelectorAll<HTMLElement>('[data-thumbnail-key]')) {
      if (row.dataset.thumbnailKey !== key || row.querySelector(':scope > .source-thumb')) continue;
      row.prepend(makeThumbBox(key,url));
    }
  };
  const offThumbnails = onThumbnailReady(patchThumbnails);
  signal.addEventListener('abort', offThumbnails, {once:true});

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
    if (!url.startsWith('blob:')) box.dataset.thumbPending = '';
    box.append(img);
    fillThumbnailImage(img, key, url.startsWith('blob:') ? undefined : url, { visibilityTarget: box, retainWhileHidden: true });
    return box;
  }

  function attachThumb(row: HTMLElement, item: SourceItem) {
    const id = item.library?.id ?? item.libraryId;
    const version = item.library?.version ?? item.version;
    if (id) {
      if (item.library?.storage === 'provider' || !version || (item.library?.state && item.library.state!=='ready')) return;
      const key = serverCacheKey({mediaId:id,mediaVersion:version});
      row.dataset.thumbnailKey = key;
      row.prepend(makeThumbBox(key,thumbnailImageUrl(id,version)));
      return;
    }
    const key = localCacheKey(item.name,item.size,item.lastModified);
    row.dataset.thumbnailKey = key;
    const live = getLiveObjectUrl(key);
    if (live) {row.prepend(makeThumbBox(key,live));return;}
    void getLocalThumbnail(key).then(stored => {
      if (!stored || !row.isConnected || row.querySelector(':scope > .source-thumb')) return;
      row.prepend(makeThumbBox(key, materializeThumbnailUrl(key, stored.blob)));
    });
  }

  return {attach:attachThumb};
}
