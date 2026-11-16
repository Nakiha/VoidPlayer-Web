import { ThumbnailUrlCache } from './url-cache.ts';
import { getLocalThumbnail } from './local-store.ts';

export type ThumbnailImageOptions = { visibilityTarget?: Element; retainWhileHidden?: boolean };

const objectUrls = new ThumbnailUrlCache();
const images = new Map<HTMLImageElement, { key: string; serverUrl?: string; url?: string; visible: boolean; target: Element; retainWhileHidden: boolean }>();
const imageTargets = new Map<Element, HTMLImageElement>();
let imageObserver: IntersectionObserver | undefined;
let mutationObserver: MutationObserver | undefined;
const preparedImages = new WeakSet<HTMLImageElement>();
function concealImage(img: HTMLImageElement) {
  img.style.visibility = 'hidden'; delete img.dataset.thumbDecoded;
}
function prepareImage(img: HTMLImageElement) {
  if (preparedImages.has(img)) return;
  preparedImages.add(img); concealImage(img);
  img.addEventListener('error', () => { if (!img.naturalWidth) concealImage(img); });
  img.addEventListener('load', () => {
    const source = img.getAttribute('src');
    if (!source) return;
    void img.decode().then(() => {
      if (!images.has(img) || img.getAttribute('src') !== source || !img.naturalWidth) return;
      img.parentElement?.removeAttribute('data-thumb-pending'); img.dataset.thumbDecoded = 'true'; img.style.visibility = '';
    }).catch(() => { if (img.getAttribute('src') === source) concealImage(img); });
  });
}
function assignImageUrl(img: HTMLImageElement, url: string) {
  if (img.getAttribute('src') === url) return;
  concealImage(img); img.src = url;
}
function observeImage(img: HTMLImageElement, key: string, serverUrl?: string, options?: ThumbnailImageOptions) {
  prepareImage(img);
  const previous = images.get(img), target = options?.visibilityTarget ?? previous?.target ?? img;
  const retainWhileHidden = options?.retainWhileHidden ?? previous?.retainWhileHidden ?? false;
  if (previous && previous.key === key && previous.target === target) {
    previous.serverUrl = serverUrl; previous.retainWhileHidden = retainWhileHidden; return;
  }
  if (previous) {
    if (previous.url) objectUrls.release(previous.url);
    imageObserver?.unobserve(previous.target);
    imageTargets.delete(previous.target);
  }
  images.set(img, { key, serverUrl, visible: !serverUrl || typeof IntersectionObserver === 'undefined', target, retainWhileHidden });
  imageTargets.set(target, img);
  imageObserver ??= typeof IntersectionObserver === 'undefined' ? undefined : new IntersectionObserver(entries => {
    for (const entry of entries) {
      const image = imageTargets.get(entry.target);
      if (!image) continue;
      const record = images.get(image);
      if (!record) continue;
      record.visible = entry.isIntersecting;
      if (record.visible) fillThumbnailImage(image, record.key, record.serverUrl);
      else if (!record.retainWhileHidden) {
        if (record.url) objectUrls.release(record.url);
        record.url = undefined; concealImage(image); image.removeAttribute('src'); image.dataset.thumbSrc = '';
      }
    }
  }, { rootMargin: '100px' });
  imageObserver?.observe(target);
  if (!mutationObserver && typeof MutationObserver !== 'undefined') {
    mutationObserver = new MutationObserver(() => {
      for (const [image, record] of images) if (!image.isConnected) {
        if (record.url) objectUrls.release(record.url);
        imageObserver?.unobserve(record.target);
        imageTargets.delete(record.target);
        images.delete(image);
        concealImage(image); image.removeAttribute('src'); image.dataset.thumbSrc = '';
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
  img.dataset.thumbSrc = url; assignImageUrl(img, url);
}

const listeners = new Set<(key: string) => void>();

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
  imageObserver = undefined; mutationObserver = undefined; images.clear(); imageTargets.clear();
  objectUrls.clear();
}

export function fillThumbnailImage(img: HTMLImageElement, key: string, serverUrl?: string, options?: ThumbnailImageOptions): void {
  observeImage(img, key, serverUrl, options);
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
    img.dataset.thumbSrc = serverUrl;
    img.onerror = () => {
      // Retry on re-entry, with one delayed retry for a busy server while still visible.
      img.dataset.thumbSrc = '';
      img.removeAttribute('src');
      if (img.dataset.thumbRetry) return;
      img.dataset.thumbRetry = 'true';
      setTimeout(() => {
        if (images.get(img)?.visible && img.isConnected && !img.hasAttribute('src')) fillThumbnailImage(img,key,serverUrl);
      },3000);
    };
    assignImageUrl(img, serverUrl);
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
