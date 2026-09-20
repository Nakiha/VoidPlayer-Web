// Disposable, single-job CPU executor. It never receives media URLs or decoders.
import { renderThumbnailCanvas } from '../presenter.ts';
import type { DecodedFrame } from '../media.ts';
import { THUMB_MAX_EDGE, THUMB_MAX_BYTES, THUMB_JPEG_QUALITY, THUMB_JPEG_FALLBACK_QUALITY } from './contract.ts';

self.onmessage = async event => {
  try {
    const rendered = renderThumbnailCanvas(event.data as DecodedFrame, THUMB_MAX_EDGE);
    // Drop the transferred full frame before asynchronous JPEG encoding.
    event.data.pixels = undefined;
    if (!rendered) { self.postMessage(null); return; }
    const canvas = rendered.canvas as OffscreenCanvas;
    let blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: THUMB_JPEG_QUALITY });
    if (blob.size > THUMB_MAX_BYTES) blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: THUMB_JPEG_FALLBACK_QUALITY });
    const bytes = await blob.arrayBuffer();
    self.postMessage({ bytes, width: rendered.width, height: rendered.height }, { transfer: [bytes] });
  } catch { self.postMessage(null); }
};
