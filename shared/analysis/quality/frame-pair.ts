import { measureSsim, ssimPlan } from "./ssim.ts";
import type { SsimRequest, SsimResult } from "./ssim.ts";
import type { FlvIndexDocument } from "../../media/indexing/flv-index-cache.ts";
import { qualitySourceIndex, isMp4QualityDocument } from "./source-index.ts";
import type {
  QualityIndexDocument,
  QualityVideoIndex,
} from "./source-index.ts";
import {
  readMp4QualityIndex,
  verifyMp4QualityPacket,
} from "../../media/indexing/mp4-quality-index.ts";
import type { Mp4QualitySample } from "../../media/indexing/mp4-quality-index.ts";
import {
  FLV_MEDIA_INDEX_IDENTITY,
  MP4_QUALITY_MEDIA_INDEX_IDENTITY,
  mediaIndexIdentityKey,
} from "../../media/indexing/media-index-identity.ts";
import type { MediaIndexIdentity } from "../../media/indexing/media-index-identity.ts";
import { scanFlv } from "../../media/containers/flv-demux.ts";
import type { FlvIndex } from "../../media/containers/flv-demux.ts";
import { nalRanges } from "../../media/codecs/nal-framing.ts";
import { inspectPacketPicture } from "../../media/codecs/packet-picture.ts";
import { avcGeometry } from "../../media/codecs/avc-geometry.ts";
import type { HevcGeometry } from "../../media/codecs/hevc-geometry.ts";
import {
  hevcGeometry,
  hevcFieldPictures,
} from "../../media/codecs/hevc-geometry.ts";
import type { FrameDescription } from "../../media/frame-description.ts";
import type { SourcePictureKey } from "../bitstream/contract.ts";
import { measurePsnr, psnrGridPlan } from "./psnr.ts";
import type { PsnrFrame, PsnrRequest, PsnrResult } from "./psnr.ts";

export const PAIR_LIMITS = Object.freeze({
  maxReadBytes: 16 * 1024 * 1024,
  maxPacketBytes: 8 * 1024 * 1024,
  maxIndexPackets: 250000,
  maxIndexBytes: 32 * 1024 * 1024,
  maxFrameBytes: 32 * 1024 * 1024,
  maxHeapBytes: 256 * 1024 * 1024,
  maxPixels: 4096 * 2304,
  maxElapsedMs: 30000,
  maxPackets: 2,
  maxOutputFrames: 2,
});
export const FORWARD_PAIR_LIMITS = Object.freeze({
  packetsPerSide: 512,
  maxPackets: 1024,
  maxOutputFrames: 1024,
});
/** Input/output association is not proof of reference-graph integrity. The
 * pinned packet ABI does not report decoder concealment/decode_error_flags. */
export const FORWARD_OUTPUT_GUARANTEE = Object.freeze({
  pixels: "exact-decoder-output-of-verified-input-window",
  referenceIntegrity: "not-certified",
  concealmentDetection: "unavailable",
} as const);
export type ForwardDecode = {
  mode: "forward-one-output-per-au-v1";
  startAu: number;
};
export type GopDecode = {
  mode: "packet-identity-gop-v1";
  startAu: number;
  endAu: number;
};
export type PacketOutputIdentity = {
  abi: 1;
  generation: string;
  outputs: {
    au: number;
    token: string;
    sourcePtsUs: number;
    sourceDtsUs: number;
    packetBytes: number;
    payloadHash: string;
    decodeErrorFlags: 0;
    phase: "immediate" | "drain";
  }[];
};
export const decodeEndAu = (target: PairTarget) =>
  target.decode?.mode === "packet-identity-gop-v1"
    ? target.decode.endAu
    : target.picture.au;
export const pairPacketCount = (target: PairTarget) =>
  target.decode ? decodeEndAu(target) - target.decode.startAu + 1 : 1;
export type PairPacket = {
  au: number;
  offset: number;
  size: number;
  pts: number;
  dts: number;
  key: boolean;
};
export type FramePairErrorCode =
  | import("./psnr.ts").PsnrErrorCode
  | "invalid-request"
  | "cache-miss"
  | "source-changed"
  | "identity-mismatch"
  | "unsupported-source"
  | "decoder-error"
  | "busy";
export class FramePairError extends Error {
  readonly code: FramePairErrorCode;
  readonly field?: string;
  constructor(code: FramePairErrorCode, message: string, field?: string) {
    super(message);
    this.name = "FramePairError";
    this.code = code;
    this.field = field;
  }
}
export type SourceBinding = {
  mediaId: string;
  mediaVersion: string;
  size: number;
  indexIdentity: MediaIndexIdentity;
  indexBuildId: string;
};
export type PairTarget = SourceBinding & {
  picture: SourcePictureKey;
  sourcePtsUs: number;
  decode?: ForwardDecode | GopDecode;
};
export type FramePairRequest = {
  pairing: "caller-specified";
  reference: PairTarget;
  distorted: PairTarget;
  roi: PsnrRequest["roi"];
  ssim?: SsimRequest;
  spatial?: PsnrRequest["spatial"];
  budget?: Partial<PairBudget> & PsnrRequest["budget"];
};
export type PairBudget = { -readonly [K in keyof typeof PAIR_LIMITS]: number };
/** The host must bind this cached document and reader to the same immutable source.
 * This boundary never constructs an index or consults a playback source/cursor. */
export interface CachedPairSource<
  Document extends QualityIndexDocument = FlvIndexDocument,
> {
  binding(): SourceBinding;
  index: Document | null;
  digest?(bytes: Uint8Array): Promise<string>;
  read(offset: number, length: number): Promise<Uint8Array>;
  close(): void;
}
export type DecodedPairFrame = PsnrFrame & {
  pts: number;
  outputIdentity?: PacketOutputIdentity;
};
export interface PairDecoder {
  readonly version: {
    backend: "ffmpeg-wasm";
    buildId: string;
    frameAbi: 2;
    packetIdentity:
      | "isolated-closed-au-v1"
      | "forward-one-output-per-au-v1"
      | "packet-identity-gop-v1";
    packetIdentityAbi?: 1;
  };
  decode(
    codec: "h264" | "hevc",
    configuration: Uint8Array,
    packet: Uint8Array,
    pts: number,
    dts: number,
    budget: PairBudget,
  ): Promise<DecodedPairFrame>;
  decodeForward?(
    codec: "h264" | "hevc",
    configuration: Uint8Array,
    packets: (PairPacket & { bytes: Uint8Array })[],
    budget: PairBudget,
  ): Promise<DecodedPairFrame>;
  gopFrames?(
    codec: "h264" | "hevc",
    configuration: Uint8Array,
    packets: (PairPacket & { bytes: Uint8Array })[],
    budget: PairBudget,
  ): Generator<{ au: number; frame: DecodedPairFrame }, void>;
  decodeGop?(
    codec: "h264" | "hevc",
    configuration: Uint8Array,
    packets: (PairPacket & { bytes: Uint8Array })[],
    targetAu: number,
    budget: PairBudget,
  ): Promise<DecodedPairFrame>;
  close(): void;
}
export type PairProvenance = PairTarget & {
  decoded: { sourcePtsUs: number; description: FrameDescription };
  packet: { offset: number; size: number; sourceDtsUs: number };
  dependency?: {
    packets: PairPacket[];
    outputFrames: number;
    guarantee: typeof FORWARD_OUTPUT_GUARANTEE;
    boundary?: PairPacket | null;
    outputIdentity?: PacketOutputIdentity;
  };
  container?: {
    kind: "mp4";
    trackId: number;
    timescale: number;
    tableSha256: string;
    sample: Mp4QualitySample;
  };
  validation:
    | "cached-mp4-closed-gop-packet-identity-v1"
    | "cached-au-source-tag-isolated-closed-picture-v1"
    | "cached-contiguous-forward-one-output-per-au-v1"
    | "cached-closed-gop-packet-identity-v1";
};
/** A streamed witness may grow only until drain. Scores cannot commit until
 * every admitted packet has exactly one validated output. */
export function requirePacketOutputWitness(p:PairProvenance,complete=true){
  if(p.decode?.mode!=='packet-identity-gop-v1')return;
  const dep=p.dependency,identity=dep?.outputIdentity,packets=dep?.packets;
  if(!dep||!identity||identity.abi!==1||typeof identity.generation!=='string'||!identity.generation||!packets
    ||packets.length!==pairPacketCount(p)||dep.outputFrames!==packets.length||identity.outputs.length>packets.length
    ||complete&&identity.outputs.length!==packets.length||new Set(identity.outputs.map(o=>o.au)).size!==identity.outputs.length
    ||!identity.outputs.some(o=>o.au===p.picture.au))throw new FramePairError('identity-mismatch','Incomplete or duplicate packet output witness');
  const byAu=new Map(packets.map(step=>[step.au,step]));
  for(const o of identity.outputs){const packet=byAu.get(o.au);if(!packet||o.token!==String(BigInt(o.au)+1n)||o.sourcePtsUs!==packet.pts||o.sourceDtsUs!==packet.dts||o.packetBytes!==packet.size||o.decodeErrorFlags!==0||!/^([a-f0-9]{16})$/.test(o.payloadHash)||!['immediate','drain'].includes(o.phase))throw new FramePairError('identity-mismatch','Packet output identity changed');}
}
export type FramePairResult = {
  schema: "voidplayer-frame-pair-psnr";
  version: 1;
  pairing: "caller-specified";
  correspondence: "caller-specified-no-content-or-time-alignment";
  decoder: PairDecoder["version"];
  metric: PsnrResult;
  ssim?: SsimResult;
  provenance: { reference: PairProvenance; distorted: PairProvenance };
  work: {
    accounting?: "incremental-shared-gop-v1";
    readBytes: number;
    packets: number;
    outputFrames: number;
    elapsedMs: number;
  };
};
function fail(code: FramePairError["code"], message: string): never {
  throw new FramePairError(code, message);
}
export function pairBudget(request: FramePairRequest): PairBudget {
  if (request?.pairing !== "caller-specified")
    fail("invalid-request", "Explicit cross-source correspondence is required");
  const forward = !!(request.reference?.decode || request.distorted?.decode);
  const limits = {
    ...PAIR_LIMITS,
    ...(forward
      ? {
          maxPackets: FORWARD_PAIR_LIMITS.maxPackets,
          maxOutputFrames: FORWARD_PAIR_LIMITS.maxOutputFrames,
        }
      : {}),
  };
  const budget = { ...limits } as PairBudget;
  for (const key of Object.keys(PAIR_LIMITS) as (keyof PairBudget)[]) {
    const value = request.budget?.[key];
    if (value !== undefined) {
      if (!Number.isSafeInteger(value) || value < 1 || value > limits[key])
        fail("invalid-request", `Invalid budget.${key}`);
      budget[key] = value;
    }
  }
  for (const target of [request.reference, request.distorted]) {
    const p = target?.picture;
    if (
      !target ||
      !/^[a-f0-9]{24}$/.test(target.mediaId) ||
      !/^[a-f0-9]{24}$/.test(target.mediaVersion) ||
      !Number.isSafeInteger(target.size) ||
      target.size < 1 ||
      !/^[a-zA-Z0-9._-]{1,128}$/.test(target.indexBuildId) ||
      !target.indexIdentity ||
      ![FLV_MEDIA_INDEX_IDENTITY, MP4_QUALITY_MEDIA_INDEX_IDENTITY].some(
        (id) =>
          mediaIndexIdentityKey(target.indexIdentity) ===
          mediaIndexIdentityKey(id),
      ) ||
      !p ||
      p.sourceVersion !== `${target.mediaId}@${target.mediaVersion}` ||
      p.stream !== "video" ||
      p.configuration !== 0 ||
      p.picture !== 0 ||
      p.layer !== 0 ||
      p.field !== "frame" ||
      !Number.isSafeInteger(p.au) ||
      p.au < 0 ||
      p.au >= budget.maxIndexPackets ||
      !Number.isSafeInteger(target.sourcePtsUs)
    )
      fail("invalid-request", "Invalid FLV source/cache/picture identity");
    if (
      target.indexIdentity.kind === "mp4" &&
      target.decode?.mode !== "packet-identity-gop-v1"
    )
      fail(
        "invalid-request",
        "MP4 quality requires an explicit complete bounded GOP",
      );
    if (target.decode !== undefined) {
      const d = target.decode,
        gop = d?.mode === "packet-identity-gop-v1";
      if (
        !d ||
        Object.keys(d).some(
          (key) =>
            !(
              gop ? ["mode", "startAu", "endAu"] : ["mode", "startAu"]
            ).includes(key),
        ) ||
        !["forward-one-output-per-au-v1", "packet-identity-gop-v1"].includes(
          d.mode,
        ) ||
        !Number.isSafeInteger(d.startAu) ||
        d.startAu < 0 ||
        d.startAu > p.au ||
        (!gop && d.startAu === p.au) ||
        !Number.isSafeInteger(decodeEndAu(target)) ||
        decodeEndAu(target) < p.au ||
        decodeEndAu(target) >= budget.maxIndexPackets ||
        pairPacketCount(target) > FORWARD_PAIR_LIMITS.packetsPerSide
      )
        fail(
          "invalid-request",
          "Decode requires explicit closed start/target/end and at most 512 AUs per side",
        );
    }
  }
  if (budget.maxPackets < 2 || budget.maxOutputFrames < 2)
    fail(
      "budget-exceeded",
      "A pair requires two packets and two output frames",
    );
  if (request.spatial !== undefined) psnrGridPlan(request.roi, request.spatial);
  if (request.ssim !== undefined)
    ssimPlan(request.roi, request.ssim, request.spatial);
  return budget;
}
function sameBinding(a: SourceBinding, b: SourceBinding) {
  return (
    a.mediaId === b.mediaId &&
    a.mediaVersion === b.mediaVersion &&
    a.size === b.size &&
    a.indexBuildId === b.indexBuildId &&
    mediaIndexIdentityKey(a.indexIdentity) ===
      mediaIndexIdentityKey(b.indexIdentity)
  );
}
const u24 = (b: Uint8Array, at: number) =>
  b[at] * 65536 + b[at + 1] * 256 + b[at + 2];
const u32 = (b: Uint8Array, at: number) => b[at] * 16777216 + u24(b, at + 1);

function configurationSets(
  codec: "h264" | "hevc",
  bytes: Uint8Array,
): Uint8Array[] {
  const sets: Uint8Array[] = [];
  let at = codec === "h264" ? 6 : 23;
  const add = () => {
    if (at + 2 > bytes.length)
      fail("identity-mismatch", "Truncated configuration NAL length");
    const length = bytes[at] * 256 + bytes[at + 1];
    at += 2;
    if (!length || at + length > bytes.length)
      fail("identity-mismatch", "Truncated configuration NAL");
    sets.push(bytes.subarray(at, at + length));
    at += length;
  };
  if (codec === "h264") {
    for (let n = bytes[5] & 31; n > 0; n--) add();
    if (at >= bytes.length) fail("identity-mismatch", "Missing AVC PPS count");
    for (let n = bytes[at++]; n > 0; n--) add();
  } else
    for (let arrays = bytes[22]; arrays > 0; arrays--) {
      if (at + 3 > bytes.length)
        fail("identity-mismatch", "Truncated HEVC configuration array");
      const count = bytes[at + 1] * 256 + bytes[at + 2];
      at += 3;
      for (let n = count; n > 0; n--) add();
    }
  return sets;
}

export type InspectedFramePair = Pick<
  FramePairResult,
  "decoder" | "provenance" | "work"
> & {
  frames: [DecodedPairFrame, DecodedPairFrame];
  sourceGeometry: { reference: HevcGeometry; distorted: HevcGeometry };
};
/** Decoder display widths are rounded integers and cannot prove square SAR. */
export function requireInspectionGeometry(g: HevcGeometry) {
  if (
    !g ||
    g.sarSpecified !== true ||
    !Number.isSafeInteger(g.sarNum) ||
    !Number.isSafeInteger(g.sarDen) ||
    g.sarNum < 1 ||
    g.sarDen < 1 ||
    g.sarNum !== g.sarDen
  )
    fail(
      "unsupported-source",
      "Inspection requires square pixels proven by exact SPS SAR; non-square or missing sample aspect ratio is unsupported",
    );
  if (
    g.x !== 0 ||
    g.y !== 0 ||
    g.width !== g.codedWidth ||
    g.height !== g.codedHeight
  )
    fail("unsupported-source", "Inspection requires uncropped SPS geometry");
}
/** A contiguous decode-order prefix, not an inferred reference graph. Unique
 * zero-CTS clocks plus exactly one immediate decoder output per input establish
 * the target association. Reordering/delayed output is deliberately unsupported. */
export function forwardPacketPlan(
  index: QualityVideoIndex,
  target: PairTarget,
  counts?: Map<number, number>,
): PairPacket[] {
  const start = target.decode?.startAu,
    end = target.picture.au;
  if (
    start === undefined ||
    start < 0 ||
    start >= end ||
    end - start + 1 > FORWARD_PAIR_LIMITS.packetsPerSide
  )
    fail("invalid-request", "Invalid forward decode window");
  counts ??= new Map();
  if (!counts.size)
    for (const p of index.packets)
      counts.set(p.pts, (counts.get(p.pts) ?? 0) + 1);
  const packets: PairPacket[] = [];
  for (let au = start; au <= end; au++) {
    const p = index.packets[au],
      previous = packets.at(-1);
    if (
      !p ||
      (p.configuration ?? 0) !== 0 ||
      p.discontinuity ||
      p.key !== (au === start) ||
      p.pts !== p.dts ||
      counts.get(p.pts) !== 1 ||
      (previous && p.pts <= previous.pts)
    )
      fail(
        "unsupported-source",
        "Forward decode needs a closed-key candidate followed by contiguous unique zero-CTS non-key AUs without reordering",
      );
    packets.push({
      au,
      offset: p.offset,
      size: p.size,
      pts: p.pts,
      dts: p.dts,
      key: p.key,
    });
  }
  if (packets.at(-1)!.pts !== target.sourcePtsUs)
    fail("identity-mismatch", "Forward target PTS differs from its AU");
  return packets;
}
/** Full cached GOP, bounded by the next key candidate or final source end.
 * The actual closing IDR bytes are checked separately before decoding. */
export function gopPacketPlan(
  index: QualityVideoIndex,
  target: PairTarget,
  counts?: Map<number, number>,
): PairPacket[] {
  if (target.decode?.mode !== "packet-identity-gop-v1")
    fail("invalid-request", "Explicit packet identity GOP required");
  const { startAu, endAu } = target.decode;
  if (
    !Number.isSafeInteger(startAu) ||
    !Number.isSafeInteger(endAu) ||
    startAu < 0 ||
    startAu > target.picture.au ||
    endAu < target.picture.au ||
    endAu - startAu + 1 > FORWARD_PAIR_LIMITS.packetsPerSide ||
    endAu >= index.packets.length
  )
    fail("invalid-request", "Invalid bounded GOP window");
  counts ??= new Map();
  if (!counts.size)
    for (const p of index.packets)
      counts.set(p.pts, (counts.get(p.pts) ?? 0) + 1);
  if (endAu + 1 < index.packets.length && !index.packets[endAu + 1].key)
    fail(
      "unsupported-source",
      "GOP end must precede the next closed IDR or source end",
    );
  const packets: PairPacket[] = [];
  for (let au = startAu; au <= endAu; au++) {
    const p = index.packets[au],
      previous = packets.at(-1);
    if (
      !p ||
      (p.configuration ?? 0) !== 0 ||
      p.discontinuity ||
      p.key !== (au === startAu) ||
      !Number.isSafeInteger(p.pts) ||
      !Number.isSafeInteger(p.dts) ||
      counts.get(p.pts) !== 1 ||
      p.pts < index.packets[startAu].pts ||
      (previous && p.dts <= previous.dts)
    )
      fail(
        "unsupported-source",
        "GOP needs unique known clocks, increasing DTS and one closed start without configuration or recovery changes",
      );
    packets.push({
      au,
      offset: p.offset,
      size: p.size,
      pts: p.pts,
      dts: p.dts,
      key: p.key,
    });
  }
  if (index.packets[target.picture.au].pts !== target.sourcePtsUs)
    fail("identity-mismatch", "GOP target source PTS changed");
  return packets;
}
type PreparedSourceCache = { index?: QualityVideoIndex; verified?: boolean };
async function preparePairSource(
  target: PairTarget,
  source: CachedPairSource<QualityIndexDocument>,
  budget: PairBudget,
  check: () => void,
  read: (offset: number, length: number) => Promise<Uint8Array>,
  admitGeometry?: (g: HevcGeometry) => void,
  cache: PreparedSourceCache = {},
) {
  const doc = source.index;
  if (!doc)
    fail(
      "cache-miss",
      "An existing complete source-bound FLV cache is required",
    );
  if (
    (isMp4QualityDocument(doc) ? doc.samples.length : doc.packets.length) >
      budget.maxIndexPackets ||
    JSON.stringify(doc).length > budget.maxIndexBytes
  )
    fail("budget-exceeded", "FLV cached index budget exceeded");
  let index = cache.index;
  try {
    index ??= qualitySourceIndex(doc, target.size);
    cache.index = index;
  } catch {
    fail("identity-mismatch", "Invalid cached FLV document");
  }
  if (
    index.configurations ||
    index.truncatedAt !== undefined ||
    index.recoveredGaps
  )
    fail(
      "unsupported-source",
      "Quality requires one configuration and a complete unrecovered source",
    );
  if ((index.container === "mp4") !== (target.indexIdentity.kind === "mp4"))
    fail("identity-mismatch", "Container and cache identity differ");
  if (index.codec !== "h264" && index.codec !== "hevc")
    fail("unsupported-source", "v1 supports H.264/HEVC only");
  const codec = index.codec;
  const geometry =
    codec === "h264"
      ? avcGeometry(index.description, !!admitGeometry || !!index.mp4)
      : hevcGeometry(index.description, !!admitGeometry || !!index.mp4);
  if (
    !geometry ||
    ("interlaced" in geometry && geometry.interlaced) ||
    (codec === "hevc" && hevcFieldPictures(index.description))
  )
    fail("unsupported-source", "Progressive SPS geometry is required");
  if (index.mp4) requireInspectionGeometry(geometry);
  admitGeometry?.(geometry);
  if (geometry.codedWidth * geometry.codedHeight > budget.maxPixels)
    fail("budget-exceeded", "SPS pixel budget exceeded");
  const packet = index.packets[target.picture.au];
  if (
    !packet ||
    (packet.configuration ?? 0) !== 0 ||
    packet.pts !== target.sourcePtsUs ||
    (!target.decode && !packet.key) ||
    index.packets.filter((p) => p.pts === target.sourcePtsUs).length !== 1
  )
    fail(
      "identity-mismatch",
      "Missing, duplicate-PTS or mismatched closed-key AU",
    );
  const gop = target.decode?.mode === "packet-identity-gop-v1";
  const plan = target.decode
    ? gop
      ? gopPacketPlan(index, target)
      : forwardPacketPlan(index, target)
    : [
        {
          au: target.picture.au,
          offset: packet.offset,
          size: packet.size,
          pts: packet.pts,
          dts: packet.dts,
          key: packet.key,
        },
      ];
  if (plan.some((p) => p.size > budget.maxPacketBytes))
    fail("budget-exceeded", "Packet byte budget exceeded");
  if (!cache.verified) {
    if (index.mp4) {
      if (!source.digest)
        fail(
          "identity-mismatch",
          "MP4 source requires metadata digest verification",
        );
      const actual = await readMp4QualityIndex(
        { size: target.size, read },
        { digest: source.digest!, validatePayloads: false, check },
      );
      if (JSON.stringify(actual.document) !== JSON.stringify(doc))
        fail(
          "identity-mismatch",
          "MP4 source tables/configuration differ from the trusted cache",
        );
    } else {
      // Verify source configuration and the cache's first packet without building an index.
      const prefix = (
        await scanFlv({ size: target.size, read }, undefined, undefined, true)
      ).index;
      const first = index.packets[0],
        actual = prefix.packets[0];
      if (
        prefix.codec !== codec ||
        prefix.description.length !== index.description.length ||
        prefix.description.some((v, i) => v !== index.description[i]) ||
        ["offset", "size", "pts", "dts", "key"].some(
          (k) =>
            first[k as keyof typeof first] !== actual[k as keyof typeof actual],
        )
      )
        fail(
          "identity-mismatch",
          "Source prefix differs from cached configuration/packet",
        );
    }
    cache.verified = true;
  }
  const sets = configurationSets(codec, index.description),
    inputs: (PairPacket & { bytes: Uint8Array })[] = [];
  const boundary =
    gop && decodeEndAu(target) + 1 < index.packets.length
      ? {
          au: decodeEndAu(target) + 1,
          ...index.packets[decodeEndAu(target) + 1],
        }
      : null;
  if (boundary && boundary.size > budget.maxPacketBytes)
    fail("budget-exceeded", "Closing IDR packet exceeds byte budget");
  for (const packet of [...plan, ...(boundary ? [boundary] : [])]) {
    if (!index.mp4) {
      // Validate every dependency tag, original timestamp/key flag and footer.
      const before = await read(packet.offset - 19, 19),
        matches: number[] = [];
      for (const skip of [5, 8]) {
        const at = 19 - 11 - skip,
          flags = before[at + 11],
          enhanced = !!(flags & 128);
        const type = enhanced ? flags & 15 : before[at + 12];
        const expectedCodec = enhanced
          ? String.fromCharCode(...before.subarray(at + 12, at + 16)) ===
            (codec === "h264" ? "avc1" : "hvc1")
          : (flags & 15) === (codec === "h264" ? 7 : 12);
        const ctsAt = at + 11 + (enhanced ? 5 : 2);
        const cts = type === 3 ? 0 : ((u24(before, ctsAt) << 8) >> 8) * 1000;
        const dts = (u24(before, at + 4) + before[at + 7] * 16777216) * 1000;
        if (
          before[at] === 9 &&
          u24(before, at + 8) === 0 &&
          u24(before, at + 1) === packet.size + skip &&
          ((flags >> 4) & 7) === (packet.key ? 1 : 2) &&
          expectedCodec &&
          (enhanced
            ? (type === 1 && skip === 8) || (type === 3 && skip === 5)
            : type === 1 && skip === 5) &&
          dts === packet.dts &&
          dts + cts === packet.pts
        )
          matches.push(skip);
      }
      if (
        matches.length !== 1 ||
        u32(await read(packet.offset + packet.size, 4), 0) !==
          11 + matches[0] + packet.size
      )
        fail("identity-mismatch", "Source tag identity differs from cached AU");
    }
    const bytes = await read(packet.offset, packet.size);
    if (index.mp4)
      try {
        verifyMp4QualityPacket(index.mp4, index.mp4.samples[packet.au], bytes);
      } catch (e) {
        fail("unsupported-source", (e as Error).message);
      }
    const evidence = inspectPacketPicture(codec, index.description, bytes);
    if (!evidence.singlePicture || evidence.closedRandomAccess !== packet.key)
      fail(
        "unsupported-source",
        "AU is not a verified single picture with the declared closed/key status",
      );
    // Repeated parameter sets must byte-match the admitted configuration.
    for (const range of nalRanges(codec, index.description, bytes)) {
      const nal = bytes.subarray(range.offset, range.offset + range.size);
      const type = codec === "h264" ? nal[0] & 31 : (nal[0] >> 1) & 63;
      const parameter =
        codec === "h264"
          ? [7, 8, 13, 15].includes(type)
          : [32, 33, 34].includes(type);
      if (
        parameter
          ? !sets.some(
              (set) =>
                set.length === nal.length && set.every((v, i) => v === nal[i]),
            )
          : !target.decode &&
            (codec === "h264"
              ? type >= 1 && type <= 5 && type !== 5
              : type < 32 && type !== 19 && type !== 20)
      )
        fail(
          "unsupported-source",
          "Closed AU changes parameter sets or contains dependent VCL",
        );
    }
    if (packet !== boundary) inputs.push({ ...packet, bytes });
  }
  return { index, codec, geometry, packet, plan, inputs, boundary, gop };
}
type PreparedPairSource = Awaited<ReturnType<typeof preparePairSource>>;
function inspectedSourceFrame(
  target: PairTarget,
  prepared: PreparedPairSource,
  frame: DecodedPairFrame,
  budget: PairBudget,
): PairProvenance {
  const { index, codec, packet, plan, boundary, gop } = prepared;
  if (index.mp4) {
    const d = frame.description,
      c = d.color,
      y = d.yuv;
    if (
      !y ||
      (codec === "h264" ? y.bitDepth !== 8 : ![8, 10].includes(y.bitDepth)) ||
      y.subsampleX !== 1 ||
      y.subsampleY !== 1 ||
      c.primaries !== "bt709" ||
      c.transfer !== "bt709" ||
      c.matrix !== "bt709" ||
      c.fullRange !== index.mp4.color.fullRange
    )
      fail(
        "unsupported-source",
        "MP4 decoder output must match the declared SDR 4:2:0 pixel domain",
      );
  }
  if (frame.pts !== target.sourcePtsUs)
    fail("identity-mismatch", "Decoded source PTS differs from selected AU");
  if (frame.pixels.byteLength > budget.maxFrameBytes)
    fail("budget-exceeded", "Decoded frame budget exceeded");
  return {
    ...structuredClone(target),
    decoded: {
      sourcePtsUs: frame.pts,
      description: structuredClone(frame.description),
    },
    packet: {
      offset: packet.offset,
      size: packet.size,
      sourceDtsUs: packet.dts,
    },
    ...(target.decode
      ? {
          dependency: {
            packets: plan,
            outputFrames: plan.length,
            guarantee: { ...FORWARD_OUTPUT_GUARANTEE },
            ...(gop
              ? {
                  boundary: boundary
                    ? {
                        au: boundary.au,
                        offset: boundary.offset,
                        size: boundary.size,
                        pts: boundary.pts,
                        dts: boundary.dts,
                        key: boundary.key,
                      }
                    : null,
                  outputIdentity: frame.outputIdentity,
                }
              : {}),
          },
        }
      : {}),
    ...(index.mp4
      ? {
          container: {
            kind: "mp4" as const,
            trackId: index.mp4.trackId,
            timescale: index.mp4.timescale,
            tableSha256: index.mp4.moov.sha256,
            sample: structuredClone(index.mp4.samples[target.picture.au]),
          },
        }
      : {}),
    validation: index.mp4
      ? "cached-mp4-closed-gop-packet-identity-v1"
      : gop
        ? "cached-closed-gop-packet-identity-v1"
        : target.decode
          ? "cached-contiguous-forward-one-output-per-au-v1"
          : "cached-au-source-tag-isolated-closed-picture-v1",
  };
}

/** The exact source/cache/tag/AU admission and decoder are shared by measurement
 * and explicit inspection. Inspection never invokes the numerical metric. */
async function withFramePair<T>(
  request: FramePairRequest,
  sources: [
    CachedPairSource<QualityIndexDocument>,
    CachedPairSource<QualityIndexDocument>,
  ],
  loadDecoder: (budget: PairBudget) => Promise<PairDecoder>,
  signal: AbortSignal,
  accept: (pair: InspectedFramePair) => T,
  admitGeometry?: (geometry: HevcGeometry) => void,
  roles = 2,
): Promise<T> {
  let decoder: PairDecoder | undefined;
  const started = performance.now();
  let readBytes = 0,
    packetsUsed = 0,
    outputFrames = 0;
  try {
    const budget = pairBudget(request);
    const check = () => {
      signal.throwIfAborted();
      if (performance.now() - started > budget.maxElapsedMs)
        fail("budget-exceeded", "Pair execution deadline exceeded");
      sources.forEach((source, i) => {
        if (
          !sameBinding(
            source.binding(),
            i ? request.distorted : request.reference,
          )
        )
          fail("source-changed", "Source or cache binding changed");
      });
    };
    check();
    const frames: DecodedPairFrame[] = [],
      provenance: PairProvenance[] = [],
      sourceGeometry: HevcGeometry[] = [];
    for (let role = 0; role < roles; role++) {
      const source = sources[role],
        target = role ? request.distorted : request.reference;
      const read = async (offset: number, length: number) => {
        check();
        if (
          !Number.isSafeInteger(offset) ||
          !Number.isSafeInteger(length) ||
          offset < 0 ||
          length < 0 ||
          offset + length > target.size
        )
          fail("identity-mismatch", "Source read outside pinned size");
        if (readBytes + length > budget.maxReadBytes)
          fail("budget-exceeded", "Source byte budget exceeded");
        readBytes += length; // Charge exact IO before the host reads or allocates.
        const bytes = await source.read(offset, length);
        check();
        if (bytes.length !== length)
          fail("source-changed", "Short source read");
        return bytes;
      };
      const prepared = await preparePairSource(
        target,
        source,
        budget,
        check,
        read,
        admitGeometry,
      );
      const { codec, index, inputs, packet, plan, gop, geometry } = prepared;
      if (
        packetsUsed + plan.length > budget.maxPackets ||
        outputFrames + plan.length > budget.maxOutputFrames
      )
        fail("budget-exceeded", "Decode window packet/output budget exceeded");
      packetsUsed += plan.length;
      sourceGeometry.push(structuredClone(geometry));
      decoder ??= await loadDecoder(budget);
      check();
      if (target.decode && !(gop ? decoder.decodeGop : decoder.decodeForward))
        fail(
          "decoder-error",
          "Required exact packet decoder ABI is unavailable",
        );
      const frame = target.decode
        ? gop
          ? await decoder.decodeGop!(
              codec,
              index.description,
              inputs,
              target.picture.au,
              budget,
            )
          : await decoder.decodeForward!(
              codec,
              index.description,
              inputs,
              budget,
            )
        : await decoder.decode(
            codec,
            index.description,
            inputs[0].bytes,
            packet.pts,
            packet.dts,
            budget,
          );
      check();
      outputFrames += plan.length;
      provenance.push(inspectedSourceFrame(target, prepared, frame, budget));
      frames.push(frame);
    }
    check();
    const work: FramePairResult["work"] = {
      readBytes,
      packets: packetsUsed,
      outputFrames,
      elapsedMs: performance.now() - started,
    };
    const value = accept({
      decoder: { ...decoder!.version },
      frames: frames as InspectedFramePair["frames"],
      provenance: { reference: provenance[0], distorted: provenance[1] },
      sourceGeometry: {
        reference: sourceGeometry[0],
        distorted: sourceGeometry[1],
      },
      work,
    });
    work.elapsedMs = performance.now() - started;
    check();
    return value;
  } finally {
    try {
      decoder?.close();
    } finally {
      for (const source of sources) source.close();
    }
  }
}

/** Single-use source-plane measurement; owned killable Worker required. */
export function measureFramePair(
  request: FramePairRequest,
  sources: [
    CachedPairSource<QualityIndexDocument>,
    CachedPairSource<QualityIndexDocument>,
  ],
  loadDecoder: (budget: PairBudget) => Promise<PairDecoder>,
  signal: AbortSignal,
): Promise<FramePairResult> {
  return withFramePair(request, sources, loadDecoder, signal, (pair) => {
    const metric = measurePsnr({
      domain: "source-yuv-code-values",
      reference: pair.frames[0],
      distorted: pair.frames[1],
      roi: request.roi,
      spatial: request.spatial,
      budget: {
        maxSamples: request.budget?.maxSamples,
        maxInputBytes: request.budget?.maxInputBytes,
      },
    });
    const ssim =
      request.ssim === undefined
        ? undefined
        : measureSsim(
            {
              domain: "source-yuv-code-values",
              reference: pair.frames[0],
              distorted: pair.frames[1],
              roi: request.roi,
              spatial: request.spatial,
              budget: {
                maxSamples: request.budget?.maxSamples,
                maxInputBytes: request.budget?.maxInputBytes,
              },
            },
            request.ssim,
          );
    return {
      schema: "voidplayer-frame-pair-psnr",
      version: 1,
      pairing: "caller-specified",
      correspondence: "caller-specified-no-content-or-time-alignment",
      decoder: pair.decoder,
      metric,
      ...(ssim ? { ssim } : {}),
      provenance: pair.provenance,
      work: pair.work,
    };
  });
}
/** Explicit raw-frame inspection; same admission, no score calculation. */
export function inspectFramePair(
  request: FramePairRequest,
  sources: [
    CachedPairSource<QualityIndexDocument>,
    CachedPairSource<QualityIndexDocument>,
  ],
  loadDecoder: (budget: PairBudget) => Promise<PairDecoder>,
  signal: AbortSignal,
): Promise<InspectedFramePair> {
  return withFramePair(
    request,
    sources,
    loadDecoder,
    signal,
    (pair) => pair,
    requireInspectionGeometry,
  );
}

/** Single-source admission and decode. No reference relation or numerical metric. */
export async function inspectSourceFrame(
  target: PairTarget,
  source: CachedPairSource<QualityIndexDocument>,
  loadDecoder: (budget: PairBudget) => Promise<PairDecoder>,
  signal: AbortSignal,
  budget?: Partial<PairBudget>,
) {
  return withFramePair(
    {
      pairing: "caller-specified",
      reference: target,
      distorted: target,
      roi: { x: 0, y: 0, width: 2, height: 2 },
      budget,
    },
    [source, source],
    loadDecoder,
    signal,
    (p) => ({
      frame: p.frames[0],
      provenance: p.provenance.reference,
      decoder: p.decoder,
      sourceGeometry: p.sourceGeometry.reference,
      work: p.work,
    }),
    requireInspectionGeometry,
    1,
  );
}

/** Existing FLV entry retains its original rejection boundary. */
export function inspectFlvFrame(
  ...args: Parameters<typeof inspectSourceFrame>
) {
  if (args[0].indexIdentity.kind !== "flv")
    return Promise.reject(
      new FramePairError(
        "unsupported-source",
        "FLV single-source inspection required",
      ),
    );
  return inspectSourceFrame(...args);
}

/** Compatibility wrappers retain the original FLV-only entry contract. */
export function measureFlvFramePair(
  ...args: Parameters<typeof measureFramePair>
) {
  if (
    args[0].reference.indexIdentity.kind !== "flv" ||
    args[0].distorted.indexIdentity.kind !== "flv"
  )
    return Promise.reject(
      new FramePairError("unsupported-source", "FLV source required"),
    );
  return measureFramePair(...args);
}
export function inspectFlvFramePair(
  ...args: Parameters<typeof inspectFramePair>
) {
  if (
    args[0].reference.indexIdentity.kind !== "flv" ||
    args[0].distorted.indexIdentity.kind !== "flv"
  )
    return Promise.reject(
      new FramePairError(
        "unsupported-source",
        "FLV inspection source required",
      ),
    );
  return inspectFramePair(...args);
}

/** Continuous source-plane execution. Each side holds one decoder context and
 * one copied output; advancing is driven by the consumer, never a frame queue.
 * A full GOP witness is provisional until its drain has completed. Consumers
 * must finish this iterator before committing scores or publishing evidence. */
async function* inspectSequence(
  requests: readonly FramePairRequest[],
  sources: [
    CachedPairSource<QualityIndexDocument>,
    CachedPairSource<QualityIndexDocument>,
  ],
  loadDecoder: (budget: PairBudget) => Promise<PairDecoder>,
  signal: AbortSignal,
  sides: 1 | 2,
): AsyncGenerator<InspectedFramePair, void> {
  let decoder: PairDecoder | undefined;
  type Stream = {
    window: string;
    prepared: PreparedPairSource;
    iterator: Generator<{ au: number; frame: DecodedPairFrame }, void>;
    lastPts: number;
  };
  const streams: (Stream | undefined)[] = [],
    caches: PreparedSourceCache[] = [{}, {}];
  let readBytes = 0,
    packets = 0,
    outputs = 0,
    previousRead = 0,
    previousPackets = 0,
    previousOutputs = 0;
  const check = () => {
    signal.throwIfAborted();
    for (let side = 0; side < sides; side++)
      if (
        !sameBinding(
          sources[side].binding(),
          side ? requests[0].distorted : requests[0].reference,
        )
      )
        fail("source-changed", "Sequence source binding changed");
  };
  const drain = (stream: Stream | undefined) => {
    if (stream)
      for (;;) {
        check();
        if (stream.iterator.next().done) break;
      }
  };
  try {
    if (!requests.length) fail("invalid-request", "Empty frame sequence");
    for (const request of requests) {
      const started = performance.now(),
        budget = pairBudget(request),
        frames: DecodedPairFrame[] = [],
        provenance: PairProvenance[] = [],
        geometry: HevcGeometry[] = [];
      const timed = () => {
        check();
        if (performance.now() - started > budget.maxElapsedMs)
          fail("budget-exceeded", "Sequence frame deadline exceeded");
      };
      timed();
      for (let side = 0; side < sides; side++) {
        const target = side ? request.distorted : request.reference,
          source = sources[side];
        if (
          !sameBinding(
            target,
            side ? requests[0].distorted : requests[0].reference,
          )
        )
          fail("identity-mismatch", "Sequence source changed");
        if (target.decode?.mode !== "packet-identity-gop-v1")
          fail(
            "unsupported-source",
            "Streaming sequence requires a complete packet-identity GOP",
          );
        const window = `${target.decode.startAu}:${target.decode.endAu}`;
        let stream = streams[side];
        if (!stream || stream.window !== window) {
          drain(stream);
          let windowBytes = 0;
          const read = async (offset: number, length: number) => {
            timed();
            if (
              !Number.isSafeInteger(offset) ||
              !Number.isSafeInteger(length) ||
              offset < 0 ||
              length < 0 ||
              offset + length > target.size
            )
              fail("identity-mismatch", "Read outside source");
            if (
              windowBytes + length > budget.maxReadBytes ||
              readBytes - previousRead + length > budget.maxReadBytes
            )
              fail("budget-exceeded", "GOP source byte budget exceeded");
            windowBytes += length;
            readBytes += length;
            const bytes = await source.read(offset, length);
            timed();
            if (bytes.length !== length)
              fail("source-changed", "Short source read");
            return bytes;
          };
          const prepared = await preparePairSource(
            target,
            source,
            budget,
            timed,
            read,
            requireInspectionGeometry,
            caches[side],
          );
          if (
            prepared.plan.length > budget.maxPackets ||
            prepared.plan.length > budget.maxOutputFrames
          )
            fail("budget-exceeded", "GOP packet/output budget exceeded");
          decoder ??= await loadDecoder(budget);
          if (!decoder.gopFrames)
            fail(
              "decoder-error",
              "Streaming packet identity decoder unavailable",
            );
          packets += prepared.plan.length;
          outputs += prepared.plan.length;
          stream = {
            window,
            prepared,
            iterator: decoder.gopFrames!(
              prepared.codec,
              prepared.index.description,
              prepared.inputs,
              budget,
            ),
            lastPts: -Infinity,
          };
          streams[side] = stream;
        }
        if (target.sourcePtsUs <= stream.lastPts)
          fail(
            "identity-mismatch",
            "Sequence must advance in presentation order",
          );
        let frame: DecodedPairFrame | undefined;
        for (;;) {
          timed();
          const next = stream.iterator.next();
          if (next.done) break;
          if (next.value.au === target.picture.au) {
            frame = next.value.frame;
            break;
          }
          if (next.value.frame.pts >= target.sourcePtsUs)
            fail(
              "identity-mismatch",
              "Exact selected AU was skipped or reordered",
            );
        }
        if (!frame)
          fail(
            "identity-mismatch",
            "Sequence target missing from its complete GOP",
          );
        stream.lastPts = target.sourcePtsUs;
        const packet = stream.prepared.index.packets[target.picture.au];
        provenance.push(
          inspectedSourceFrame(
            target,
            { ...stream.prepared, packet },
            frame!,
            budget,
          ),
        );
        frames.push(frame!);
        geometry.push(stream.prepared.geometry);
      }
      timed();
      const work = {
        accounting: "incremental-shared-gop-v1" as const,
        readBytes: readBytes - previousRead,
        packets: packets - previousPackets,
        outputFrames: outputs - previousOutputs,
        elapsedMs: performance.now() - started,
      };
      previousRead = readBytes;
      previousPackets = packets;
      previousOutputs = outputs;
      yield {
        decoder: { ...decoder!.version },
        frames: [frames[0], frames[1] ?? frames[0]],
        provenance: { reference: provenance[0], distorted: provenance[1] ?? provenance[0] },
        sourceGeometry: { reference: geometry[0], distorted: geometry[1] ?? geometry[0] },
        work,
      };
    }
    for (const stream of streams) drain(stream);
    check();
  } finally {
    try {
      for (const stream of streams) stream?.iterator.return();
      decoder?.close();
    } finally {
      for (const source of new Set(sources)) source.close();
    }
  }
}

/** Pair and single-source metrics share the same identity/drain machinery. */
export function inspectFrameSequence(requests:readonly FramePairRequest[],sources:[CachedPairSource<QualityIndexDocument>,CachedPairSource<QualityIndexDocument>],loadDecoder:(budget:PairBudget)=>Promise<PairDecoder>,signal:AbortSignal){return inspectSequence(requests,sources,loadDecoder,signal,2);}
export async function* inspectSourceSequence(targets:readonly PairTarget[],source:CachedPairSource<QualityIndexDocument>,loadDecoder:(budget:PairBudget)=>Promise<PairDecoder>,signal:AbortSignal,budget?:Partial<PairBudget>){
  const requests=targets.map(target=>({pairing:'caller-specified' as const,reference:target,distorted:target,roi:{x:0,y:0,width:2,height:2},budget}));
  for await(const pair of inspectSequence(requests,[source,source],loadDecoder,signal,1))yield {frame:pair.frames[0],provenance:pair.provenance.reference,decoder:pair.decoder,sourceGeometry:pair.sourceGeometry.reference,work:pair.work};
}
