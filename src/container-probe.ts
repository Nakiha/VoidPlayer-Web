import { RangeReader } from './range-reader.ts';
import type { RandomAccessInput } from './range-reader.ts';
import { loadAborted, onLoadAbort } from './media-abort.ts';

export type ContainerKind = 'flv' | 'isobmff' | 'mpegts' | 'other';
/** Routing hint, not validation: the selected demuxer still validates input.
 * No extension dispatch and no decoder initialization to recognize a format. */
export function containerFromHeader(bytes: Uint8Array): ContainerKind {
  if (bytes[0] === 70 && bytes[1] === 76 && bytes[2] === 86) return 'flv';
  if (bytes.length >= 8) {
    const box = String.fromCharCode(...bytes.subarray(4, 8));
    const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
    if ((size === 0 || size === 1 || size >= 8) && ['ftyp', 'styp', 'moov', 'mdat', 'free', 'wide', 'skip'].includes(box)) return 'isobmff';
  }
  // TS, M2TS and protected 204-byte transport packets. Three sync bytes
  // avoid mistaking an arbitrary initial 0x47 for an entire container.
  for (const [stride, start] of [[188, 0], [192, 4], [204, 0]]) {
    if ([0, 1, 2].every(i => bytes[start + stride * i] === 0x47)) return 'mpegts';
  }
  return 'other';
}
export async function probeContainer(input: RandomAccessInput, signal?: AbortSignal): Promise<ContainerKind> {
  loadAborted(signal);
  const reader = new RangeReader(input, 4096), detach = onLoadAbort(signal, () => reader.close());
  try { const bytes = await reader.read(0, Math.min(reader.size, 1024)); loadAborted(signal); return containerFromHeader(bytes); }
  finally { detach(); reader.close(); }
}
