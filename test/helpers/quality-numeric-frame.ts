import type { PsnrFrame } from '../../shared/analysis/quality/psnr.ts';
import { rgbaDescription } from '../../shared/media/frame-description.ts';

export function frame(depth: 8 | 10 = 8, options: { width?: number; height?: number; codedWidth?: number; codedHeight?: number;
  cropX?: number; cropY?: number; padding?: number; byteOffset?: number; value?: (c: number, x: number, y: number) => number } = {}): PsnrFrame {
  const width = options.width ?? 4, height = options.height ?? 4, cw = options.codedWidth ?? width, ch = options.codedHeight ?? height;
  const bytes = depth === 8 ? 1 : 2;
  let length = 0;
  const planes = Array.from({ length: 3 }, (_, c) => {
    const w = cw / (c ? 2 : 1), h = ch / (c ? 2 : 1), stride = w * bytes + (options.padding ?? 0);
    const plane = { offset: length, stride, width: w, height: h }; length += stride * h; return plane;
  });
  const storage = new ArrayBuffer(length + (options.byteOffset ?? 0)), pixels = new Uint8Array(storage, options.byteOffset ?? 0, length);
  pixels.fill(0xda);
  for (let c = 0; c < 3; c++) for (let y = 0; y < planes[c].height; y++) for (let x = 0; x < planes[c].width; x++) {
    const value = options.value?.(c, x, y) ?? 16, i = planes[c].offset + y * planes[c].stride + x * bytes;
    pixels[i] = value & 255; if (bytes === 2) pixels[i + 1] = value >> 8;
  }
  return { pixels, description: rgbaDescription(width, height, { codedWidth: cw, codedHeight: ch,
    visibleRect: { x: options.cropX ?? 0, y: options.cropY ?? 0, width, height }, format: 'YUV', stride: null, byteLength: length,
    color: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false },
    yuv: { bitDepth: depth, bitShift: 0, subsampleX: 1, subsampleY: 1, semiplanar: false, chromaLocation: 1, planes } }) };
}
