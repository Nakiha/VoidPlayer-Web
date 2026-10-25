import { validateSsim } from '../analysis/quality/ssim-evidence.ts';
import type { LibraryPairResult } from '../analysis/quality/library-pair.ts';
import { pairBudget } from '../analysis/quality/frame-pair.ts';
import { validatePsnrSpatial } from '../analysis/quality/psnr-spatial.ts';
import { validateDescription } from '../media/frame-description.ts';
import { referenceVersion } from '../media/io/media-reference.ts';
import { mediaIndexIdentityKey } from '../media/indexing/media-index-identity.ts';
import type { AnnotationDocument } from './annotation-record.ts';
import type { Mark } from './model.ts';

export const QUALITY_EVIDENCE_LIMITS = Object.freeze({ count: 4, bytes: 128 * 1024 });
export type QualityEvidenceRef = { jobId: string; attemptId: string; digest: string; side: 'reference' | 'distorted' };
/** Explicitly shared facts, without the job's private submission/client/idempotency data.
 * A file can retain facts but cannot confer verification by the receiving service. */
export type QualityEvidence = {
  schema: 'voidplayer-annotation-psnr'; version: 1; id: string;
  ref: QualityEvidenceRef; serviceOrigin: string; completedAt: number;
  attachedAt: string; attachedBy: { id: string; name: string };
  verification: 'server-verified' | 'historical'; value: LibraryPairResult;
};
const id = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,200}$/.test(v);
const string = (v: unknown, max = 200): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const unsigned = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
function check(value: unknown): asserts value { if (!value) throw new Error('PSNR evidence is invalid or unsupported.'); }
export function qualityEvidenceRef(value: unknown): QualityEvidenceRef {
  const r = value as QualityEvidenceRef;
  check(r && Object.keys(r).sort().join(',') === 'attemptId,digest,jobId,side' && id(r.jobId) && id(r.attemptId)
    && /^[a-f0-9]{64}$/.test(r.digest) && ['reference','distorted'].includes(r.side));
  return {jobId:r.jobId,attemptId:r.attemptId,digest:r.digest,side:r.side};
}
/** Structural validation is not authenticity verification. Historical facts are untrusted. */
export function qualityEvidenceValue(value: unknown): LibraryPairResult {
  const v = value as LibraryPairResult, r = v?.result, m = r?.metric;
  check(v?.schema === 'voidplayer-library-frame-pair-psnr' && v.version === 1
    && v.execution?.host === 'node-worker' && ['node','bun'].includes(v.execution.runtime)
    && string(v.execution.runtimeVersion) && v.execution.sourceIdentity === 'stat-version-v1'
    && r?.schema === 'voidplayer-frame-pair-psnr' && r.version === 1 && r.pairing === 'caller-specified'
    && r.correspondence === 'caller-specified-no-content-or-time-alignment'
    && r.decoder?.backend === 'ffmpeg-wasm' && /^[a-f0-9]{40}$/.test(r.decoder.buildId)
    && r.decoder.frameAbi === 2 && r.decoder.packetIdentity === 'isolated-closed-au-v1'
    && m?.schema === 'voidplayer-source-plane-psnr' && m.version === 1 && m.implementation === 'cpu-number-sse-v1'
    && m.domain === 'source-yuv-code-values' && m.geometry === 'unrotated-visible-pixel-grid'
    && m.pairing === 'caller-supplied-unverified' && [8,10].includes(m.bitDepth) && m.peak === 2 ** m.bitDepth - 1);
  pairBudget({pairing:'caller-specified', reference:r.provenance?.reference, distorted:r.provenance?.distorted, roi:m.roi});
  for (const side of ['reference','distorted'] as const) {
    const p = r.provenance[side], d = p.decoded?.description, source = v.sources?.[side];
    check(p.decoded?.sourcePtsUs === p.sourcePtsUs && p.validation === 'cached-au-source-tag-isolated-closed-picture-v1');
    check(unsigned(p.packet?.offset) && Number.isSafeInteger(p.packet.size) && p.packet.size > 0 && Number.isSafeInteger(p.packet.sourceDtsUs));
    validateDescription(d);
    check(d.format === 'YUV' && d.yuv?.bitDepth === m.bitDepth && d.width <= 16384 && d.height <= 16384);
    const roi = m.roi;
    check(roi && [roi.x,roi.y,roi.width,roi.height].every(n => Number.isSafeInteger(n) && n % 2 === 0)
      && roi.x >= 0 && roi.y >= 0 && roi.width > 0 && roi.height > 0 && roi.x + roi.width <= d.width && roi.y + roi.height <= d.height);
    check(source?.binding?.mediaId === p.mediaId && source.binding.mediaVersion === p.mediaVersion
      && source.binding.indexBuildId === p.indexBuildId && source.binding.size === p.size
      && mediaIndexIdentityKey(source.binding.indexIdentity) === mediaIndexIdentityKey(p.indexIdentity)
      && source.producer?.producer === 'server-flv-scan-v1' && source.producer.sourceVersion === `${p.mediaId}@${p.mediaVersion}`
      && source.producer.size === p.size && unsigned(source.producer.epoch) && string(source.producer.packetCommitId,128)
      && /^[a-f0-9]{64}$/.test(source.producer.documentSha256)
      && ['size','dev','ino','mtimeNs','ctimeNs'].every(k=>typeof source.producer.sourceStat?.[k as 'size']==='string'
        && /^-?\d{1,40}$/.test(source.producer.sourceStat[k as 'size'])));
  }
  check(m.color && ['primaries','transfer','matrix'].every(k => string(m.color[k as 'matrix']))
    && typeof m.color.fullRange === 'boolean' && Number.isInteger(m.color.chromaLocation) && m.color.chromaLocation >= 1 && m.color.chromaLocation <= 6);
  for (const stat of [m.aggregate,m.planes?.y,m.planes?.u,m.planes?.v]) {
    check(stat && Number.isSafeInteger(stat.sse) && stat.sse >= 0 && Number.isSafeInteger(stat.samples) && stat.samples > 0
      && Number.isFinite(stat.mse) && stat.mse >= 0 && stat.psnr
      && (stat.psnr.kind === 'finite' ? Number.isFinite(stat.psnr.db) : stat.psnr.kind === 'positive-infinity' && stat.psnr.db === null));
  }
  check(r.work?.packets === 2 && r.work.outputFrames === 2 && unsigned(r.work.readBytes) && Number.isFinite(r.work.elapsedMs) && r.work.elapsedMs >= 0
    && m.work && [m.work.samples,m.work.bytesRead,m.work.inputViewBytes,m.work.chargedInputBytes].every(unsigned));
  validatePsnrSpatial(m);
  if(r.ssim!==undefined)validateSsim(r.ssim,m);
  return structuredClone(v);
}
export function qualityEvidenceList(value: unknown, preserveVerification = false): QualityEvidence[] {
  check(Array.isArray(value) && value.length <= QUALITY_EVIDENCE_LIMITS.count);
  const json = JSON.stringify(value);
  check(new TextEncoder().encode(json).length <= QUALITY_EVIDENCE_LIMITS.bytes);
  const result = value.map((input: QualityEvidence) => {
    check(input?.schema === 'voidplayer-annotation-psnr' && input.version === 1 && id(input.id)
      && Number.isSafeInteger(input.completedAt) && input.completedAt >= 0 && string(input.attachedAt,100)
      && id(input.attachedBy?.id) && string(input.attachedBy.name) && ['server-verified','historical'].includes(input.verification));
    const origin = new URL(input.serviceOrigin);
    check(['http:','https:'].includes(origin.protocol) && origin.origin === input.serviceOrigin && !origin.username && !origin.password);
    return {schema:input.schema,version:input.version,id:input.id,ref:qualityEvidenceRef(input.ref),serviceOrigin:origin.origin,
      completedAt:input.completedAt,attachedAt:input.attachedAt,attachedBy:{id:input.attachedBy.id,name:input.attachedBy.name},
      verification:preserveVerification ? input.verification : 'historical' as const,value:qualityEvidenceValue(input.value)};
  });
  check(new Set(result.map(e => e.id)).size === result.length);
  return result;
}
export function historicalMarks(marks: Mark[]): Mark[] {
  return marks.map(mark => ({...structuredClone(mark),...(mark.qualityEvidence ? {qualityEvidence:qualityEvidenceList(mark.qualityEvidence)} : {})}));
}
export function evidenceWorkspaceVersion(marks: Mark[]): 1 | 2 { return marks.some(m => m.qualityEvidence !== undefined) ? 2 : 1; }
/** Exact existing anchor, original visible grid; neither normalized PTS nor drawings infer a pair. */
export function evidenceApplies(document: AnnotationDocument, evidence: QualityEvidence): boolean {
  const media = document.media.find(m => m.id === document.mark.mediaId), source = media?.source;
  const p = evidence.value.result.provenance[evidence.ref.side], d = p.decoded.description;
  if (!source || media!.size !== p.size || new URL(source.url).searchParams.getAll('v').length !== 1 || source.id !== p.mediaId || referenceVersion(source.url) !== p.mediaVersion
    || new URL(source.url).origin !== evidence.serviceOrigin || new URL(source.url).pathname !== `/api/media/${p.mediaId}`
    || document.mark.frame.sourcePtsUs !== p.sourcePtsUs) return false;
  const region = document.mark.region, roi = evidence.value.result.metric.roi;
  // null means no claimed annotation ROI. Explicit regions must equal the measured ROI.
  return !region || (region.left === roi.x/d.width && region.top === roi.y/d.height
    && region.width === roi.width/d.width && region.height === roi.height/d.height);
}
