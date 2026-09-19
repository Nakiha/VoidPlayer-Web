// Async thumbnail pipeline. Detached from playback: failures only skip the
// thumbnail, never the load. Full frames are never queued — at most one extra
// candidate is held, and only until the serial slot starts it.

import {
  THUMB_HOLD_MS, THUMB_JPEG_QUALITY, THUMB_JPEG_FALLBACK_QUALITY,
  THUMB_MAX_BYTES, THUMB_MAX_EDGE,
} from './contract.ts';
import { thumbnailState } from './state.ts';
import { settleOffer } from './offer.ts';
import type { AcceptedOffer } from './offer.ts';
import { renderThumbnailCanvas } from '../presenter.ts';
import { putLocalThumbnail } from './local-store.ts';
import { publishLocalThumbnail, uploadThumbnail } from './client.ts';
import { log } from '../log.ts';

let tail: Promise<void> = Promise.resolve();
let queueDepth = 0;
const MAX_QUEUE_DEPTH = 3;

async function canvasToJpeg(canvas: OffscreenCanvas | HTMLCanvasElement, quality: number): Promise<Blob | null> {
  try {
    if (typeof (canvas as OffscreenCanvas).convertToBlob === 'function') {
      const blob = await (canvas as OffscreenCanvas).convertToBlob({ type: 'image/jpeg', quality });
      return blob && blob.size > 0 ? blob : null;
    }
    const element = canvas as HTMLCanvasElement;
    if (typeof element.toBlob !== 'function') return null;
    // Async toBlob only; the sync toDataURL path is never the default.
    return await new Promise<Blob | null>(resolve => {
      try {
        element.toBlob(result => resolve(result), 'image/jpeg', quality);
      } catch { resolve(null); }
    });
  } catch { return null; }
}

/** Fire-and-forget from the session hook; never rejects. */
export function runThumbnailTask(accepted: AcceptedOffer): void {
  if (queueDepth >= MAX_QUEUE_DEPTH) {
    thumbnailState.skip('budget:queue-depth');
    try { accepted.owned.close(); } catch {}
    settleOffer(accepted.context.cacheKey, false);
    return;
  }
  queueDepth++;
  tail = tail
    .then(() => execute(accepted))
    .catch(() => {})
    .finally(() => { queueDepth--; });
}

async function execute(accepted: AcceptedOffer): Promise<void> {
  const { owned, context, acceptedAt } = accepted;
  const key = context.cacheKey;
  let ownedReleased = false;
  let settled = false;
  const releaseOwned = () => {
    if (ownedReleased) return;
    ownedReleased = true;
    thumbnailState.holdingFull = false;
    try { owned.close(); } catch {}
  };
  const settle = (completed: boolean) => {
    if (settled) return;
    settled = true;
    releaseOwned();
    settleOffer(key, completed);
  };
  try {
    if (Date.now() - acceptedAt > THUMB_HOLD_MS) {
      thumbnailState.skip('budget:hold-timeout');
      settle(false);
      return;
    }
    const renderStart = performance.now();
    const rendered = renderThumbnailCanvas(owned, THUMB_MAX_EDGE);
    // The full frame is released immediately after the small render; only the
    // small target survives for encode and upload.
    releaseOwned();
    if (!rendered) {
      thumbnailState.skip('unsupported:render');
      settle(false);
      return;
    }
    thumbnailState.rendered++;
    log.debug('media', '首帧缩图渲染完成', {
      key: key.slice(0, 48), width: rendered.width, height: rendered.height,
      renderMs: Math.round((performance.now() - renderStart) * 10) / 10,
    });
    let blob = await canvasToJpeg(rendered.canvas, THUMB_JPEG_QUALITY);
    if (blob && blob.size > THUMB_MAX_BYTES) {
      blob = await canvasToJpeg(rendered.canvas, THUMB_JPEG_FALLBACK_QUALITY);
    }
    if (!blob || blob.size === 0 || blob.size > THUMB_MAX_BYTES) {
      thumbnailState.skip(!blob || blob.size === 0 ? 'encode:failed' : 'budget:encode-bytes');
      settle(false);
      return;
    }
    const record = {
      key, blob, width: rendered.width, height: rendered.height,
      sourcePtsUs: context.sourcePtsUs, updatedAt: Date.now(),
    };
    // Local artifact first: instant display even when the server is slow,
    // offline or refusing writes. A late encode still cleans up its own
    // resources here; nothing is left for a timeout to forget.
    await putLocalThumbnail(record);
    publishLocalThumbnail(key, blob);
    settle(true);
    if (context.kind === 'library' && context.libraryId && context.mediaVersion && context.epoch !== undefined) {
      // The epoch was frozen at accept; a 409 conflict ends this image.
      // Never fetch a fresh epoch to re-upload the same bytes.
      await uploadThumbnail({
        libraryId: context.libraryId, mediaVersion: context.mediaVersion,
        epoch: context.epoch, blob,
        width: rendered.width, height: rendered.height, sourcePtsUs: context.sourcePtsUs,
      });
    } else if (context.kind === 'library') {
      thumbnailState.skip('upload:no-epoch-or-version');
    }
  } catch (error) {
    log.debug('media', '缩略图任务跳过', { key: key.slice(0, 48), error: error instanceof Error ? error.message : String(error) });
    settle(false);
  }
}
