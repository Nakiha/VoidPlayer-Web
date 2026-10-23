import type { MediaIndexIdentity } from './media-index-identity.ts';
import { FFMPEG_INDEX_RECORD_BYTES, FFMPEG_NO_TIMESTAMP } from './ffmpeg-index-cache.ts';
import type { CommittedIndexHeader } from './committed-index-header.ts';

/** Host-neutral, cache-only semantics. No media I/O or session state. */
export const MEDIA_QUERY_SCHEMA = 'voidplayer-media-query';
export const MEDIA_QUERY_VERSION = 1;
export const MEDIA_QUERY_DICTIONARY = '/api/media/query-schema';
export const QUERY_SCAN_LIMIT = 2048;
export const QUERY_RECORD_LIMIT = 256;
export const QUERY_CONCURRENCY_LIMIT = 8;
export type CachedField = { value: string | number | boolean | null; status: 'known' | 'unknown' | 'not-probed' | 'unsupported' | 'derived'; source: 'file-stat' | 'container-index' | 'codec-configuration' | 'index-observation' | 'unavailable'; reason?: string };
export function cachedField(value: string | number | boolean | null, reason = 'not-stored-in-index'): CachedField {
  return value === null ? { value, status: 'unknown', source: 'unavailable', reason }
    : { value, status: 'known', source: 'container-index' };
}
export interface CachedIndexState {
  complete: boolean; state: string; recordCount: number; scannedBytes: number;
  stablePresentationUs: number; metadata: Record<string, unknown> | null;
  semanticHeader?: CommittedIndexHeader | null; semanticReason?: string;
}
function describeCommittedIndex(row: CachedIndexState | null, identity: MediaIndexIdentity) {
  const h = row?.semanticHeader;
  const state = !row ? 'not-indexed' : !h ? 'unknown' : row.complete && row.state === 'complete' && h.integrity === 'complete' ? 'complete' : 'partial';
  const reason = !row ? 'cache-miss' : !h ? row.semanticReason ?? 'semantic-header-missing' : row.state === 'failed' ? 'build-failed'
    : !row.complete ? 'build-in-progress' : h.integrity === 'prefix' ? 'retained-prefix' : h.integrity === 'recovered' ? 'recovered-gaps'
    : h.integrity === 'unknown' ? 'integrity-unknown' : row.state !== 'complete' ? 'build-state-inconsistent' : null;
  const technical: Record<string, CachedField> = {};
  for (const key of ['codec', 'container', 'width', 'height', 'timeBaseNum', 'timeBaseDen', 'streamIndex', 'pid', 'profile', 'codedWidth', 'codedHeight', 'visibleWidth', 'visibleHeight', 'sar', 'rotation', 'bitDepth', 'pixelFormat', 'sourceColorPrimaries', 'sourceColorTransfer', 'sourceColorMatrix', 'sourceColorRange', 'durationUs', 'indexedDurationUs', 'frameRateMode', 'frameRate', 'bitrate', 'decodedFrameCount']) {
    technical[key] = !row ? { value: null, status: 'not-probed', source: 'unavailable', reason: 'cache-miss' } : cachedField(null, h ? 'not-stored-in-index' : reason!);
  }
  if (h) {
    for (const [key, value] of Object.entries({ codec: h.codec, container: h.container, timeBaseNum: h.timeBaseNum, timeBaseDen: h.timeBaseDen, streamIndex: 0, pid: h.pid })) technical[key] = cachedField(value);
    for (const [key, field] of Object.entries({ width: 'width', height: 'height', visibleWidth: 'width', visibleHeight: 'height', codedWidth: 'codedWidth', codedHeight: 'codedHeight' } as const)) {
      technical[key] = h.geometry ? { value: h.geometry[field], status: 'known', source: 'codec-configuration' } : cachedField(null, h.geometryReason!);
    }
    technical.durationUs = cachedField(null, 'container-duration-not-stored');
    technical.indexedDurationUs = { value: h.indexedDurationUs, status: 'derived', source: 'index-observation', reason: 'indexed-span-with-estimated-tail' };
  }
  const axis = (a: CommittedIndexHeader['pts']) => ({ count: a.count, missing: a.missing, minTick: a.minTick, maxTick: a.maxTick });
  return {
    identity, state, reason, terminal: !!row?.complete, buildState: row?.state ?? null,
    recordCount: h?.recordCount ?? null, scannedBytes: h?.scannedBytes ?? null, stablePresentationUs: null,
    integrity: h?.integrity ?? 'unknown', technical,
    clock: { timeBase: h ? { numerator: h.timeBaseNum, denominator: h.timeBaseDen, unit: 'seconds-per-tick' } : null,
      firstPts: h?.originTick ?? null, originVerified: !!h && h.originTick !== null,
      originBasis: h && h.originTick !== null ? 'first-decode-packet-pts' : 'not-established',
      rangeDomain: identity.kind === 'flv' ? 'cached-source-microseconds' : 'original-pes-ticks',
      nativeTimeBase: h ? { numerator: 1, denominator: identity.kind === 'flv' ? 1000 : 90000 } : null },
    recordGranularity: identity.kind === 'flv' ? 'flv-video-tag-payload' : 'js-demux-packet',
    coverage: h ? { scope: 'committed-packets-only', semantics: h.coverageSemantics, pts: axis(h.pts), dts: axis(h.dts),
      effectivePtsUs: { min: h.effectivePtsUs.min, max: h.effectivePtsUs.max },
      continuousPresentation: null, truncatedAt: h.truncatedAt, recoveredGapCount: h.recoveredGapCount, recovery: h.recovery } : null,
    statistics: h ? { scope: 'committed-packets-only', payloadBytes: h.payloadBytes, indexKeyCount: h.keyCount } : null,
    evidence: h ? { schema: h.schema, version: h.version, provenance: h.provenance, geometryScope: 'initial-codec-configuration', validation: 'validated-at-commit; header-checked-on-read; payload-not-rehashed' } : null,
    capabilities: { overview: { implemented: true, enabled: true, ready: true },
      records: { implemented: false, enabled: false, ready: false, reason: 'semantic-record-adapter-unavailable' } },
  };
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
  if (identity.kind === 'flv' || identity.kind === 'js-ts') return describeCommittedIndex(row, identity);
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
  const integer = (s: string, maximum: bigint) => /^-?(?:0|[1-9][0-9]{0,18})$/.test(s) && BigInt(s) > FFMPEG_NO_TIMESTAMP && BigInt(s) <= maximum;
  if (!integer(startTick, 9223372036854775807n) || !integer(endTick, 9223372036854775808n) || BigInt(startTick) >= BigInt(endTick)) throw new Error('Use ordered 64-bit decimal ticks; endTick may be 9223372036854775808 as the exclusive upper bound.');
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
    recordCount: 'Cached packet count, not decoded frame count; null for missing/unrecognized FLV/TS semantic headers.',
    recordGranularity: 'FLV video tag payload or JS demux packet as reported by its authoritative parser; neither guarantees one decoded picture.',
    coverage: 'FLV/TS commit-time observations only. pts/dts minTick and maxTick are inclusive extrema in clock.timeBase, not continuous or half-open coverage. count and missing refer to raw source timestamps; effectivePtsUs also includes derived TS presentation timestamps and must not fill raw PTS/DTS.',
    'coverage.continuousPresentation': 'Null: continuous presentation coverage has not been verified. Complete packet enumeration does not establish decode continuity.',
    'coverage.recovery': 'TS parser recovery method, or null. Late-PSI recovery is distinct from FLV recoveredGapCount and does not invent a gap count.',
    'coverage.truncatedAt': 'Source byte offset reported by the authoritative parser for a retained prefix; null when no truncation is recorded.',
    statistics: 'FLV/TS committed-packets-only payloadBytes and indexKeyCount. These count the existing parser packet table, including untimed packets; index key classification does not establish decoded picture type.',
    evidence: 'Small versioned commit-time header, bound to source version and cache identity. Read checks its checksum/schema/counters only, without rehashing the packet document. Atomic payload mutation invalidates this projection.',
    'evidence.geometryScope': 'initial-codec-configuration: coded and visible dimensions parsed from the already cached initial SPS; unavailable for unsupported/oversized/changing configurations. Not per-picture verification.',
    indexedDurationUs: 'Derived integer microseconds from the shared index span and estimated final packet duration. FLV uses first decode-packet PTS as origin; TS uses minimum effective PTS. Not container duration, CFR or decoded frame count.',
    'clock.nativeTimeBase': 'Native FLV tags use 1/1000 seconds; cached source timestamps are scaled to 1/1000000 seconds. TS raw PES timestamps use 1/90000 seconds (33-bit, without inferred unwrap).',
    'clock.originBasis': 'FLV: first-decode-packet-pts, matching flvMediaTiming. TS: not-established; no decoded/playback origin is inferred.',
    semanticHeaderFailures: 'semantic-header-missing, semantic-header-too-large, semantic-header-invalid and semantic-header-version-unsupported return unknown without reading packets or migrating. A cache miss is not a build status: FLV/TS do not persist in-progress/failure records before their terminal commit.',
    snapshot: 'Opaque cache/query revision token. Changed tokens invalidate accumulated pages.',
    inspected: 'Records examined in this page, including nonmatches; at most 2048.',
    inspectedUntimed: 'Examined records without the selected axis timestamp; excluded from the range summary.',
    nextCursor: 'Continuation within the same source/version/identity/axis/range snapshot; null when exhausted or unavailable. Check readiness first.',
    capabilities: 'implemented is code support, enabled is deployment support, ready is availability for this exact cached source/stream.',
    fieldStatuses: 'known: cached evidence; unknown: cache lacks a fact; not-probed: no cached probe/index; unsupported: field or operation has no adapter; derived: index-based estimate, not a container declaration. No missing fact is zero.',
    'technical.*': 'Each field has value, status, source and optional reason. Unknown is null, never zero. Values belong to the selected cached stream and source version.',
    codec: 'Container-index codec name; no decode verification.',
    width: 'Width in pixels from the stated source. FFmpeg stores indexer width without coded/visible distinction; FLV/TS geometry uses the initial codec configuration.',
    height: 'Height in pixels from the stated source; see width and evidence.geometryScope.',
    timeBaseNum: 'Numerator of seconds per tick in clock.rangeDomain; FLV cached ticks are scaled microseconds.',
    timeBaseDen: 'Denominator of seconds per tick in clock.rangeDomain.',
    firstPts: 'Origin in decimal clock.timeBase ticks; see clock.originBasis when present. Null if not established. Normalization allowed only when originVerified=true.',
    ptsTick: 'Original container presentation timestamp; signed decimal integer ticks, null if missing.',
    dtsTick: 'Original container decoding timestamp; signed decimal integer ticks, null if missing.',
    durationTick: 'Container packet duration in original ticks; null if absent/nonpositive.',
    normalizedPtsUs: 'PTS minus verified firstPts in integer microseconds (decimal string), nearest rounding with ties toward positive infinity; null without verified origin.',
    readBytes: 'FLV/TS packet TEXT bytes materialized in this page, including an entire bounded chunk even when only part is inspected; at most 262144. Context columns are bounded separately (metadata 32768, semantic header 8192, storage descriptor 4096 bytes).',
    chunksRead: 'FLV/TS bounded packet chunks loaded in this page. No seq=0 document metadata or legacy packet document is fetched.',
    recordSemantics: 'Per-index order, raw range filtering, clock modulus, normalization and continuity. FLV/TS source-packet-order preserves reorder/duplicates; no timestamp unwrap or continuity inference.',
    effectivePtsUs: 'FLV source microseconds or TS effective presentation microseconds from the existing index. TS may derive this value; it never substitutes for absent ptsTick/dtsTick.',
    effectiveDurationUs: 'TS index-derived duration in microseconds, null if unavailable; not an original container durationTick. FLV remains null.',
    timestampSource: 'flv-tag, pes or derived. Only original clocks populate ptsTick/dtsTick.',
    configurationIndex: 'Original packet codec-configuration index. TS currently stores configuration zero.',
    discontinuity: 'FLV explicit recovery boundary (boolean); TS null because the packet index does not establish it.',
    decodeOrdinal: 'Original packet decode ordinal (decimal string), not the PTS-sorted row number or decoded frame number.',
    sizeBytes: 'Compressed packet payload bytes; never pixel allocation or HTTP traffic.',
    containerKey: 'Container key flag; not proof of independently verified random access or I-picture.',
    randomAccessVerified: 'Always null: this adapter does not verify random access.',
    pictureType: 'Always null: container indexes do not establish I/P/B.',
    qp: 'Always null: no bitstream QP or decoded pixels are inferred.',
    scannedBytes: 'Scanner progress in source bytes; not stable presentation coverage.',
    stablePresentationUs: 'Indexer watermark in integer microseconds, exclusive frontier; null without a verified origin or trustworthy streamed watermark. It is not media duration.',
    terminal: 'The cached build stopped successfully; independent of source coverage/integrity.',
    state: 'not-indexed: no cache; unknown: legacy/unrecognized semantics; partial: building/failed/prefix/recovered-gaps/unknown-integrity; complete: terminal and explicitly complete integrity.',
    summary: 'Page-local summary of matched records only. Sum across all pages of the same snapshot; not a full-range claim on an intermediate page.',
    exhausted: 'All records in this snapshot were examined. Does not imply the media index is complete.',
  },
  recordGranularity: 'container packet; not guaranteed one sample, access unit or decoded picture',
  range: 'Half-open [startTick,endTick) in the selected original stream time base; endTick may be 9223372036854775808 to include the largest signed timestamp; axis pts or dts. Missing axis values are counted in inspectedUntimed and excluded from matches.',
  order: 'FFmpeg: stored presentation order (PTS ascending, untimed tail). FLV/TS: source packet order, as stated by overview.recordSemantics, including DTS queries. decodeOrdinal preserves original packet order. Duplicate PTS remain distinct.',
  integers: 'All 64-bit ticks/ordinals and normalized microseconds are decimal strings; bounded counts/byte lengths are safe JSON integers.',
  limits: { records: QUERY_RECORD_LIMIT, inspectedPerPage: QUERY_SCAN_LIMIT, responseBytes: 262144, identitiesPerPage: 16, inFlightPerLibrary: QUERY_CONCURRENCY_LIMIT, packetChunkRecords: 64, packetChunkBytes: 65536, packetReadBytesPerPage: 262144 },
  sideEffects: 'No scans, decoding, builds, legacy cache migration, GUI or playback commands.',
};
export { FFMPEG_INDEX_RECORD_BYTES };
