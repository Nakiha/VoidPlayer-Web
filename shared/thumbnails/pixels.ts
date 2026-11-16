import type { FrameDescription } from '../media/frame-description.ts';
import { resolveYuvColor, yuvPixelRgb } from '../color/yuv-color.ts';
import { HDR_PREVIEW_POLICY } from '../color/hdr-policy.ts';
import { THUMB_MAX_EDGE } from './contract.ts';

export function thumbnailSize(d: FrameDescription, rotation: number, maxEdge = THUMB_MAX_EDGE) {
  const swapped = rotation === 90 || rotation === 270;
  const w = d.displayWidth ?? d.width, h = d.displayHeight ?? d.height;
  const scale = Math.min(1, maxEdge / Math.max(w,h));
  return {width:Math.max(1,Math.round((swapped?h:w)*scale)),height:Math.max(1,Math.round((swapped?w:h)*scale))};
}

/** Bilinear downsample to a rotated, display-aspect-correct SDR preview. */
export function thumbnailPixels(d: FrameDescription, pixels: Uint8Array | Uint8ClampedArray, rotation: number, width: number, height: number) {
  const swapped = rotation === 90 || rotation === 270;
  const smallW = swapped ? height : width, smallH = swapped ? width : height;
  const view = new Uint8ClampedArray(width * height * 4);
  const plan = d.yuv ? resolveYuvColor(d) : undefined;
  if(plan?.hdr)plan.hdrPolicy=HDR_PREVIEW_POLICY;
  const rgbAt = (x: number, y: number) => {
    if (d.yuv) return yuvPixelRgb(d,pixels,x,y,plan);
    const offset = (y * d.width + x) * 4;
    return pixels.subarray(offset, offset + 4);
  };
  // Bilinear source sampling matches the presentation downscale rule.
  for (let y = 0; y < smallH; y++) for (let x = 0; x < smallW; x++) {
    const sx = Math.max(0, Math.min(d.width - 1, (x + .5) * d.width / smallW - .5));
    const sy = Math.max(0, Math.min(d.height - 1, (y + .5) * d.height / smallH - .5));
    const x0 = Math.floor(sx), y0 = Math.floor(sy), wx = sx - x0, wy = sy - y0;
    const x1 = Math.min(d.width - 1, x0 + 1), y1 = Math.min(d.height - 1, y0 + 1);
    const dx = rotation === 90 ? width - 1 - y : rotation === 180 ? width - 1 - x : rotation === 270 ? y : x;
    const dy = rotation === 90 ? x : rotation === 180 ? height - 1 - y : rotation === 270 ? height - 1 - x : y;
    const i = (dy * width + dx) * 4;
    const a = rgbAt(x0,y0);
    if (plan) view[i+3] = 255;
    if (!wx && !wy) { view.set(a,i);continue; }
    const b = wx ? rgbAt(x1,y0) : a, c = wy ? rgbAt(x0,y1) : a, e = wx && wy ? rgbAt(x1,y1) : wx ? b : c;
    for (let channel = 0; channel < a.length; channel++) {
      view[i + channel] = (a[channel] * (1 - wx) + b[channel] * wx) * (1 - wy)
        + (c[channel] * (1 - wx) + e[channel] * wx) * wy;
    }
  }
  return view;
}
