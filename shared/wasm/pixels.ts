import { MediaOpenError } from '../media/io/media-errors.ts';

/** Copy visible row bytes directly between independently owned memories. Source
 * rows may run backwards; padding is neither copied nor read out of bounds. */
export function copyPixelPlane(source: Uint8Array, pointer: number, stride: number,
  target: Uint8Array, offset: number, targetStride: number, rowBytes: number, height: number): void {
  const last = pointer + (height - 1) * stride, end = offset + (height - 1) * targetStride + rowBytes;
  if (![pointer,stride,offset,targetStride,rowBytes,height,last,end].every(Number.isSafeInteger) ||
    rowBytes < 1 || height < 1 || Math.abs(stride) < rowBytes || targetStride < rowBytes ||
    Math.min(pointer,last) < 0 || Math.max(pointer,last) + rowBytes > source.byteLength || offset < 0 || end > target.byteLength) {
    throw new MediaOpenError('decode', 'WASM 像素平面范围或行跨度无效。');
  }
  if (stride === rowBytes && targetStride === rowBytes) {
    target.set(source.subarray(pointer, pointer + rowBytes * height), offset);
    return;
  }
  for (let y = 0; y < height; y++) {
    const start = pointer + y * stride;
    target.set(source.subarray(start, start + rowBytes), offset + y * targetStride);
  }
}
