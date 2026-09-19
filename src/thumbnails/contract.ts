// Thumbnail contract: pure types, recipe and budget constants shared by the
// browser manager and the server store. This module must stay free of browser
// globals, player initialization and WASM loading side effects: the server
// imports it for key construction and JPEG validation.

/** First-frame selection + output geometry + color strategy, versioned. */
export const THUMB_RECIPE_VERSION = 'first-display-v1;edge384;q80;sdr-srgb-v1';
/** Single main video stream for phase 1; fixed and versioned. */
export const THUMB_STREAM_SELECTOR = 'main-v1';
/** Longest output edge in pixels; aspect preserved, never upscaled. */
export const THUMB_MAX_EDGE = 384;
/** Primary JPEG quality; one fallback step when over the byte cap. */
export const THUMB_JPEG_QUALITY = 0.8;
export const THUMB_JPEG_FALLBACK_QUALITY = 0.6;
/** Single-image output cap. */
export const THUMB_MAX_BYTES = 128 * 1024;
/** Largest full frame the thumbnail path may additionally hold. */
export const THUMB_FRAME_BUDGET_BYTES = 64 * 1024 * 1024;
/** How long an accepted full-frame candidate may wait for the serial slot. */
export const THUMB_HOLD_MS = 500;
/** Small-image upload queue caps (full frames are never queued). */
export const THUMB_MAX_PENDING_UPLOADS = 8;
export const THUMB_MAX_PENDING_UPLOAD_BYTES = 1024 * 1024;
/** Server-side logical capacity with accessed_at eviction. */
export const THUMB_CACHE_LIMIT_BYTES = 256 * 1024 * 1024;
/** Bounded network waits for status/upload; playback never waits on these. */
export const THUMB_STATUS_TIMEOUT_MS = 3000;
/** Server acceptance tolerance for decoded dimensions (recipe emits <=384). */
export const THUMB_MAX_DIM = 512;
export const THUMB_MIN_DIM = 1;
/** Hard cap for a POST body before JPEG parsing. */
export const THUMB_POST_BODY_MAX = 256 * 1024;

export type ThumbnailKind = 'library' | 'local';

export interface ServerThumbnailKey {
  mediaId: string;
  mediaVersion: string;
  streamSelector?: string;
  recipeVersion?: string;
}

/** Server cache key. Never uses session ids, slot letters or file names. */
export function serverCacheKey(key: ServerThumbnailKey): string {
  const stream = key.streamSelector ?? THUMB_STREAM_SELECTOR;
  const recipe = key.recipeVersion ?? THUMB_RECIPE_VERSION;
  return `v1|lib|${key.mediaId}|${key.mediaVersion}|${stream}|${recipe}`;
}

/** Local-file key: browser history association only, never uploaded. */
export function localCacheKey(name: string, size: number, lastModified: number): string {
  return `v1|local|${JSON.stringify([name, size, lastModified])}`;
}

export function thumbnailImageUrl(id: string, version: string, recipe = THUMB_RECIPE_VERSION): string {
  return `/api/media/${encodeURIComponent(id)}/thumbnail?v=${encodeURIComponent(version)}&recipe=${encodeURIComponent(recipe)}`;
}

export function thumbnailStatusUrl(id: string, version: string, recipe = THUMB_RECIPE_VERSION): string {
  return `/api/media/${encodeURIComponent(id)}/thumbnail-status?v=${encodeURIComponent(version)}&recipe=${encodeURIComponent(recipe)}`;
}

export function isProbablyJpeg(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9;
}

/**
 * Bounded JPEG dimension probe: scans markers for the first SOF, never a full
 * decode. Returns null for non-JPEG, truncated or hostile structures.
 */
export function parseJpegDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let pos = 2;
  // Hard iteration bound: structure check only, no pixel work.
  for (let markers = 0; markers < 64 && pos + 1 < bytes.length; markers++) {
    if (bytes[pos] !== 0xff) return null;
    // Skip padding.
    while (pos < bytes.length && bytes[pos] === 0xff) pos++;
    if (pos >= bytes.length) return null;
    const marker = bytes[pos++];
    // Standalone markers carry no length.
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      if (marker === 0xd9) return null; // EOI before any SOF.
      continue;
    }
    if (pos + 1 >= bytes.length) return null;
    const length = (bytes[pos] << 8) | bytes[pos + 1];
    if (length < 2 || pos + length > bytes.length) return null;
    const isSof = (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc);
    if (isSof) {
      if (length < 7 || pos + 7 > bytes.length) return null;
      const height = (bytes[pos + 3] << 8) | bytes[pos + 4];
      const width = (bytes[pos + 5] << 8) | bytes[pos + 6];
      if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)) return null;
      if (width < THUMB_MIN_DIM || height < THUMB_MIN_DIM || width > 65500 || height > 65500) return null;
      return { width, height };
    }
    pos += length;
  }
  return null;
}

/** Server-side acceptance check: real JPEG, sane dimensions, within byte cap. */
export function validateThumbnailImage(bytes: Uint8Array, claimedWidth: number, claimedHeight: number): { width: number; height: number } | { error: string } {
  if (bytes.length === 0 || bytes.length > THUMB_MAX_BYTES) return { error: '图片超过单张上限。' };
  const dims = parseJpegDimensions(bytes);
  if (!dims) return { error: '不是可识别的 JPEG 图片。' };
  if (dims.width > THUMB_MAX_DIM || dims.height > THUMB_MAX_DIM) return { error: '图片尺寸超出缩略图范围。' };
  if (dims.width !== claimedWidth || dims.height !== claimedHeight) return { error: '声明尺寸与图片实际尺寸不一致。' };
  return dims;
}
