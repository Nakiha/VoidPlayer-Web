import { parseFlvIndex } from '../../media/indexing/flv-index-cache.ts';
import type { FlvIndexDocument } from '../../media/indexing/flv-index-cache.ts';
import { FLV_MEDIA_INDEX_IDENTITY, mediaIndexIdentityKey } from '../../media/indexing/media-index-identity.ts';
import type { MediaIndexIdentity } from '../../media/indexing/media-index-identity.ts';
import { scanFlv } from '../../media/containers/flv-demux.ts';
import { nalRanges } from '../../media/codecs/nal-framing.ts';
import { inspectPacketPicture } from '../../media/codecs/packet-picture.ts';
import { avcGeometry } from '../../media/codecs/avc-geometry.ts';
import type { HevcGeometry } from '../../media/codecs/hevc-geometry.ts';
import { hevcGeometry, hevcFieldPictures } from '../../media/codecs/hevc-geometry.ts';
import type { FrameDescription } from '../../media/frame-description.ts';
import type { SourcePictureKey } from '../bitstream/contract.ts';
import { measurePsnr } from './psnr.ts';
import type { PsnrFrame, PsnrRequest, PsnrResult } from './psnr.ts';

export const PAIR_LIMITS = Object.freeze({ maxReadBytes: 16 * 1024 * 1024, maxPacketBytes: 8 * 1024 * 1024,
  maxIndexPackets: 250000, maxIndexBytes: 32 * 1024 * 1024, maxFrameBytes: 32 * 1024 * 1024,
  maxHeapBytes: 256 * 1024 * 1024, maxPixels: 4096 * 2304, maxElapsedMs: 30000, maxPackets: 2, maxOutputFrames: 2 });
export type FramePairErrorCode = import('./psnr.ts').PsnrErrorCode | 'invalid-request' | 'cache-miss' | 'source-changed' | 'identity-mismatch' | 'unsupported-source' | 'decoder-error' | 'busy';
export class FramePairError extends Error {
  readonly code: FramePairErrorCode;
  readonly field?: string;
  constructor(code: FramePairErrorCode, message: string, field?: string) {
    super(message); this.name = 'FramePairError'; this.code = code; this.field = field;
  }
}
export type SourceBinding = { mediaId: string; mediaVersion: string; size: number; indexIdentity: MediaIndexIdentity; indexBuildId: string };
export type PairTarget = SourceBinding & { picture: SourcePictureKey; sourcePtsUs: number };
export type FramePairRequest = { pairing: 'caller-specified'; reference: PairTarget; distorted: PairTarget;
  roi: PsnrRequest['roi']; budget?: Partial<PairBudget> & PsnrRequest['budget'] };
export type PairBudget = { -readonly [K in keyof typeof PAIR_LIMITS]: number };
/** The host must bind this cached document and reader to the same immutable source.
 * This boundary never constructs an index or consults a playback source/cursor. */
export interface CachedPairSource {
  binding(): SourceBinding;
  index: FlvIndexDocument | null;
  read(offset: number, length: number): Promise<Uint8Array>;
  close(): void;
}
export type DecodedPairFrame = PsnrFrame & { pts: number };
export interface PairDecoder {
  readonly version: { backend: 'ffmpeg-wasm'; buildId: string; frameAbi: 2; packetIdentity: 'isolated-closed-au-v1' };
  decode(codec: 'h264' | 'hevc', configuration: Uint8Array, packet: Uint8Array, pts: number, dts: number,
    budget: PairBudget): Promise<DecodedPairFrame>;
  close(): void;
}
export type PairProvenance = PairTarget & { decoded: { sourcePtsUs: number; description: FrameDescription }; packet: { offset: number; size: number; sourceDtsUs: number }; validation: 'cached-au-source-tag-isolated-closed-picture-v1' };
export type FramePairResult = { schema: 'voidplayer-frame-pair-psnr'; version: 1; pairing: 'caller-specified';
  correspondence: 'caller-specified-no-content-or-time-alignment'; decoder: PairDecoder['version']; metric: PsnrResult;
  provenance: { reference: PairProvenance; distorted: PairProvenance }; work: { readBytes: number; packets: 2; outputFrames: 2; elapsedMs: number } };
function fail(code: FramePairError['code'], message: string): never { throw new FramePairError(code, message); }
export function pairBudget(request: FramePairRequest): PairBudget {
  if (request?.pairing !== 'caller-specified') fail('invalid-request', 'Explicit cross-source correspondence is required');
  const budget = { ...PAIR_LIMITS } as PairBudget;
  for (const key of Object.keys(PAIR_LIMITS) as (keyof PairBudget)[]) {
    const value = request.budget?.[key];
    if (value !== undefined) {
      if (!Number.isSafeInteger(value) || value < 1 || value > PAIR_LIMITS[key]) fail('invalid-request', `Invalid budget.${key}`);
      budget[key] = value;
    }
  }
  for (const target of [request.reference, request.distorted]) {
    const p = target?.picture;
    if (!target || !/^[a-f0-9]{24}$/.test(target.mediaId) || !/^[a-f0-9]{24}$/.test(target.mediaVersion)
      || !Number.isSafeInteger(target.size) || target.size < 1 || !/^[a-zA-Z0-9._-]{1,128}$/.test(target.indexBuildId)
      || !target.indexIdentity || mediaIndexIdentityKey(target.indexIdentity) !== mediaIndexIdentityKey(FLV_MEDIA_INDEX_IDENTITY)
      || !p || p.sourceVersion !== `${target.mediaId}@${target.mediaVersion}` || p.stream !== 'video'
      || p.configuration !== 0 || p.picture !== 0 || p.layer !== 0 || p.field !== 'frame'
      || !Number.isSafeInteger(p.au) || p.au < 0 || p.au >= budget.maxIndexPackets || !Number.isSafeInteger(target.sourcePtsUs))
      fail('invalid-request', 'Invalid FLV source/cache/picture identity');
  }
  if (budget.maxPackets < 2 || budget.maxOutputFrames < 2) fail('budget-exceeded', 'A pair requires two packets and two output frames');
  return budget;
}
function sameBinding(a: SourceBinding, b: SourceBinding) {
  return a.mediaId === b.mediaId && a.mediaVersion === b.mediaVersion && a.size === b.size
    && a.indexBuildId === b.indexBuildId && mediaIndexIdentityKey(a.indexIdentity) === mediaIndexIdentityKey(b.indexIdentity);
}
const u24 = (b: Uint8Array, at: number) => b[at] * 65536 + b[at + 1] * 256 + b[at + 2];
const u32 = (b: Uint8Array, at: number) => b[at] * 16777216 + u24(b, at + 1);

function configurationSets(codec: 'h264' | 'hevc', bytes: Uint8Array): Uint8Array[] {
  const sets: Uint8Array[] = []; let at = codec === 'h264' ? 6 : 23;
  const add = () => {
    if (at + 2 > bytes.length) fail('identity-mismatch', 'Truncated configuration NAL length');
    const length = bytes[at] * 256 + bytes[at + 1]; at += 2;
    if (!length || at + length > bytes.length) fail('identity-mismatch', 'Truncated configuration NAL');
    sets.push(bytes.subarray(at, at + length)); at += length;
  };
  if (codec === 'h264') {
    for (let n = bytes[5] & 31; n > 0; n--) add();
    if (at >= bytes.length) fail('identity-mismatch', 'Missing AVC PPS count');
    for (let n = bytes[at++]; n > 0; n--) add();
  } else for (let arrays = bytes[22]; arrays > 0; arrays--) {
    if (at + 3 > bytes.length) fail('identity-mismatch', 'Truncated HEVC configuration array');
    const count = bytes[at + 1] * 256 + bytes[at + 2]; at += 3;
    for (let n = count; n > 0; n--) add();
  }
  return sets;
}

export type InspectedFramePair = Pick<FramePairResult, 'decoder' | 'provenance' | 'work'> & { frames: [DecodedPairFrame, DecodedPairFrame]; sourceGeometry: {reference:HevcGeometry;distorted:HevcGeometry} };
/** Decoder display widths are rounded integers and cannot prove square SAR. */
export function requireInspectionGeometry(g:HevcGeometry) {
  if(!g||g.sarSpecified!==true||!Number.isSafeInteger(g.sarNum)||!Number.isSafeInteger(g.sarDen)||g.sarNum<1||g.sarDen<1||g.sarNum!==g.sarDen)
    fail('unsupported-source','Inspection requires square pixels proven by exact SPS SAR; non-square or missing sample aspect ratio is unsupported');
  if(g.x!==0||g.y!==0||g.width!==g.codedWidth||g.height!==g.codedHeight)
    fail('unsupported-source','Inspection requires uncropped SPS geometry');
}
/** The exact source/cache/tag/AU admission and decoder are shared by measurement
 * and explicit inspection. Inspection never invokes the numerical metric. */
async function withFlvFramePair<T>(request: FramePairRequest, sources: [CachedPairSource, CachedPairSource],
  loadDecoder: (budget: PairBudget) => Promise<PairDecoder>, signal: AbortSignal, accept: (pair: InspectedFramePair) => T, admitGeometry?: (geometry:HevcGeometry)=>void): Promise<T> {
  let decoder: PairDecoder | undefined;
  const started = performance.now(); let readBytes = 0;
  try {
    const budget = pairBudget(request);
    const check = () => {
      signal.throwIfAborted();
      if (performance.now() - started > budget.maxElapsedMs) fail('budget-exceeded', 'Pair execution deadline exceeded');
      sources.forEach((source, i) => {
        if (!sameBinding(source.binding(), i ? request.distorted : request.reference)) fail('source-changed', 'Source or cache binding changed');
      });
    };
    check();
    const frames: DecodedPairFrame[] = [], provenance: PairProvenance[] = [], sourceGeometry:HevcGeometry[]=[];
    for (let role = 0; role < 2; role++) {
      const source = sources[role], target = role ? request.distorted : request.reference;
      const doc = source.index;
      if (!doc) fail('cache-miss', 'An existing complete source-bound FLV cache is required');
      if (!Array.isArray(doc.packets) || doc.packets.length > budget.maxIndexPackets
        || JSON.stringify(doc).length > budget.maxIndexBytes) fail('budget-exceeded', 'FLV cached index budget exceeded');
      if (doc.configurations || doc.truncatedAt !== undefined || doc.recoveredGaps) fail('unsupported-source', 'v1 requires one configuration and a complete unrecovered source');
      let index;
      try { index = parseFlvIndex(doc, target.size); } catch { fail('identity-mismatch', 'Invalid cached FLV document'); }
      if (index.codec !== 'h264' && index.codec !== 'hevc') fail('unsupported-source', 'v1 supports H.264/HEVC only');
      const codec = index.codec;
      const geometry = codec === 'h264' ? avcGeometry(index.description,!!admitGeometry) : hevcGeometry(index.description,!!admitGeometry);
      if (!geometry || ('interlaced' in geometry && geometry.interlaced) || (codec === 'hevc' && hevcFieldPictures(index.description)))
        fail('unsupported-source', 'Progressive SPS geometry is required');
      admitGeometry?.(geometry);sourceGeometry.push(structuredClone(geometry));
      if (geometry.codedWidth * geometry.codedHeight > budget.maxPixels) fail('budget-exceeded', 'SPS pixel budget exceeded');
      const packet = index.packets[target.picture.au];
      if (!packet || (packet.configuration ?? 0) !== 0 || packet.pts !== target.sourcePtsUs || !packet.key
        || index.packets.filter(p => p.pts === target.sourcePtsUs).length !== 1)
        fail('identity-mismatch', 'Missing, duplicate-PTS or mismatched closed-key AU');
      if (packet.size > budget.maxPacketBytes) fail('budget-exceeded', 'Packet byte budget exceeded');
      const read = async (offset: number, length: number) => {
        check();
        if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > target.size)
          fail('identity-mismatch', 'Source read outside pinned size');
        if (readBytes + length > budget.maxReadBytes) fail('budget-exceeded', 'Source byte budget exceeded');
        readBytes += length; // Charge exact IO before the host reads or allocates.
        const bytes = await source.read(offset, length); check();
        if (bytes.length !== length) fail('source-changed', 'Short source read');
        return bytes;
      };
      // Verify source configuration and the cache's first packet without building an index.
      const prefix = (await scanFlv({ size: target.size, read }, undefined, undefined, true)).index;
      const first = index.packets[0], actual = prefix.packets[0];
      if (prefix.codec !== codec || prefix.description.length !== index.description.length
        || prefix.description.some((v, i) => v !== index.description[i])
        || ['offset', 'size', 'pts', 'dts', 'key'].some(k => first[k as keyof typeof first] !== actual[k as keyof typeof actual]))
        fail('identity-mismatch', 'Source prefix differs from cached configuration/packet');
      // Validate the selected tag itself, including its original timestamp and footer.
      const before = await read(packet.offset - 19, 19), matches: number[] = [];
      for (const skip of [5, 8]) {
        const at = 19 - 11 - skip, flags = before[at + 11], enhanced = !!(flags & 128);
        const type = enhanced ? flags & 15 : before[at + 12];
        const expectedCodec = enhanced ? String.fromCharCode(...before.subarray(at + 12, at + 16)) === (codec === 'h264' ? 'avc1' : 'hvc1')
          : (flags & 15) === (codec === 'h264' ? 7 : 12);
        const ctsAt = at + 11 + (enhanced ? 5 : 2);
        const cts = type === 3 ? 0 : (u24(before, ctsAt) << 8 >> 8) * 1000;
        const dts = (u24(before, at + 4) + before[at + 7] * 16777216) * 1000;
        if (before[at] === 9 && u24(before, at + 8) === 0 && u24(before, at + 1) === packet.size + skip
          && (flags >> 4 & 7) === 1 && expectedCodec && (enhanced ? (type === 1 && skip === 8) || (type === 3 && skip === 5) : type === 1 && skip === 5)
          && dts === packet.dts && dts + cts === packet.pts) matches.push(skip);
      }
      if (matches.length !== 1 || u32(await read(packet.offset + packet.size, 4), 0) !== 11 + matches[0] + packet.size)
        fail('identity-mismatch', 'Source tag identity differs from cached AU');
      const bytes = await read(packet.offset, packet.size);
      const evidence = inspectPacketPicture(codec, index.description, bytes);
      if (!evidence.singlePicture || !evidence.closedRandomAccess) fail('unsupported-source', 'AU is not a verified single closed picture');
      // Repeated parameter sets must byte-match the admitted configuration.
      const sets = configurationSets(codec, index.description);
      for (const range of nalRanges(codec, index.description, bytes)) {
        const nal = bytes.subarray(range.offset, range.offset + range.size);
        const type = codec === 'h264' ? nal[0] & 31 : nal[0] >> 1 & 63;
        const parameter = codec === 'h264' ? [7, 8, 13, 15].includes(type) : [32, 33, 34].includes(type);
        if (parameter ? !sets.some(set => set.length === nal.length && set.every((v, i) => v === nal[i]))
          : codec === 'h264' ? type >= 1 && type <= 5 && type !== 5 : type < 32 && type !== 19 && type !== 20)
          fail('unsupported-source', 'Closed AU changes parameter sets or contains dependent VCL');
      }
      decoder ??= await loadDecoder(budget); check();
      const frame = await decoder.decode(codec, index.description, bytes, packet.pts, packet.dts, budget); check();
      if (frame.pts !== target.sourcePtsUs) fail('identity-mismatch', 'Decoded source PTS differs from selected AU');
      if (frame.pixels.byteLength > budget.maxFrameBytes) fail('budget-exceeded', 'Decoded frame budget exceeded');
      frames.push(frame);
      provenance.push({ ...structuredClone(target), decoded: { sourcePtsUs: frame.pts, description: structuredClone(frame.description) },
        packet: { offset: packet.offset, size: packet.size, sourceDtsUs: packet.dts }, validation: 'cached-au-source-tag-isolated-closed-picture-v1' });
    }
    check();
    const work:FramePairResult['work']={readBytes,packets:2,outputFrames:2,elapsedMs:performance.now()-started};
    const value = accept({decoder:{...decoder!.version}, frames:frames as InspectedFramePair['frames'],
      provenance:{reference:provenance[0],distorted:provenance[1]},sourceGeometry:{reference:sourceGeometry[0],distorted:sourceGeometry[1]},
      work});
    work.elapsedMs=performance.now()-started;
    check();
    return value;
  } finally { try { decoder?.close(); } finally { for (const source of sources) source.close(); } }
}

/** Single-use source-plane measurement; owned killable Worker required. */
export function measureFlvFramePair(request: FramePairRequest, sources: [CachedPairSource, CachedPairSource],
  loadDecoder: (budget: PairBudget) => Promise<PairDecoder>, signal: AbortSignal): Promise<FramePairResult> {
  return withFlvFramePair(request,sources,loadDecoder,signal,pair=>{
    const metric=measurePsnr({domain:'source-yuv-code-values',reference:pair.frames[0],distorted:pair.frames[1],roi:request.roi,
      budget:{maxSamples:request.budget?.maxSamples,maxInputBytes:request.budget?.maxInputBytes}});
    return {schema:'voidplayer-frame-pair-psnr',version:1,pairing:'caller-specified',
      correspondence:'caller-specified-no-content-or-time-alignment',decoder:pair.decoder,metric,provenance:pair.provenance,work:pair.work};
  });
}
/** Explicit raw-frame inspection; same admission, no score calculation. */
export function inspectFlvFramePair(request: FramePairRequest, sources: [CachedPairSource, CachedPairSource],
  loadDecoder: (budget: PairBudget) => Promise<PairDecoder>, signal: AbortSignal): Promise<InspectedFramePair> {
  return withFlvFramePair(request,sources,loadDecoder,signal,pair=>pair,requireInspectionGeometry);
}
