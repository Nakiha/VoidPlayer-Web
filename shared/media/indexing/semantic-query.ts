import { FFMPEG_INDEX_RECORD_BYTES, FFMPEG_NO_TIMESTAMP } from './ffmpeg-index-cache.ts';

/** Host-neutral, cache-only semantics. No media I/O or session state. */
export const MEDIA_QUERY_SCHEMA = 'voidplayer-media-query';
export const MEDIA_QUERY_VERSION = 1;
export const MEDIA_QUERY_DICTIONARY = '/api/media/query-schema';
export const QUERY_SCAN_LIMIT = 2048;
export const QUERY_RECORD_LIMIT = 256;
export type CachedField = { value: string | number | boolean | null; status: 'known' | 'unknown' | 'not-probed' | 'unsupported'; source: 'file-stat' | 'container-index' | 'unavailable'; reason?: string };
export function cachedField(value: string | number | boolean | null, reason = 'not-stored-in-index'): CachedField {
  return value === null ? { value, status: 'unknown', source: 'unavailable', reason }
    : { value, status: 'known', source: 'container-index' };
}
export type SemanticQuery = { axis: 'pts' | 'dts'; startTick: string; endTick: string; limit: number; byteBudget: number };
export function parseSemanticQuery(params: URLSearchParams): SemanticQuery {
  const axis = params.get('axis') ?? 'pts';
  if (axis !== 'pts' && axis !== 'dts') throw new Error('axis must be pts or dts');
  const startTick = params.get('startTick') ?? '', endTick = params.get('endTick') ?? '';
  const integer = (s: string) => /^-?(?:0|[1-9][0-9]{0,18})$/.test(s) && BigInt(s) > FFMPEG_NO_TIMESTAMP && BigInt(s) <= 9223372036854775807n;
  if (!integer(startTick) || !integer(endTick) || BigInt(startTick) >= BigInt(endTick)) throw new Error('startTick/endTick must be ordered signed 64-bit decimal ticks');
  const limit = params.get('limit') ?? '100', budget = params.get('byteBudget') ?? '65536';
  if (!/^[1-9][0-9]*$/.test(limit) || Number(limit) > QUERY_RECORD_LIMIT) throw new Error('limit must be 1..256');
  if (!/^[1-9][0-9]*$/.test(budget) || Number(budget) < 8192 || Number(budget) > 262144) throw new Error('byteBudget must be 8192..262144');
  return { axis, startTick, endTick, limit: Number(limit), byteBudget: Number(budget) };
}
export type SemanticRecord = {
  decodeOrdinal: string; ptsTick: string | null; dtsTick: string | null; durationTick: string | null;
  normalizedPtsUs: string | null; sizeBytes: number; containerKey: boolean;
  randomAccessVerified: null; pictureType: null; qp: null;
};
/** Match the shared FFmpeg rounding convention, keeping arbitrary precision. */
function microseconds(ticks: bigint, num: number, den: number): string {
  const n = ticks * BigInt(num) * 1_000_000n, d = BigInt(den);
  let q = n / d;
  if (n % d * 2n >= d) q++;
  else if (n % d * 2n < -d) q--;
  return q.toString();
}
export function semanticRecord(view: DataView, offset: number, clock: { num: number; den: number; firstPts: string | null; originVerified: boolean }): SemanticRecord {
  const pts = view.getBigInt64(offset, true), dts = view.getBigInt64(offset + 8, true);
  const duration = view.getBigInt64(offset + 16, true);
  return {
    decodeOrdinal: view.getBigUint64(offset + 40, true).toString(),
    ptsTick: pts === FFMPEG_NO_TIMESTAMP ? null : pts.toString(),
    dtsTick: dts === FFMPEG_NO_TIMESTAMP ? null : dts.toString(),
    durationTick: duration > 0n ? duration.toString() : null,
    normalizedPtsUs: pts !== FFMPEG_NO_TIMESTAMP && clock.originVerified && clock.firstPts !== null
      ? microseconds(pts - BigInt(clock.firstPts), clock.num, clock.den) : null,
    sizeBytes: view.getInt32(offset + 32, true), containerKey: !!(view.getUint32(offset + 36, true) & 1),
    randomAccessVerified: null, pictureType: null, qp: null,
  };
}
export function recordMatches(record: SemanticRecord, query: SemanticQuery): boolean | null {
  const tick = query.axis === 'pts' ? record.ptsTick : record.dtsTick;
  return tick === null ? null : BigInt(tick) >= BigInt(query.startTick) && BigInt(tick) < BigInt(query.endTick);
}
export const MEDIA_QUERY_FIELDS = {
  schema: MEDIA_QUERY_SCHEMA, version: MEDIA_QUERY_VERSION,
  fields: {
    'file.size': 'File length in bytes, from a validated filesystem stat; not compressed video payload size.',
    'file.lastModified': 'Unix milliseconds from the library file version.',
    'technical.*': 'Each field has value, status, source and optional reason. Unknown is null, never zero. Values belong to the selected cached stream and source version.',
    codec: 'Container-index codec name; no decode verification.',
    width: 'Indexer-reported stream width in pixels; coded/visible distinction is not stored.',
    height: 'Indexer-reported stream height in pixels; coded/visible distinction is not stored.',
    timeBaseNum: 'Numerator of seconds per original stream tick.',
    timeBaseDen: 'Denominator of seconds per original stream tick.',
    firstPts: 'Original stream origin in decimal ticks. Normalization allowed only when originVerified=true.',
    ptsTick: 'Original container presentation timestamp; signed decimal integer ticks, null if missing.',
    dtsTick: 'Original container decoding timestamp; signed decimal integer ticks, null if missing.',
    durationTick: 'Container packet duration in original ticks; null if absent/nonpositive.',
    normalizedPtsUs: 'PTS minus verified firstPts in integer microseconds (decimal string), nearest rounding with ties toward positive infinity; null without verified origin.',
    decodeOrdinal: 'Original packet decode ordinal (decimal string), not the PTS-sorted row number or decoded frame number.',
    sizeBytes: 'Compressed packet payload bytes; never pixel allocation or HTTP traffic.',
    containerKey: 'Container key flag; not proof of independently verified random access or I-picture.',
    randomAccessVerified: 'Always null: this adapter does not verify random access.',
    pictureType: 'Always null: container indexes do not establish I/P/B.',
    qp: 'Always null: no bitstream QP or decoded pixels are inferred.',
    scannedBytes: 'Scanner progress in source bytes; not stable presentation coverage.',
    stablePresentationUs: 'Indexer watermark in integer microseconds, exclusive frontier; null without a verified origin or trustworthy streamed watermark. It is not media duration.',
    terminal: 'The cached build stopped successfully; independent of source coverage/integrity.',
    state: 'not-indexed: no cache; unknown: legacy/unrecognized semantics; partial: building/failed/prefix/unknown-integrity; complete: terminal and explicitly complete integrity.',
    summary: 'Page-local summary of matched records only. Sum across all pages of the same snapshot; not a full-range claim on an intermediate page.',
    exhausted: 'All records in this snapshot were examined. Does not imply the media index is complete.',
  },
  recordGranularity: 'container packet; not guaranteed one sample, access unit or decoded picture',
  range: 'Half-open [startTick,endTick) in the selected original stream time base; axis pts or dts. Missing axis values are counted in inspectedUntimed and excluded from matches.',
  order: 'Stored presentation order (PTS ascending, untimed tail), including DTS queries; decodeOrdinal preserves source decode order. Duplicate PTS are distinct records.',
  integers: 'All 64-bit ticks/ordinals and normalized microseconds are decimal strings; bounded counts/byte lengths are safe JSON integers.',
  limits: { records: QUERY_RECORD_LIMIT, inspectedPerPage: QUERY_SCAN_LIMIT, responseBytes: 262144, identitiesPerPage: 16 },
  sideEffects: 'No scans, decoding, builds, legacy cache migration, GUI or playback commands.',
};
export { FFMPEG_INDEX_RECORD_BYTES };
