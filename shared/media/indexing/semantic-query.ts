import type { MediaIndexIdentity } from './media-index-identity.ts';
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
export interface CachedIndexState {
  complete: boolean; state: string; recordCount: number; scannedBytes: number;
  stablePresentationUs: number; metadata: Record<string, unknown> | null;
}
export function supportedCachedMetadata(identity: MediaIndexIdentity, m: Record<string, unknown> | null): boolean {
  return identity.kind === 'ffmpeg' && identity.schemaVersion === 3 && !!m
    && m.recordBytes === 48 && m.schema === 3 && m.kind === 'ffmpeg-container'
    && typeof m.codec === 'string' && /^[a-z0-9_+-]{1,64}$/i.test(m.codec)
    && Number.isSafeInteger(m.width) && Number(m.width) > 0 && Number(m.width) <= 16384
    && Number.isSafeInteger(m.height) && Number(m.height) > 0 && Number(m.height) <= 16384
    && Number.isSafeInteger(m.streamIndex) && Number(m.streamIndex) >= 0 && Number(m.streamIndex) <= 64
    && m.indexerBuild === identity.indexerBuild && `video:${m.streamIndex}` === identity.streamKey
    && Number.isSafeInteger(m.timeBaseNum) && Number(m.timeBaseNum) > 0 && Number(m.timeBaseNum) <= 1e9
    && Number.isSafeInteger(m.timeBaseDen) && Number(m.timeBaseDen) > 0 && Number(m.timeBaseDen) <= 1e9;
}
export function cachedIndexClock(m: Record<string, unknown> | null) {
  const firstPts = typeof m?.firstPts === 'string' && /^-?\d{1,19}$/.test(m.firstPts) && BigInt(m.firstPts) > -9223372036854775808n && BigInt(m.firstPts) <= 9223372036854775807n ? m.firstPts : null;
  return { num: Number(m?.timeBaseNum), den: Number(m?.timeBaseDen), firstPts, originVerified: m?.originVerified === true && firstPts !== null };
}
export function describeCachedIndex(row: CachedIndexState | null, identity: MediaIndexIdentity) {
  const m = row?.metadata ?? null, ready = supportedCachedMetadata(identity, m), c = cachedIndexClock(ready ? m : null);
  const state = !row ? 'not-indexed' : !ready ? 'unknown' : row.complete && m!.indexIntegrity === 'complete' ? 'complete' : 'partial';
  const reason = !row ? 'cache-miss' : !ready ? 'semantic-adapter-unavailable' : m!.indexIntegrity === 'prefix' ? 'retained-prefix'
    : row.state === 'failed' ? 'build-failed' : !row.complete ? 'build-in-progress' : m!.indexIntegrity !== 'complete' ? 'integrity-unknown' : null;
  const technical: Record<string, ReturnType<typeof cachedField>> = {};
  for (const key of ['codec', 'width', 'height', 'timeBaseNum', 'timeBaseDen', 'streamIndex']) {
    const value = ready ? m![key] : undefined;
    technical[key] = cachedField((typeof value === 'number' && Number.isSafeInteger(value) && (key === 'streamIndex' ? value >= 0 : value > 0)) || (key === 'codec' && typeof value === 'string') ? value : null, reason ?? 'not-stored-in-index');
  }
  for (const key of ['container', 'profile', 'codedWidth', 'codedHeight', 'visibleWidth', 'visibleHeight', 'sar', 'rotation', 'bitDepth', 'pixelFormat', 'sourceColorPrimaries', 'sourceColorTransfer', 'sourceColorMatrix', 'sourceColorRange', 'durationUs', 'frameRateMode', 'frameRate', 'bitrate', 'decodedFrameCount']) {
    technical[key] = !row ? { value: null, status: 'not-probed', source: 'unavailable', reason: 'cache-miss' } : cachedField(null);
  }
  return {
    identity, state, reason, terminal: !!row?.complete, buildState: row?.state ?? null,
    recordCount: row?.recordCount ?? null, scannedBytes: row?.scannedBytes ?? null,
    // Uploads/legacy caches set 0 without deriving a watermark; do not claim coverage.
    stablePresentationUs: ready && c.originVerified && Number(row?.stablePresentationUs) > 0 ? String(row!.stablePresentationUs) : null,
    integrity: ready && (m!.indexIntegrity === 'complete' || m!.indexIntegrity === 'prefix') ? m!.indexIntegrity : 'unknown',
    clock: { timeBase: ready ? { numerator: c.num, denominator: c.den, unit: 'seconds-per-tick' } : null,
      firstPts: c.firstPts, originVerified: c.originVerified, rangeDomain: 'original-stream-ticks' },
    technical,
    capabilities: { overview: { implemented: true, enabled: true, ready: true },
      records: { implemented: identity.kind === 'ffmpeg' && identity.schemaVersion === 3, enabled: identity.kind === 'ffmpeg' && identity.schemaVersion === 3, ready, reason: ready ? null : reason } },
  };
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
    identity: 'Exact cache kind, streamKey, schemaVersion and indexerBuild. Never combine indexes from different identities or source versions.',
    recordCount: 'Cached container packet count, not decoded frame count.',
    snapshot: 'Opaque cache/query revision token. Changed tokens invalidate accumulated pages.',
    inspected: 'Records examined in this page, including nonmatches; at most 2048.',
    inspectedUntimed: 'Examined records without the selected axis timestamp; excluded from the range summary.',
    nextCursor: 'Continuation within the same source/version/identity/axis/range snapshot; null when exhausted or unavailable. Check readiness first.',
    capabilities: 'implemented is code support, enabled is deployment support, ready is availability for this exact cached source/stream.',
    fieldStatuses: 'known: cached evidence; unknown: cache lacks a fact; not-probed: no cached probe/index; unsupported: field or operation has no adapter. No missing fact is zero.',
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
