import { parseMediaIndexIdentity } from "../../media/indexing/media-index-identity.ts";
import { validateDiagram, validateContainerHeader } from "./diagrams.ts";
import type { FrameDescription } from "../../media/frame-description.ts";
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
  product?: "summary" | "blocks";
  mode: 'stream';
  indexIdentity?: import('../../media/indexing/media-index-identity.ts').MediaIndexIdentity;
  sourceVersion: string;
  firstPtsUs: number;
  durationUs: number;
  window?: { startUs: number; endUs: number; axis: 'pts' | 'dts' };
}
export function validateStream(target: AnalysisStreamTarget) {
  if (!target || target.mode !== 'stream') throw new AnalysisFailure('invalid-request', 'Invalid stream request');
  validateTarget({ sourceVersion: target.sourceVersion, sourcePtsUs: target.firstPtsUs, normalizedMediaUs: 0 });
  validateIndexIdentity(target.indexIdentity);
  validateProductRequest(target.product);
  if (!Number.isSafeInteger(target.durationUs) || target.durationUs <= 0)
    throw new AnalysisFailure('invalid-request', 'Invalid stream duration');
  if (target.window && (![target.window.startUs, target.window.endUs, target.window.endUs - target.window.startUs].every(Number.isSafeInteger) || target.window.endUs <= target.window.startUs || !['pts', 'dts'].includes(target.window.axis)))
    throw new AnalysisFailure('invalid-request', 'Invalid analysis viewport');
}
export interface AnalysisSourceLayout {
  provenance:'configuration-sps-v1';configuration:number;codedWidth:number;codedHeight:number;visibleRect:{x:number;y:number;width:number;height:number};
}
export interface AnalysisResult {
  /** Parsed from this configuration SPS, independent of browser plane allocation. */
  sourceLayout?:AnalysisSourceLayout;
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
  product?: "summary" | "blocks";
  indexIdentity?: import('../../media/indexing/media-index-identity.ts').MediaIndexIdentity;
  sourceVersion: string;
  sourcePtsUs: number;
  normalizedMediaUs: number;
  picture?: SourcePictureKey;
}
export interface AnalysisRangeTarget {
  product?: "summary" | "blocks";
  indexIdentity?: import('../../media/indexing/media-index-identity.ts').MediaIndexIdentity;
  sourceVersion: string;
  firstPtsUs: number;
  startUs: number;
  endUs: number;
}
export function validateRange(target: AnalysisRangeTarget) {
  validateIndexIdentity(target?.indexIdentity);
  validateProductRequest(target?.product);
  if(target?.product !== undefined)throw new AnalysisFailure("invalid-request","Explicit analysis products require a stream or exact-picture request");
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
export function validateProductRequest(product: unknown) {
  if (product !== undefined && product !== "summary" && product !== "blocks") throw new AnalysisFailure("invalid-request", "Unknown analysis product");
}
export function validateTarget(target: AnalysisTarget): void {
  validateProductRequest(target?.product);
  if(target?.product === "summary")throw new AnalysisFailure("invalid-request","Summary requires an explicit stream request");
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
export function validateMetadata(result: Omit<AnalysisResult, "blocks">): void {
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
  if(result.sourceLayout) {
    const l=result.sourceLayout,v=l.visibleRect;
    if(l.provenance!=='configuration-sps-v1'||!['h264','hevc'].includes(result.codec)||l.configuration!==result.picture.configuration||l.codedWidth!==result.width||l.codedHeight!==result.height||!v||![v.x,v.y,v.width,v.height].every(Number.isSafeInteger)||v.x<0||v.y<0||v.width<=0||v.height<=0||v.x+v.width>l.codedWidth||v.y+v.height>l.codedHeight)throw Error('Invalid analysis SPS layout');
  }
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
  if (![result.width, result.height].every(n => Number.isInteger(n) && n > 0)) throw new Error("Invalid analysis output geometry");
  if (result.width > 4096 || result.height > 2304)
    throw new AnalysisFailure("resource-limit", "Invalid analysis geometry");
  if (!result.capabilities || !['ready', 'unsupported'].includes(result.capabilities.blocks) ||
      !['ready', 'unsupported'].includes(result.capabilities.qp) || !['ready', 'unsupported'].includes(result.capabilities.modes) ||
      result.capabilities.motion !== 'unsupported' || !result.qp || result.qp.component !== 'luma' || result.qp.weighting !== 'pixel-area' ||
      !Number.isInteger(result.qp.bitDepth) || (result.qp.bitDepth < 8 && !(result.confidence === "partial" && result.qp.bitDepth === 0 && result.qp.mean === null)) || result.qp.bitDepth > 16 ||
      (result.qp.mean !== null && (!Number.isFinite(result.qp.mean) || result.qp.mean < 0 || result.qp.mean > (result.codec === 'vvc' ? 63 : 51))) ||
      (result.capabilities.qp !== 'ready' && result.qp.mean !== null)) throw new Error('Invalid analysis capabilities/QP');
  if (!result.metrics || Object.values(result.metrics).some(n => !Number.isFinite(n) || n < 0)) throw new Error('Invalid analysis metrics');
}
export function validateResult(result: AnalysisResult): void {
  validateMetadata(result);
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
  let area = 0, weightedQp=0;
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
    if(result.capabilities.qp==='ready' && b.qp===null)throw Error("Unknown block QP cannot be ready");
    weightedQp+=(b.qp ?? 0)*b.width*b.height;
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
  if(result.capabilities.qp==='ready' && result.qp.mean!==weightedQp/area)throw Error("Mean QP does not match block evidence");
}

function validateIndexIdentity(identity?: import('../../media/indexing/media-index-identity.ts').MediaIndexIdentity) {
  if (identity) {
    const id = identity;
    try { parseMediaIndexIdentity(id.kind, new URLSearchParams({stream: id.streamKey,
      schema: String(id.schemaVersion), indexer: id.indexerBuild})); }
    catch { throw new AnalysisFailure('invalid-request', 'Invalid analysis index identity'); }
  }
}

/** Match coordinates using exact SPS crop evidence, never size rounding. */
export function matchesAnalysisLayout(result:Pick<AnalysisResult,'width'|'height'|'sourceLayout'|'picture'>,token:PresentedFrameToken) {
  const g=token.geometry;if(!g)return false;
  if(result.width===g.codedWidth&&result.height===g.codedHeight)return true;
  const l=result.sourceLayout,v=g.visibleRect;
  return !!l&&l.provenance==='configuration-sps-v1'&&l.configuration===result.picture.configuration&&l.codedWidth===result.width&&l.codedHeight===result.height&&v.x===l.visibleRect.x&&v.y===l.visibleRect.y&&v.width===l.visibleRect.width&&v.height===l.visibleRect.height&&Number.isSafeInteger(g.codedWidth)&&Number.isSafeInteger(g.codedHeight)&&g.codedWidth>=v.x+v.width&&g.codedHeight>=v.y+v.height;
}
