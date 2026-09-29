// Disposable, single-job CPU executor. It never receives media URLs or decoders.
import { renderThumbnailCanvas } from '../presenter.ts';
import type { DecodedFrame } from '../media.ts';
import { THUMB_MAX_EDGE } from './contract.ts';
import { encodeThumbnailCanvas } from './encode.ts';

self.onmessage = async event => {
  try {
    const rendered = renderThumbnailCanvas(event.data as DecodedFrame, THUMB_MAX_EDGE);
    // Drop the transferred full frame before asynchronous JPEG encoding.
    event.data.pixels = undefined;
    if (!rendered) { self.postMessage(null); return; }
    const canvas = rendered.canvas as OffscreenCanvas;
    const blob = await encodeThumbnailCanvas(canvas);
    if (!blob) { self.postMessage(null); return; }
    const bytes = await blob.arrayBuffer();
    self.postMessage({ bytes, width: rendered.width, height: rendered.height }, { transfer: [bytes] });
  } catch { self.postMessage(null); }
};
