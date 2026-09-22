import { ThumbnailUrlCache } from './url-cache.ts';
// Thumbnail network + display client. Queries and uploads run beside media
// opening, never ahead of it: prefetch is fire-and-forget, uploads use the
// epoch frozen at accept time and are never retried with a fresh epoch.

import {
  THUMB_RECIPE_VERSION, THUMB_MAX_PENDING_UPLOADS, THUMB_MAX_PENDING_UPLOAD_BYTES,
  THUMB_STATUS_TIMEOUT_MS, serverCacheKey, thumbnailImageUrl, thumbnailStatusUrl,
} from './contract.ts';
import { thumbnailState } from './state.ts';
import { getLocalThumbnail } from './local-store.ts';

export interface ThumbnailStatus {
  state: 'ready' | 'missing';
  epoch?: number;
  url?: string;
  width?: number;
  height?: number;
}

const objectUrls = new ThumbnailUrlCache();
const images = new Map<HTMLImageElement, { key: string; serverUrl?: string; url?: string; visible: boolean }>();
let imageObserver: IntersectionObserver | undefined;
let mutationObserver: MutationObserver | undefined;
function observeImage(img: HTMLImageElement, key: string, serverUrl?: string) {
  const previous = images.get(img);
  if (previous && previous.key === key) { previous.serverUrl = serverUrl; return; }
  if (previous?.url) objectUrls.release(previous.url);
  images.set(img, { key, serverUrl, visible: true });
  imageObserver ??= typeof IntersectionObserver === 'undefined' ? undefined : new IntersectionObserver(entries => {
    for (const entry of entries) {
      const image = entry.target as HTMLImageElement, record = images.get(image);
      if (!record) continue;
      record.visible = entry.isIntersecting;
      if (record.visible) fillThumbnailImage(image, record.key, record.serverUrl);
      else {
        if (record.url) objectUrls.release(record.url);
        record.url = undefined; image.removeAttribute('src'); image.dataset.thumbSrc = '';
      }
    }
  }, { rootMargin: '100px' });
  imageObserver?.observe(img);
  if (!mutationObserver && typeof MutationObserver !== 'undefined') {
    mutationObserver = new MutationObserver(() => {
      for (const [image, record] of images) if (!image.isConnected) {
        if (record.url) objectUrls.release(record.url);
        imageObserver?.unobserve(image); images.delete(image);
      }
      objectUrls.trim();
    });
    mutationObserver.observe(document.documentElement, { childList: true, subtree: true });
  }
}
function showObjectUrl(img: HTMLImageElement, url: string) {
  const record = images.get(img);
  if (!record?.visible) return;
  if (record.url !== url) {
    objectUrls.retain(url);
    if (record.url) objectUrls.release(record.url);
    record.url = url;
  }
  img.dataset.thumbSrc = url; img.src = url;
}

const listeners = new Set<(key: string) => void>();
const statusInFlight = new Map<string, Promise<void>>();

/** Subscribe to per-key completion; only the matching row patches, no rerender. */
export function onThumbnailReady(listener: (key: string) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function notifyThumbnailReady(key: string) {
  for (const listener of [...listeners]) {
    try { listener(key); } catch { /* A row patch must not break siblings. */ }
  }
}

export function getLiveObjectUrl(key: string): string | undefined {
  return objectUrls.get(key);
}

function trackObjectUrl(key: string, blob: Blob): string {
  const url = objectUrls.put(key, blob);
  // Give synchronous row listeners a chance to acquire the newly published URL.
  queueMicrotask(() => objectUrls.trim());
  return url;
}

/** Track an object URL without notifying: IDB-backed display for this page. */
export function materializeThumbnailUrl(key: string, blob: Blob): string {
  return trackObjectUrl(key, blob);
}

/** Called after a Blob is stored locally: publish an ephemeral display URL. */
export function publishLocalThumbnail(key: string, blob: Blob): string {
  const url = trackObjectUrl(key, blob);
  notifyThumbnailReady(key);
  return url;
}

export function releaseThumbnailUrls() {
  imageObserver?.disconnect(); mutationObserver?.disconnect();
  imageObserver = undefined; mutationObserver = undefined; images.clear();
  objectUrls.clear();
}

async function readStatus(libraryId: string, mediaVersion: string): Promise<ThumbnailStatus | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('缩略图状态查询超时。', 'AbortError')), THUMB_STATUS_TIMEOUT_MS);
  try {
    const response = await fetch(thumbnailStatusUrl(libraryId, mediaVersion), { cache: 'no-store', signal: controller.signal });
    if (!response.ok) return null;
    const value = (await response.json()) as ThumbnailStatus;
    if (value?.state !== 'ready' && value?.state !== 'missing') return null;
    return value;
  } catch { return null; }
  finally { clearTimeout(timer); }
}

/** Parallel, bounded, never throws; warms the frozen-epoch cache. */
export function prefetchThumbnailStatus(libraryId: string, mediaVersion: string | undefined): void {
  if (!libraryId || !mediaVersion) return;
  const key = serverCacheKey({ mediaId: libraryId, mediaVersion });
  if (statusInFlight.has(key)) return;
  const work = readStatus(libraryId, mediaVersion)
    .then(status => {
      if (status) {
        const wasReady = thumbnailState.statusCache.get(key)?.ready;
        thumbnailState.rememberStatus(key, { ready: status.state === 'ready', epoch: status.epoch, width: status.width, height: status.height });
        // Server readiness arrives after rows render imageless. Notify so the
        // placeholder <img> patches in place instead of waiting for an
        // unrelated full-list rebuild (which would flash).
        if (status.state === 'ready' && !wasReady) notifyThumbnailReady(key);
      }
    })
    .catch(() => {})
    .finally(() => { statusInFlight.delete(key); });
  statusInFlight.set(key, work);
}

/** Warm a visible page of entries; bounded count, each request bounded. */
export function prefetchThumbnailStatuses(entries: { id: string; version?: string }[], limit = 60): void {
  let started = 0;
  for (const entry of entries) {
    if (started >= limit) break;
    if (!entry.version) continue;
    // Skip keys with a fresh status to avoid refetching on every repaint.
    const key = serverCacheKey({ mediaId: entry.id, mediaVersion: entry.version });
    const cached = thumbnailState.statusCache.get(key);
    if (cached && Date.now() - cached.at < 5 * 60 * 1000) continue;
    started++;
    prefetchThumbnailStatus(entry.id, entry.version);
  }
}

export interface ThumbnailUpload {
  libraryId: string;
  mediaVersion: string;
  recipe?: string;
  /** Frozen at accept; the server rejects stale epochs, no refresh+retry. */
  epoch: number;
  blob: Blob;
  width: number;
  height: number;
  sourcePtsUs: number;
}

export type UploadOutcome = 'ok' | 'deduped' | 'conflict' | 'skipped' | 'error';

/** Upload one small JPEG. Never throws; conflicts are terminal for this image. */
export async function uploadThumbnail(upload: ThumbnailUpload): Promise<UploadOutcome> {
  const { libraryId, mediaVersion, epoch, blob, width, height, sourcePtsUs } = upload;
  const recipe = upload.recipe ?? THUMB_RECIPE_VERSION;
  if (thumbnailState.pendingUploads >= THUMB_MAX_PENDING_UPLOADS ||
    thumbnailState.pendingUploadBytes + blob.size > THUMB_MAX_PENDING_UPLOAD_BYTES) {
    thumbnailState.skip('budget:upload-queue');
    return 'skipped';
  }
  thumbnailState.pendingUploads++;
  thumbnailState.pendingUploadBytes += blob.size;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('缩略图上传超时。', 'AbortError')), THUMB_STATUS_TIMEOUT_MS * 2);
  try {
    const url = `/api/media/${encodeURIComponent(libraryId)}/thumbnail` +
      `?v=${encodeURIComponent(mediaVersion)}&recipe=${encodeURIComponent(recipe)}` +
      `&epoch=${encodeURIComponent(String(epoch))}&w=${width}&h=${height}&pts=${sourcePtsUs}`;
    const response = await fetch(url, {
      method: 'POST', body: blob, cache: 'no-store', signal: controller.signal,
      headers: { 'content-type': 'image/jpeg', 'x-voidplayer-action': 'thumbnail' },
    });
    if (response.status === 201) { thumbnailState.uploaded++; return 'ok'; }
    if (response.status === 200) return 'deduped';
    if (response.status === 409) { thumbnailState.skip('conflict:epoch-version'); return 'conflict'; }
    thumbnailState.skip(`upload:http-${response.status}`);
    return 'error';
  } catch {
    thumbnailState.skip('upload:network');
    return 'error';
  } finally {
    clearTimeout(timer);
    thumbnailState.pendingUploads--;
    thumbnailState.pendingUploadBytes -= blob.size;
  }
}

/**
 * Fill an <img> for a cache key: live object URL first, stored Blob second,
 * optional server URL when the entry is known ready. Callers keep a fixed-size
 * placeholder so late fills never shift layout. Patches only when the element
 * still shows the same key. Single-write: server and local never both assign,
 * so the image does not flash server -> local on every first render.
 */
export function fillThumbnailImage(img: HTMLImageElement, key: string, serverUrl?: string): void {
  observeImage(img, key, serverUrl);
  if (!images.get(img)?.visible) return;
  if (img.dataset.thumbKey === key && img.dataset.thumbSrc && (
    img.dataset.thumbSrc === objectUrls.get(key) ||
    (serverUrl && img.dataset.thumbSrc === serverUrl)
  )) return;
  img.dataset.thumbKey = key;
  const live = objectUrls.get(key);
  if (live) {
    img.dataset.thumbSrc = live;
    img.decoding = 'async';
    showObjectUrl(img, live);
    return;
  }
  if (serverUrl) {
    // Known-ready server image: direct load, async decode, no extra probing.
    // Local fallback happens only if the server image fails.
    img.dataset.thumbSrc = serverUrl;
    img.decoding = 'async';
    img.onerror = () => {
      if (img.dataset.thumbKey !== key || !img.isConnected || !images.get(img)?.visible) return;
      void getLocalThumbnail(key).then(stored => {
        if (img.dataset.thumbKey !== key || !img.isConnected || !images.get(img)?.visible) return;
        if (!stored) {
          // Both server and local failed: keep the fixed-size empty slot
          // instead of a broken-image icon.
          img.removeAttribute('src');
          img.dataset.thumbSrc = '';
          return;
        }
        const currentLive = objectUrls.get(key);
        const url = currentLive ?? trackObjectUrl(key, stored.blob);
        if (img.dataset.thumbSrc === url) return;
        img.onerror = null; showObjectUrl(img, url);
      });
    };
    if (img.getAttribute('src') !== serverUrl) img.src = serverUrl;
    return;
  }
  void getLocalThumbnail(key).then(stored => {
    if (!stored || img.dataset.thumbKey !== key || !img.isConnected || !images.get(img)?.visible) return;
    if (objectUrls.get(key)) {
      const currentLive = objectUrls.get(key)!;
      if (img.dataset.thumbSrc === currentLive) return;
      showObjectUrl(img, currentLive);
      return;
    }
    const url = trackObjectUrl(key, stored.blob);
    if (img.dataset.thumbSrc === url) return;
    showObjectUrl(img, url);
  });
}

/** Direct server image URL for a ready library entry. */
export function serverThumbnailImageUrl(libraryId: string, mediaVersion: string): string {
  return thumbnailImageUrl(libraryId, mediaVersion);
}
