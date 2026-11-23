import type { AnnexBCodec } from '../codecs/annex-b-picture.ts';
import { annexBCodec } from '../containers/annex-b-header.ts';

export const ANNEX_B_PACKET_BUILD = 'annex-b-packets-v1';
export const ANNEX_B_MAX_PACKETS = 250000;
export const ANNEX_B_MAX_PACKET_BYTES = 32 * 1024 * 1024;
export const ANNEX_B_MAX_CONFIGURATION_BYTES = 64 * 1024;
export const ANNEX_B_DEFAULT_FPS = 30;

export interface AnnexBPacketRecord {
  au: number;
  locator: number;
  size: number;
  configuration: 0;
  key: boolean;
  ptsUs: number;
  durationUs: number;
  timing: { pts: null; dts: null; timebase: [1, 1000000]; origin: 'derived' };
}

export interface AnnexBPacketIndex {
  schema: 1;
  kind: 'js-annexb-packets';
  build: typeof ANNEX_B_PACKET_BUILD;
  streamKey: 'video:0';
  sourceVersion: string;
  size: number;
  codec: AnnexBCodec;
  configuration: number[];
  packets: AnnexBPacketRecord[];
  frameRate: number;
  rateSource: 'bitstream' | 'default';
  completeness: { state: 'complete'; packets: number };
  indexIntegrity?: undefined;
  indexTruncatedAt?: undefined;
}

export function parseAnnexBPacketIndex(value: unknown, sourceVersion: string, size: number): AnnexBPacketIndex | undefined {
  if (!value || typeof value !== 'object') return;
  const doc = value as AnnexBPacketIndex;
  if (doc.schema !== 1 || doc.build !== ANNEX_B_PACKET_BUILD || doc.kind !== 'js-annexb-packets' || doc.streamKey !== 'video:0'
    || doc.sourceVersion !== sourceVersion || doc.size !== size || !['h264', 'hevc', 'vvc'].includes(doc.codec)
    || !Array.isArray(doc.configuration) || !doc.configuration.length || doc.configuration.length > ANNEX_B_MAX_CONFIGURATION_BYTES
    || !doc.configuration.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)
    || annexBCodec(Uint8Array.from(doc.configuration)) !== doc.codec
    || !Array.isArray(doc.packets) || !doc.packets.length || doc.packets.length > ANNEX_B_MAX_PACKETS
    || doc.completeness?.state !== 'complete' || doc.completeness.packets !== doc.packets.length
    || !['bitstream', 'default'].includes(doc.rateSource) || !Number.isFinite(doc.frameRate) || doc.frameRate < 1 || doc.frameRate > 1000
    || doc.rateSource === 'default' && doc.frameRate !== ANNEX_B_DEFAULT_FPS) return;
  let end = 0, keyPts = -1;
  const ranks = new Set<number>();
  for (let au = 0; au < doc.packets.length; au++) {
    const p = doc.packets[au];
    if (!p || p.au !== au || p.configuration !== 0 || !Number.isSafeInteger(p.locator) || p.locator < end
      || !Number.isSafeInteger(p.size) || p.size < 4 || p.size > ANNEX_B_MAX_PACKET_BYTES || p.locator + p.size > size
      || !Number.isSafeInteger(p.ptsUs) || p.ptsUs < 0 || typeof p.key !== 'boolean' || !au && (!p.key || p.ptsUs !== 0)
      || p.timing?.pts !== null || p.timing.dts !== null || p.timing.origin !== 'derived'
      || p.timing.timebase?.[0] !== 1 || p.timing.timebase[1] !== 1000000) return;
    const rank = Math.round(p.ptsUs * doc.frameRate / 1e6);
    if (rank >= doc.packets.length || ranks.has(rank) || p.ptsUs !== annexBTime(rank, doc.frameRate)
      || p.durationUs !== annexBTime(rank + 1, doc.frameRate) - p.ptsUs || p.key && p.ptsUs <= keyPts) return;
    if (p.key) keyPts = p.ptsUs;
    end = p.locator + p.size;
    ranks.add(rank);
  }
  return doc;
}

export function annexBTime(rank: number, rate: number) { return Math.round(rank * 1e6 / rate); }
