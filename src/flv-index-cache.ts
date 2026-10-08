import { buildFlvIndex, flvDecoderConfig, FLV_RESYNC_BYTES, FLV_RESYNC_GAPS, FLV_RESYNC_TOTAL_BYTES } from './flv-demux.ts';
import type { FlvCodec, FlvIndex, FlvRecoveredGap, FlvTruncationReason } from './flv-demux.ts';

export const FLV_INDEX_SCHEMA = 3;
export const FLV_INDEX_BYTES = 32 * 1024 * 1024;
export interface FlvIndexDocument {
  recoveredGaps?: FlvRecoveredGap[];
  configurations?: number[][];
  truncatedAt?: number;
  truncationReason?: FlvTruncationReason;
  schema: number; size: number; codec: FlvCodec; description: number[];
  packets: [number, number, number, number, number, number?, number?][];
}
export function serializeFlvIndex(index: FlvIndex, size: number): FlvIndexDocument {
  return { ...(index.recoveredGaps ? { recoveredGaps: index.recoveredGaps.map(g=>({...g})) } : {}), ...(index.configurations ? { configurations: index.configurations.map(c => [...c]) } : {}), ...(index.truncatedAt === undefined ? {} : { truncatedAt: index.truncatedAt }), ...(index.truncationReason ? {truncationReason:index.truncationReason} : {}), schema: FLV_INDEX_SCHEMA, size, codec: index.codec, description: [...index.description],
    packets: index.packets.map(p => [p.offset, p.size, p.pts, p.dts, +p.key, ...(p.discontinuity ? [p.configuration??0,1] : p.configuration === undefined ? [] : [p.configuration])] as [number, number, number, number, number, number?, number?]) };
}
/** Derived timing/order is always rebuilt, never trusted from a cache upload. */
export function parseFlvIndex(value: unknown, size: number): FlvIndex {
  const doc = value as FlvIndexDocument | null;
  const bad = (): never => { throw new Error('FLV 帧索引格式或范围无效。'); };
  if (!doc || doc.schema !== FLV_INDEX_SCHEMA || doc.size !== size || !['h264', 'hevc', 'av1', 'vvc'].includes(doc.codec)
    || !Array.isArray(doc.description) || !doc.description.length || doc.description.length > 1024 * 1024
    || doc.description.some(b => !Number.isInteger(b) || b < 0 || b > 255)
    || !Array.isArray(doc.packets) || !doc.packets.length || doc.packets.length > 2_000_000) return bad();
  const configs = doc.configurations;
  if (configs !== undefined && (!Array.isArray(configs) || configs.length < 2 || configs.length > 1024
    || configs.some(c => !Array.isArray(c) || !c.length || c.length > 1024 * 1024 || c.some(b => !Number.isInteger(b) || b < 0 || b > 255))
    || configs.reduce((n, c) => n + c.length, 0) > 8 * 1024 * 1024
    || configs[0].length !== doc.description.length || configs[0].some((b, i) => b !== doc.description[i]))) return bad();
  let previousConfiguration = 0;
  let previousEnd = 13;
  const packets = doc.packets.map(p => {
    if (!Array.isArray(p) || (p.length !== 5 && p.length !== 6 && p.length !== 7) || p.some(n => !Number.isSafeInteger(n)) || p[0] < previousEnd
      || p[1] <= 0 || p[0] + p[1] > size - 4 || p[3] < 0 || p[3] > 0xffffffff * 1000
      || Math.abs(p[2] - p[3]) > 0x800000 * 1000 || ![0, 1].includes(p[4])) return bad();
    const configuration = p[5] ?? 0;
    if (configuration < previousConfiguration || configuration > previousConfiguration + 1 || configuration >= (configs?.length ?? 1)
      || (configuration !== previousConfiguration && !p[4])) return bad();
    if(p.length===7&&(p[6]!==1||!p[4]||previousEnd===13))return bad();
    previousConfiguration = configuration;
    previousEnd = p[0] + p[1];
    return { ...(configuration > 0 ? { configuration } : {}), ...(p[6]?{discontinuity:true}:{}), offset: p[0], size: p[1], pts: p[2], dts: p[3], key: !!p[4] };
  });
  const index = buildFlvIndex(doc.codec, new Uint8Array(doc.description), packets, configs?.map(c => new Uint8Array(c)));
  if (doc.truncatedAt !== undefined) {
    if (!Number.isSafeInteger(doc.truncatedAt) || doc.truncatedAt < previousEnd + 4 || doc.truncatedAt >= size) return bad();
    index.truncatedAt = doc.truncatedAt;
  }
  if(doc.truncationReason!==undefined){
    if(doc.truncatedAt===undefined||!['incomplete-tag','invalid-tag','recovery-budget','no-random-access'].includes(doc.truncationReason))return bad();
    index.truncationReason=doc.truncationReason;
  }
  if(doc.recoveredGaps!==undefined){
    if(!Array.isArray(doc.recoveredGaps)||!doc.recoveredGaps.length||doc.recoveredGaps.length>FLV_RESYNC_GAPS)return bad();
    let previousGapEnd=13,packetCursor=0,totalGapBytes=0;
    index.recoveredGaps=doc.recoveredGaps.map(g=>{
      if(!g||!Number.isSafeInteger(g.offset)||!Number.isSafeInteger(g.size)||!Number.isSafeInteger(g.resumeAt)||g.offset<previousGapEnd||g.offset<packets[0].offset+packets[0].size+4||g.size<1||g.size>FLV_RESYNC_BYTES||g.resumeAt<g.offset+g.size||g.resumeAt>size-15
        ||(doc.truncatedAt!==undefined&&g.resumeAt>=doc.truncatedAt))return bad();
      totalGapBytes+=g.size;if(totalGapBytes>FLV_RESYNC_TOTAL_BYTES)return bad();
      const end=g.resumeAt;
      while(packetCursor<packets.length&&packets[packetCursor].offset+packets[packetCursor].size<=g.offset)packetCursor++;
      if(packetCursor<packets.length&&packets[packetCursor].offset<end)return bad();
      const packet=packets[packetCursor];
      if(!packet?.discontinuity||packet.offset<=end||packet.offset>end+19)return bad();
      previousGapEnd=packet.offset+packet.size+4;return {offset:g.offset,size:g.size,resumeAt:g.resumeAt};
    });
  }
  if(packets.filter(p=>p.discontinuity).length!==(index.recoveredGaps?.length??0))return bad();
  for (const description of index.configurations ?? [index.description]) flvDecoderConfig({ codec: index.codec, description });
  return index;
}
