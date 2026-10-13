import { parseMediaIndexIdentity } from "../media-index-identity.ts";
import { validateDiagram, validateContainerHeader } from "./diagrams.ts";
import type { FrameDescription } from "../frame-description.ts";
import { AnalysisFailure, ANALYSIS_REASON_CODES } from "./failure.ts";
import type { AnalysisReasonCode } from "./failure.ts";
export const ANALYSIS_SCHEMA = 1;
export const ANALYSIS_RECIPE = "blocks-basic-v2";
export const ANALYZER_VERSION = "0.1.0";
export interface SourcePictureKey {
  sourceVersion: string;
  stream: string;
  configuration: number;
  au: number;
  picture: 0;
  layer: 0;
  field: "frame";
}
export interface PresentedFrameToken {
  slot: string;
  generation: number;
  commit: number;
  picture: SourcePictureKey | null;
  identityReason?: string;
  sourcePtsUs: number;
  normalizedMediaUs: number;
  timeMapping: "source-microseconds-minus-first-pts";
  geometry: Pick<
    FrameDescription,
    | "codedWidth"
    | "codedHeight"
    | "visibleRect"
    | "displayWidth"
    | "displayHeight"
  > & { rotation: number };
}
export interface AnalysisBlock {
  x: number;
  y: number;
  width: number;
  height: number;
  qp: number | null;
  mode: "intra" | "inter" | "skip";
}
export interface AnalysisGop {
  /** Half-open AU interval in stable decode order, matching packet index ordinals. */
  startAu: number;
  endAu: number;
  configuration: number;
  anchor: 'unknown' | 'closed' | 'dependent';
}
export interface AnalysisStreamTarget {
  mode: 'stream';
  indexIdentity?: import('../media-index-identity.ts').MediaIndexIdentity;
  sourceVersion: string;
  firstPtsUs: number;
  durationUs: number;
}
export function validateStream(target: AnalysisStreamTarget) {
  if (!target || target.mode !== 'stream') throw new AnalysisFailure('invalid-request', 'Invalid stream request');
  validateTarget({ sourceVersion: target.sourceVersion, sourcePtsUs: target.firstPtsUs, normalizedMediaUs: 0 });
  validateIndexIdentity(target.indexIdentity);
  if (!Number.isSafeInteger(target.durationUs) || target.durationUs <= 0)
    throw new AnalysisFailure('invalid-request', 'Invalid stream duration');
}
export interface AnalysisResult {
  containerHeader?: import("./diagrams.ts").ContainerHeader;
  nalus?: import("./diagrams.ts").NaluRecord[];
  references?: import("./diagrams.ts").PictureReferences;
  /** Optional storage grouping; independent of decoder/reference lifetime. */
  gop?: AnalysisGop;
  schema: 1;
  codec: "h264" | "hevc" | "vvc";
  analyzerVersion: string;
  buildId: string;
  recipe: string;
  picture: SourcePictureKey;
  sourcePtsUs: number;
  /** Source packet DTS; optional for older cached results, never inferred from PTS. */
  sourceDtsUs?: number | null;
  width: number;
  height: number;
  confidence: "exact" | "partial";
  reasons: string[];
  reasonCodes?: AnalysisReasonCode[];
  capabilities: {
    blocks: "ready" | "unsupported";
    qp: "ready" | "unsupported";
    modes: "ready" | "unsupported";
    motion: "unsupported";
  };
  qp: {
    component: "luma";
    bitDepth: number;
    weighting: "pixel-area";
    mean: number | null;
  };
  blocks: AnalysisBlock[];
  metrics: {
    startAu: number;
    packets: number;
    bytesRead: number;
    elapsedMs: number;
    recordBytes: number;
    heapBytes: number;
  };
}
export type DeepReadonly<T> = T extends object
  ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
  : T;
export type ReadonlyAnalysisResult = DeepReadonly<AnalysisResult>;
export interface AnalysisTarget {
  indexIdentity?: import('../media-index-identity.ts').MediaIndexIdentity;
  sourceVersion: string;
  sourcePtsUs: number;
  normalizedMediaUs: number;
  picture?: SourcePictureKey;
}
export interface AnalysisRangeTarget {
  indexIdentity?: import('../media-index-identity.ts').MediaIndexIdentity;
  sourceVersion: string;
  firstPtsUs: number;
  startUs: number;
  endUs: number;
}
export function validateRange(target: AnalysisRangeTarget) {
  validateIndexIdentity(target?.indexIdentity);
  if (
    !target ||
    typeof target.sourceVersion !== "string" ||
    !target.sourceVersion ||
    target.sourceVersion.length > 256 ||
    ![target.firstPtsUs, target.startUs, target.endUs].every(
      Number.isSafeInteger,
    ) ||
    target.startUs < 0 ||
    target.endUs <= target.startUs
  )
    throw new AnalysisFailure(
      "invalid-request",
      "Invalid bounded analysis range",
    );
  if (target.endUs - target.startUs > 1000000)
    throw new AnalysisFailure(
      "resource-limit",
      "Analysis interval budget exceeded",
    );
}
export const BUDGET = Object.freeze({
  packets: 300,
  inputBytes: 32 * 1024 * 1024,
  packetBytes: 8 * 1024 * 1024,
  blocks: 131072,
  resultBytes: 8 * 1024 * 1024,
  cacheBytes: 32 * 1024 * 1024,
  requests: 32,
  leaseMs: 30000,
});
export function pictureId(key: SourcePictureKey): string {
  return JSON.stringify([
    key.sourceVersion,
    key.stream,
    key.configuration,
    key.au,
    key.picture,
    key.layer,
    key.field,
  ]);
}
export function validateTarget(target: AnalysisTarget): void {
  if (
    !target ||
    typeof target.sourceVersion !== "string" ||
    !target.sourceVersion ||
    target.sourceVersion.length > 256 ||
    !Number.isSafeInteger(target.sourcePtsUs) ||
    !Number.isSafeInteger(target.normalizedMediaUs) ||
    target.normalizedMediaUs < 0
  )
    throw new AnalysisFailure("invalid-request", "Invalid analysis target");
  if (
    target.picture &&
    (target.picture.sourceVersion !== target.sourceVersion ||
      !Number.isSafeInteger(target.picture.au) ||
      target.picture.au < 0 ||
      target.picture.au >= 2000000 ||
      !Number.isInteger(target.picture.configuration) ||
      target.picture.configuration < 0 ||
      target.picture.configuration > 255 ||
      target.picture.layer !== 0 ||
      target.picture.field !== "frame" ||
      target.picture.picture !== 0 ||
      typeof target.picture.stream !== "string" ||
      target.picture.stream.length > 64)
  )
    throw new AnalysisFailure("invalid-request", "Invalid picture identity");
}
/** Validate before renderer/cache use, including count, geometry and overlap.
 * 4px grid is an explicit MVP admission limit, not a guessed completion flag. */
export function validateResult(result: AnalysisResult): void {
  if (
    !result ||
    result.schema !== 1 ||
    !["h264", "hevc", "vvc"].includes(result.codec) ||
    result.recipe !== ANALYSIS_RECIPE ||
    result.analyzerVersion !== ANALYZER_VERSION ||
    typeof result.buildId !== "string" ||
    result.buildId.length > 128 ||
    !["exact", "partial"].includes(result.confidence) ||
    !Array.isArray(result.reasons) ||
    result.reasons.length > 32 ||
    result.reasons.some((r) => typeof r !== "string" || r.length > 256) ||
    (result.reasonCodes !== undefined &&
      (!Array.isArray(result.reasonCodes) ||
        result.reasonCodes.length > 32 ||
        result.reasonCodes.some(
          (code) => !ANALYSIS_REASON_CODES.includes(code),
        )))
  )
    throw new Error("Invalid analysis result");
  validateTarget({
    sourceVersion: result.picture?.sourceVersion,
    sourcePtsUs: result.sourcePtsUs,
    normalizedMediaUs: 0,
    picture: result.picture,
  });
  if (result.gop) {
    const g = result.gop;
    if (![g.startAu, g.endAu, g.configuration].every(Number.isSafeInteger) ||
        g.startAu < 0 || g.endAu <= g.startAu || g.endAu > 250000 ||
        g.configuration !== result.picture.configuration ||
        result.picture.au < g.startAu || result.picture.au >= g.endAu ||
        !['unknown', 'closed', 'dependent'].includes(g.anchor)) throw new Error('Invalid analysis GOP');
  }
  if (result.containerHeader) validateContainerHeader(result.codec, result.containerHeader);
  if (result.nalus) validateDiagram(result as import("./diagrams.ts").DiagramPicture);
  else if (result.references) throw new Error("References require NAL metadata");
  const { width: w, height: h, blocks } = result;
  if (
    ![w, h].every((n) => Number.isInteger(n) && n > 0) ||
    !Array.isArray(blocks)
  )
    throw new Error("Invalid analysis output geometry");
  if (w > 4096 || h > 2304 || blocks.length > BUDGET.blocks)
    throw new AnalysisFailure("resource-limit", "Analysis resource limit");
  if (result.confidence !== "exact") return;
  if (
    !blocks.length ||
    w % 4 ||
    h % 4 ||
    result.reasons.length ||
    !result.capabilities ||
    result.capabilities.blocks !== "ready"
  )
    throw new AnalysisFailure(
      "unsupported-picture-layout",
      "Incomplete picture",
    );
  const cells = new Uint8Array((w * h) / 16);
  let area = 0;
  for (const b of blocks) {
    if (
      ![b.x, b.y, b.width, b.height].every(
        (n) => Number.isInteger(n) && n % 4 === 0,
      ) ||
      b.x < 0 ||
      b.y < 0 ||
      b.width <= 0 ||
      b.height <= 0 ||
      b.x + b.width > w ||
      b.y + b.height > h ||
      !["intra", "inter", "skip"].includes(b.mode) ||
      (b.qp !== null &&
        (!Number.isInteger(b.qp) ||
          b.qp < 0 ||
          b.qp > (result.codec === "vvc" ? 63 : 51)))
    )
      throw new Error(`Invalid analysis block ${JSON.stringify(b)}`);
    area += b.width * b.height;
    for (let y = b.y / 4; y < (b.y + b.height) / 4; y++)
      for (let x = b.x / 4; x < (b.x + b.width) / 4; x++) {
        const i = y * (w / 4) + x;
        if (cells[i])
          throw new AnalysisFailure(
            "unsupported-picture-layout",
            "Overlapping analysis blocks",
          );
        cells[i] = 1;
      }
  }
  if (area !== w * h)
    throw new AnalysisFailure(
      "unsupported-picture-layout",
      "Incomplete block coverage",
    );
}

function validateIndexIdentity(identity?: import('../media-index-identity.ts').MediaIndexIdentity) {
  if (identity) {
    const id = identity;
    try { parseMediaIndexIdentity(id.kind, new URLSearchParams({stream: id.streamKey,
      schema: String(id.schemaVersion), indexer: id.indexerBuild})); }
    catch { throw new AnalysisFailure('invalid-request', 'Invalid analysis index identity'); }
  }
}
