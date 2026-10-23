import type { CommittedIndexHeader } from './committed-index-header.ts';
import type { SemanticRecord } from './semantic-query.ts';

export type CommittedSemanticRecord = SemanticRecord & {
  effectivePtsUs: string;
  effectiveDurationUs: string | null;
  timestampSource: 'flv-tag' | 'pes' | 'derived';
  configurationIndex: number;
  discontinuity: boolean | null;
};
type Context = Pick<CommittedIndexHeader, 'identity' | 'size' | 'recordCount' | 'originTick'>;
const integer = (n: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): n is number => Number.isSafeInteger(n) && Number(n) >= min && Number(n) <= max;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const bad = (): never => { throw new Error('Cached packet record is invalid.'); };

/** Project one authoritative packet without sorting, inferring pictures, or
 * substituting derived playback time for a missing source clock. The caller
 * supplies its ordinal in the stored packet array, not a presentation rank. */
export function committedSemanticRecord(packet: unknown, ordinal: number, context: Context): CommittedSemanticRecord {
  if (!integer(ordinal, 0, context.recordCount - 1)) return bad();
  const common = { decodeOrdinal: String(ordinal), durationTick: null, randomAccessVerified: null, pictureType: null, qp: null };
  if (context.identity.kind === 'flv') {
    if (!Array.isArray(packet) || ![5, 6, 7].includes(packet.length) || !packet.every(n => Number.isSafeInteger(n))) return bad();
    const [offset, size, pts, dts, key, configuration = 0, discontinuity] = packet as number[];
    if (!integer(offset, 13, context.size) || !integer(size, 1, context.size) || offset + size > context.size - 4
      || !integer(dts, 0, 0xffffffff * 1000) || Math.abs(pts - dts) > 0x800000 * 1000
      || ![0, 1].includes(key) || !integer(configuration, 0, 1023)
      || (packet.length === 7 && (discontinuity !== 1 || key !== 1 || ordinal === 0))
      || ordinal === 0 && (key !== 1 || String(pts) !== context.originTick)) return bad();
    return { ...common, ptsTick: String(pts), dtsTick: String(dts),
      // An arithmetic source-clock offset, not an inferred unwrap/elapsed time.
      normalizedPtsUs: context.originTick === null ? null : String(BigInt(pts) - BigInt(context.originTick)),
      sizeBytes: size, containerKey: key === 1, effectivePtsUs: String(pts), effectiveDurationUs: null,
      timestampSource: 'flv-tag', configurationIndex: configuration, discontinuity: discontinuity === 1 };
  }
  if (context.identity.kind !== 'js-ts' || !object(packet) || !object(packet.timing)) return bad();
  const p = packet, timing = packet.timing;
  if (p.au !== ordinal || p.configuration !== 0 || !integer(p.locator, 0, context.size - 1)
    || !(p.pesOffset === null || integer(p.pesOffset, 0, context.size - 188))
    || !integer(p.size, 1, 32 * 1024 * 1024) || typeof p.key !== 'boolean'
    || !integer(p.ptsUs, Number.MIN_SAFE_INTEGER) || !integer(p.durationUs)
    || typeof p.timestamp !== 'number' || !Number.isFinite(p.timestamp) || Math.round(p.timestamp * 1e6) !== p.ptsUs
    || !Array.isArray(timing.timebase) || timing.timebase.length !== 2 || timing.timebase[0] !== 1 || timing.timebase[1] !== 90000) return bad();
  for (const clock of [timing.pts, timing.dts]) if (clock !== null && !integer(clock, 0, 2 ** 33 - 1)) return bad();
  if (timing.origin === 'pes') {
    if (timing.pts === null || p.pesOffset === null || Math.round(Number(timing.pts) * 1e6 / 90000) !== p.ptsUs) return bad();
  } else if (timing.origin !== 'derived' || timing.pts !== null || timing.dts !== null) return bad();
  return { ...common, ptsTick: timing.pts === null ? null : String(timing.pts), dtsTick: timing.dts === null ? null : String(timing.dts),
    normalizedPtsUs: null, sizeBytes: p.size, containerKey: p.key, effectivePtsUs: String(p.ptsUs),
    effectiveDurationUs: p.durationUs > 0 ? String(p.durationUs) : null, timestampSource: timing.origin,
    configurationIndex: 0, discontinuity: null };
}

export function committedRecordSemantics(kind: 'flv' | 'js-ts') {
  return { order: 'source-packet-order', range: 'raw-value-filter', continuity: 'unverified',
    wrap: { reconstruction: 'unavailable', nativeClockModulusTick: kind === 'flv' ? '4294967296000' : '8589934592' },
    normalization: kind === 'flv' ? 'raw-offset-not-unwrapped' : 'unavailable',
    keySource: kind === 'flv' ? 'flv-video-tag' : 'js-demuxer',
    durationTickSource: 'unavailable', effectiveDurationUsSource: kind === 'flv' ? 'unavailable' : 'index-derived' };
}
