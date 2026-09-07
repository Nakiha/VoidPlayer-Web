import { buildFlvIndex, flvDecoderConfig } from './flv-demux.ts';
import type { FlvCodec, FlvIndex } from './flv-demux.ts';

export const FLV_INDEX_SCHEMA = 1;
export const FLV_INDEX_BYTES = 32 * 1024 * 1024;
export interface FlvIndexDocument {
  schema: number; size: number; codec: FlvCodec; description: number[];
  packets: [number, number, number, number, number][];
}
export function serializeFlvIndex(index: FlvIndex, size: number): FlvIndexDocument {
  return { schema: FLV_INDEX_SCHEMA, size, codec: index.codec, description: [...index.description],
    packets: index.packets.map(p => [p.offset, p.size, p.pts, p.dts, +p.key]) };
}
/** Derived timing/order is always rebuilt, never trusted from a cache upload. */
export function parseFlvIndex(value: unknown, size: number): FlvIndex {
  const doc = value as FlvIndexDocument | null;
  const bad = (): never => { throw new Error('FLV 帧索引格式或范围无效。'); };
  if (!doc || doc.schema !== FLV_INDEX_SCHEMA || doc.size !== size || !['h264', 'hevc', 'av1', 'vvc'].includes(doc.codec)
    || !Array.isArray(doc.description) || !doc.description.length || doc.description.length > 1024 * 1024
    || doc.description.some(b => !Number.isInteger(b) || b < 0 || b > 255)
    || !Array.isArray(doc.packets) || !doc.packets.length || doc.packets.length > 2_000_000) return bad();
  let previousEnd = 13;
  const packets = doc.packets.map(p => {
    if (!Array.isArray(p) || p.length !== 5 || p.some(n => !Number.isSafeInteger(n)) || p[0] < previousEnd
      || p[1] <= 0 || p[0] + p[1] > size - 4 || p[3] < 0 || p[3] > 0xffffffff * 1000
      || Math.abs(p[2] - p[3]) > 0x800000 * 1000 || ![0, 1].includes(p[4])) return bad();
    previousEnd = p[0] + p[1];
    return { offset: p[0], size: p[1], pts: p[2], dts: p[3], key: !!p[4] };
  });
  const index = buildFlvIndex(doc.codec, new Uint8Array(doc.description), packets);
  flvDecoderConfig(index);
  return index;
}
