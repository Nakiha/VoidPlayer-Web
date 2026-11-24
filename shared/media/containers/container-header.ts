import { annexBCodec, probeAnnexBCodec, type ContainerProbeReader } from './annex-b-header.ts';

export type ContainerKind = 'annexb' | 'flv' | 'isobmff' | 'mpegts' | 'matroska' | 'other';
/** Routing hint, not validation: the selected demuxer still validates input.
 * No extension dispatch and no decoder initialization to recognize a format. */
export function containerFromHeader(bytes: Uint8Array): ContainerKind {
  if(bytes[0]===0x1a&&bytes[1]===0x45&&bytes[2]===0xdf&&bytes[3]===0xa3)return 'matroska';
  if (bytes[0] === 70 && bytes[1] === 76 && bytes[2] === 86) return 'flv';
  if (bytes.length >= 8) {
    const box = String.fromCharCode(...bytes.subarray(4, 8));
    const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
    if ((size === 0 || size === 1 || size >= 8) && ['ftyp', 'styp', 'moov', 'mdat', 'free', 'wide', 'skip'].includes(box)) return 'isobmff';
  }
  // TS, M2TS and protected 204-byte transport packets. Three sync bytes
  // avoid mistaking an arbitrary initial 0x47 for an entire container.
  for(const stride of [188,192,204])for(let start=0;start<stride&&start+stride*2<bytes.length;start++) {
    if([0,1,2].every(i=>bytes[start+stride*i]===0x47))return 'mpegts';
  }
  return annexBCodec(bytes) ? 'annexb' : 'other';
}

/** Keep the small fast path for ordinary containers. Only plausible Annex-B
 * prefixes continue into bounded reads to find delayed parameter sets. */
export async function readPlaybackContainer(reader: ContainerProbeReader, signal?: AbortSignal, header?: Uint8Array): Promise<ContainerKind> {
  signal?.throwIfAborted();
  const bytes = header ?? await reader.read(0, Math.min(reader.size, 1024));
  signal?.throwIfAborted();
  const kind = containerFromHeader(bytes);
  if (kind !== 'other') return kind;
  return await probeAnnexBCodec(reader, signal, bytes) ? 'annexb' : 'other';
}
