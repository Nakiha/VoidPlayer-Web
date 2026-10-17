import { createHash } from 'node:crypto';
import type { FrameDescription } from '../../shared/media/frame-description.ts';
/** Compare full-precision visible samples across cropped and coded allocations.
 * Deliberately independent of presenter/color conversion and excludes padding. */
export function visiblePixelHash(description: FrameDescription, bytes: ArrayBuffer | Uint8Array | Uint8ClampedArray): string {
  const pixels = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
  const hash = createHash('sha256'), layout = description.yuv;
  hash.update(JSON.stringify([description.width, description.height, description.format,
    layout && [layout.bitDepth, layout.bitShift, layout.subsampleX, layout.subsampleY, layout.semiplanar]]));
  if (!layout) return hash.update(pixels).digest('hex');
  const crop = description.visibleRect;
  for (const [index, plane] of layout.planes.entries()) {
    const sx = index ? 2 ** layout.subsampleX : 1, sy = index ? 2 ** layout.subsampleY : 1;
    const bytesPerCell = (layout.bitDepth > 8 ? 2 : 1) * (index && layout.semiplanar ? 2 : 1);
    const left = Math.floor(crop.x / sx), right = Math.ceil((crop.x + crop.width) / sx);
    for (let row = Math.floor(crop.y / sy); row < Math.ceil((crop.y + crop.height) / sy); row++) {
      const start = plane.offset + row * plane.stride + left * bytesPerCell;
      hash.update(pixels.subarray(start, start + (right - left) * bytesPerCell));
    }
  }
  return hash.digest('hex');
}
