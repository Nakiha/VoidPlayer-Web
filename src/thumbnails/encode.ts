// One JPEG encoder contract for every thumbnail input kind and execution context.
import {
  THUMB_JPEG_QUALITY, THUMB_JPEG_FALLBACK_QUALITY, THUMB_MAX_BYTES,
} from './contract.ts';

export type ThumbnailCanvas = OffscreenCanvas | HTMLCanvasElement;

export async function encodeThumbnailCanvas(canvas: ThumbnailCanvas): Promise<Blob | null> {
  let blob = await canvasToJpeg(canvas, THUMB_JPEG_QUALITY);
  if (blob && blob.size > THUMB_MAX_BYTES) {
    blob = await canvasToJpeg(canvas, THUMB_JPEG_FALLBACK_QUALITY);
  }
  return blob && blob.size > 0 ? blob : null;
}

async function canvasToJpeg(canvas: ThumbnailCanvas, quality: number): Promise<Blob | null> {
  try {
    if (typeof (canvas as OffscreenCanvas).convertToBlob === 'function') {
      return await (canvas as OffscreenCanvas).convertToBlob({ type: 'image/jpeg', quality });
    }
    const element = canvas as HTMLCanvasElement;
    if (typeof element.toBlob !== 'function') return null;
    // Async toBlob only; sync toDataURL is never the default.
    return await new Promise<Blob | null>(resolve => {
      try { element.toBlob(result => resolve(result), 'image/jpeg', quality); }
      catch { resolve(null); }
    });
  } catch { return null; }
}
