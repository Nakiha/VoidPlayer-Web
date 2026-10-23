import { avcGeometry } from '../codecs/avc-geometry.ts';
import { hevcGeometry } from '../codecs/hevc-geometry.ts';
import { flvIndexIntegrity } from '../containers/flv-demux.ts';
import type { FlvIndex } from '../containers/flv-demux.ts';
import type { TsPacketIndex } from './ts-packet-index.ts';
import { FLV_MEDIA_INDEX_IDENTITY, JS_TS_MEDIA_INDEX_IDENTITY, mediaIndexIdentityKey } from './media-index-identity.ts';
import type { MediaIndexIdentity } from './media-index-identity.ts';

/** A projection of a validated document at commit, never a second packet index.
 * No packet arrays, configuration bytes, paths, decoding or media reads here. */
export const COMMITTED_HEADER_SCHEMA = 'voidplayer-committed-index';
export const COMMITTED_HEADER_VERSION = 1;
export const COMMITTED_HEADER_BYTES = 8192;
const semantics = { describedBy: '/api/media/query-schema', coverageSemantics: 'inclusive-observed-timestamp-extrema', geometryScope: 'initial-codec-configuration', durationBasis: 'indexed-span-with-estimated-tail' } as const;
export type ScanEvidence = { scannedBytes: number };
type Axis = { count: number; missing: number; minTick: string | null; maxTick: string | null };
type Geometry = { codedWidth: number; codedHeight: number; width: number; height: number };
export interface CommittedIndexHeader {
  describedBy: typeof semantics.describedBy; coverageSemantics: typeof semantics.coverageSemantics;
  geometryScope: typeof semantics.geometryScope; durationBasis: typeof semantics.durationBasis;
  recordGranularity: 'flv-video-tag-payload' | 'js-demux-packet';
  clockDomain: 'cached-source-microseconds' | 'original-pes-ticks';
  originBasis: 'first-decode-packet-pts' | 'not-established';
  schema: typeof COMMITTED_HEADER_SCHEMA; version: typeof COMMITTED_HEADER_VERSION;
  sourceVersion: string; identity: MediaIndexIdentity; size: number;
  provenance: 'server-scan' | 'validated-upload';
  codec: string; container: 'FLV' | 'MPEG-TS'; pid: number | null;
  geometry: Geometry | null;
  geometryReason: 'configuration-unavailable' | 'configuration-changes' | 'configuration-budget' | null;
  recordCount: number; payloadBytes: number; keyCount: number;
  integrity: 'complete' | 'prefix' | 'recovered' | 'unknown';
  recovery: 'hevc-late-psi' | null;
  truncatedAt: number | null; recoveredGapCount: number; scannedBytes: number | null;
  timeBaseNum: 1; timeBaseDen: 1000000 | 90000;
  originTick: string | null;
  pts: Axis; dts: Axis;
  effectivePtsUs: { min: string; max: string };
  indexedDurationUs: string;
}
function axis(): Axis { return { count: 0, missing: 0, minTick: null, maxTick: null }; }
function observe(a: Axis, value: number | null) {
  if (value === null) { a.missing++; return; }
  a.count++;
  if (a.minTick === null || value < Number(a.minTick)) a.minTick = String(value);
  if (a.maxTick === null || value > Number(a.maxTick)) a.maxTick = String(value);
}
function geometry(codec: string, configuration: ArrayLike<number>, changes: boolean) {
  if (changes) return { geometry: null, geometryReason: 'configuration-changes' as const };
  if (configuration.length > 4096) return { geometry: null, geometryReason: 'configuration-budget' as const };
  const bytes = Uint8Array.from(configuration);
  const g = codec === 'h264' ? avcGeometry(bytes) : codec === 'hevc' ? hevcGeometry(bytes) : null;
  // Only expose geometry actually parsed by the shared configuration helpers.
  return g ? { geometry: { codedWidth: g.codedWidth, codedHeight: g.codedHeight, width: g.width, height: g.height }, geometryReason: null }
    : { geometry: null, geometryReason: 'configuration-unavailable' as const };
}
export function flvCommittedHeader(index: FlvIndex, size: number, sourceVersion: string, scan?: ScanEvidence): CommittedIndexHeader {
  const pts = axis(), dts = axis(); let payloadBytes = 0, keyCount = 0;
  for (const p of index.packets) { observe(pts, p.pts); observe(dts, p.dts); payloadBytes += p.size; keyCount += +p.key; }
  const integrity = flvIndexIntegrity(index);
  return { ...semantics, recordGranularity: 'flv-video-tag-payload', clockDomain: 'cached-source-microseconds', originBasis: 'first-decode-packet-pts',
    schema: COMMITTED_HEADER_SCHEMA, version: COMMITTED_HEADER_VERSION, sourceVersion, identity: FLV_MEDIA_INDEX_IDENTITY, size,
    provenance: scan ? 'server-scan' : 'validated-upload', codec: index.codec, container: 'FLV', pid: null,
    ...geometry(index.codec, index.description, (index.configurations?.length ?? 1) > 1),
    recordCount: index.packets.length, payloadBytes, keyCount,
    integrity: integrity === 'complete' && !scan ? 'unknown' : integrity,
    recovery: null, truncatedAt: index.truncatedAt ?? null, recoveredGapCount: index.recoveredGaps?.length ?? 0, scannedBytes: scan?.scannedBytes ?? null,
    // FLV documents store tag milliseconds scaled to integer microseconds.
    timeBaseNum: 1, timeBaseDen: 1000000, originTick: String(index.packets[0].pts), pts, dts,
    effectivePtsUs: { min: pts.minTick!, max: pts.maxTick! },
    // Same tail-duration estimate and first decode-packet origin as flvMediaTiming.
    indexedDurationUs: String(index.firstPts + index.duration - index.packets[0].pts) };
}
export function tsCommittedHeader(index: TsPacketIndex): CommittedIndexHeader {
  const pts = axis(), dts = axis(); let payloadBytes = 0, keyCount = 0, min = Infinity, max = -Infinity, tailDuration = 0;
  for (const p of index.packets) {
    observe(pts, p.timing.pts); observe(dts, p.timing.dts); payloadBytes += p.size; keyCount += +p.key;
    min = Math.min(min, p.ptsUs);
    if (p.ptsUs > max) { max = p.ptsUs; tailDuration = p.durationUs; }
  }
  return { ...semantics, recordGranularity: 'js-demux-packet', clockDomain: 'original-pes-ticks', originBasis: 'not-established',
    schema: COMMITTED_HEADER_SCHEMA, version: COMMITTED_HEADER_VERSION, sourceVersion: index.sourceVersion, identity: JS_TS_MEDIA_INDEX_IDENTITY, size: index.size,
    provenance: 'server-scan', codec: index.codec, container: 'MPEG-TS', pid: index.pid,
    ...geometry(index.codec, index.configuration, false), recordCount: index.packets.length, payloadBytes, keyCount,
    integrity: index.indexIntegrity ?? 'complete', recovery: index.recovery ?? null,
    truncatedAt: index.indexTruncatedAt ?? null, recoveredGapCount: 0, scannedBytes: index.size,
    // Never fill absent raw PES timestamps using Mediabunny's derived PTS.
    timeBaseNum: 1, timeBaseDen: 90000, originTick: null, pts, dts,
    effectivePtsUs: { min: String(min), max: String(max) }, indexedDurationUs: String(max - min + tailDuration) };
}

const integer = (n: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): n is number => Number.isSafeInteger(n) && Number(n) >= min && Number(n) <= max;
const tick = (n: unknown): n is string => typeof n === 'string' && /^-?(?:0|[1-9][0-9]{0,15})$/.test(n) && Number.isSafeInteger(Number(n));
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
/** Reject unknown schemas/identities and malformed fields before emitting anything.
 * Callers additionally bind the envelope checksum, source and stored row counters. */
export function validCommittedHeader(value: unknown, identity: MediaIndexIdentity, sourceVersion: string, size: number, count: number): value is CommittedIndexHeader {
  if (!object(value)) return false;
  const h = value;
  if (!Object.entries(semantics).every(([key, value]) => h[key] === value)) return false;
  if (h.schema !== COMMITTED_HEADER_SCHEMA || h.version !== COMMITTED_HEADER_VERSION || h.sourceVersion !== sourceVersion || h.size !== size
    || !object(h.identity) || mediaIndexIdentityKey(h.identity as MediaIndexIdentity) !== mediaIndexIdentityKey(identity)
    || h.recordCount !== count || !integer(count, 1, identity.kind === 'flv' ? 2000000 : 250000)
    || !integer(h.payloadBytes, count) || !integer(h.keyCount, 0, count)
    || !['server-scan', 'validated-upload'].includes(h.provenance)
    || !['complete', 'prefix', 'recovered', 'unknown'].includes(h.integrity)
    || !integer(h.recoveredGapCount, 0, 16) || h.timeBaseNum !== 1
    || !(h.scannedBytes === null || integer(h.scannedBytes, 0, size))
    || !(h.truncatedAt === null || integer(h.truncatedAt, 0, size - 1))
    || (h.integrity === 'prefix') !== (h.truncatedAt !== null)
    || h.integrity === 'recovered' && !h.recoveredGapCount
    || h.integrity === 'complete' && (h.recoveredGapCount || h.provenance !== 'server-scan')
    || (h.provenance === 'validated-upload') !== (h.scannedBytes === null)
    || !['configuration-unavailable', 'configuration-changes', 'configuration-budget', null].includes(h.geometryReason)) return false;
  if (identity.kind === 'flv') {
    if (h.recordGranularity !== 'flv-video-tag-payload' || h.clockDomain !== 'cached-source-microseconds' || h.originBasis !== 'first-decode-packet-pts') return false;
    if (mediaIndexIdentityKey(identity) !== mediaIndexIdentityKey(FLV_MEDIA_INDEX_IDENTITY) || h.container !== 'FLV' || h.timeBaseDen !== 1000000 || h.pid !== null
      || h.recovery !== null || !['h264', 'hevc', 'av1', 'vvc'].includes(h.codec) || !tick(h.originTick)) return false;
  } else if (identity.kind === 'js-ts') {
    if (h.recordGranularity !== 'js-demux-packet' || h.clockDomain !== 'original-pes-ticks' || h.originBasis !== 'not-established') return false;
    if (mediaIndexIdentityKey(identity) !== mediaIndexIdentityKey(JS_TS_MEDIA_INDEX_IDENTITY) || h.container !== 'MPEG-TS' || h.timeBaseDen !== 90000
      || h.recoveredGapCount !== 0 || ![null, 'hevc-late-psi'].includes(h.recovery) || h.recovery && h.codec !== 'hevc'
      || !integer(h.pid, 1, 8190) || !['h264', 'hevc', 'mpeg2video'].includes(h.codec) || h.originTick !== null || h.provenance !== 'server-scan') return false;
  } else return false;
  for (const a of [h.pts, h.dts]) {
    if (!object(a) || !integer(a.count, 0, count) || !integer(a.missing, 0, count) || a.count + a.missing !== count) return false;
    if (a.count ? !tick(a.minTick) || !tick(a.maxTick) || Number(a.minTick) > Number(a.maxTick) : a.minTick !== null || a.maxTick !== null) return false;
    if (identity.kind === 'js-ts' && a.count && (Number(a.minTick) < 0 || Number(a.maxTick) >= 2 ** 33)) return false;
  }
  if (!object(h.effectivePtsUs) || !tick(h.effectivePtsUs.min) || !tick(h.effectivePtsUs.max) || Number(h.effectivePtsUs.min) > Number(h.effectivePtsUs.max)
    || !tick(h.indexedDurationUs) || Number(h.indexedDurationUs) < 0) return false;
  if (h.geometry !== null && (!object(h.geometry) || !['width', 'height', 'codedWidth', 'codedHeight'].every(k => integer(h.geometry[k], 1, 65536))
    || h.geometry.width > h.geometry.codedWidth || h.geometry.height > h.geometry.codedHeight || h.geometryReason !== null)) return false;
  return h.geometry !== null || h.geometryReason !== null;
}
