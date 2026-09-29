// Async thumbnail pipeline. Detached from playback: failures only skip the
// thumbnail, never the load. Full frames are never queued — at most one extra
// candidate is held, with its own deadline independent of encode/store/upload.

import { THUMB_HOLD_MS, THUMB_MAX_BYTES, THUMB_MAX_EDGE } from './contract.ts';
import { thumbnailState } from './state.ts';
import { settleOffer } from './offer.ts';
import type { AcceptedOffer } from './offer.ts';
import { renderThumbnailCanvas } from '../presenter.ts';
import { putLocalThumbnail } from './local-store.ts';
import { publishLocalThumbnail, uploadThumbnail } from './client.ts';
import { log } from '../log.ts';
import { encodeThumbnailCanvas } from './encode.ts';

let queueDepth = 0;
const MAX_QUEUE_DEPTH = 3;

/** Fire-and-forget from the session hook; never rejects. */
export function runThumbnailTask(accepted: AcceptedOffer): void {
  if (queueDepth >= MAX_QUEUE_DEPTH) {
    thumbnailState.skip('budget:queue-depth');
    accepted.release();
    settleOffer(accepted.context.cacheKey, false);
    return;
  }
  queueDepth++;
  // Independent bounded jobs: a stalled upload cannot retain the next frame.
  setTimeout(() => { void execute(accepted).catch(() => {}).finally(() => { queueDepth--; }); }, 0);
}

async function execute(accepted: AcceptedOffer): Promise<void> {
  const { owned, context, acceptedAt } = accepted;
  const key = context.cacheKey;
  let settled = false;
  const releaseOwned = accepted.release;
  const settle = (completed: boolean) => {
    if (settled) return;
    settled = true;
    releaseOwned();
    settleOffer(key, completed);
  };
  try {
    if (accepted.expired || Date.now() - acceptedAt >= THUMB_HOLD_MS) {
      thumbnailState.skip('budget:hold-timeout');
      settle(false);
      return;
    }
    const renderStart = performance.now();
    const rendered = owned.kind === 'video-sample'
      ? await encodeSample(accepted)
      : await encodePixels(accepted);
    releaseOwned();
    if (!rendered) {
      thumbnailState.skip('unsupported:render');
      log.debug('media', '首帧缩图未渲染', { kind: owned.kind, width: owned.width, height: owned.height, sourcePtsUs: context.sourcePtsUs });
      settle(false);
      return;
    }
    thumbnailState.rendered++;
    log.debug('media', '首帧缩图渲染完成', {
      key: key.slice(0, 48), width: rendered.width, height: rendered.height,
      renderMs: Math.round((performance.now() - renderStart) * 10) / 10,
    });
    const blob = rendered.blob;
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

async function encodeSample(accepted: AcceptedOffer) {
  const rendered = renderThumbnailCanvas(accepted.owned, THUMB_MAX_EDGE);
  accepted.release();
  if (!rendered) return null;
  const blob = await encodeThumbnailCanvas(rendered.canvas);
  return { ...rendered, blob };
}

function encodePixels(accepted: AcceptedOffer): Promise<{ width: number; height: number; blob: Blob } | null> {
  if (typeof Worker === 'undefined') return Promise.resolve(null);
  return new Promise(resolve => {
    const worker = new Worker(new URL('./pixel-worker.ts', import.meta.url), { type: 'module' });
    let done = false;
    const finish = (result: { width: number; height: number; blob: Blob } | null) => {
      if (done) return;
      done = true; worker.terminate(); accepted.onExpire = undefined; resolve(result);
    };
    accepted.onExpire = () => finish(null);
    worker.onerror = () => finish(null);
    worker.onmessage = event => {
      const value = event.data;
      finish(value ? { width: value.width, height: value.height, blob: new Blob([value.bytes], { type: 'image/jpeg' }) } : null);
    };
    const { description, kind, width, height, rotation, pixels } = accepted.owned;
    try {
      worker.postMessage({ description, kind, width, height, rotation, pixels }, [pixels!.buffer as ArrayBuffer]);
    } catch { finish(null); }
  });
}
