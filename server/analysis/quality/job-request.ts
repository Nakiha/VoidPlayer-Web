import { createHash } from 'node:crypto';
import { AdminError } from '../../admin-error.ts';
import { pairBudget } from '../../../shared/analysis/quality/frame-pair.ts';
import { PSNR_LIMITS } from '../../../shared/analysis/quality/psnr.ts';
import { QUALITY_JOB_LIMITS } from '../../../shared/analysis/quality/jobs.ts';
import type { QualityJobInput } from '../../../shared/analysis/quality/jobs.ts';
import { libraryPairRequest, qualityKeys } from './request.ts';

/** Stable v1 defaults and field order are independent of a later deployment's
 * decoder. A replay returns the old job, never a newly selected implementation. */
export function qualityJobRequest(value: unknown) {
  qualityKeys(value, ['schema', 'version', 'client', 'request']);
  const input = value as QualityJobInput;
  qualityKeys(input.client, ['id', 'kind']);
  if (input.schema !== 'voidplayer-psnr-frame-job' || input.version !== 1
    || typeof input.client.id !== 'string' || !/^[A-Za-z0-9._:-]{1,80}$/.test(input.client.id)
    || !['agent', 'browser', 'other'].includes(input.client.kind))
    throw new AdminError(400, 'Invalid PSNR job or client identity.', 'invalid-request');
  const request = libraryPairRequest(input.request), roi = request.roi;
  if ([roi.x, roi.y, roi.width, roi.height].some(n => !Number.isSafeInteger(n) || n < 0 || n % 2 !== 0)
    || roi.width < 2 || roi.height < 2 || roi.x + roi.width > 16384 || roi.y + roi.height > 16384)
    throw new AdminError(400, 'Invalid chroma-aligned job ROI.', 'invalid-request');
  for (const key of ['maxSamples', 'maxInputBytes'] as const) {
    const n = request.budget?.[key];
    if (n !== undefined && (!Number.isSafeInteger(n) || n < 1 || n > PSNR_LIMITS[key]))
      throw new AdminError(400, 'Invalid PSNR job budget.', 'invalid-request');
  }
  const target = (t: typeof request.reference) => ({
    mediaId: t.mediaId, mediaVersion: t.mediaVersion, size: t.size,
    indexIdentity: {kind: t.indexIdentity.kind, streamKey: t.indexIdentity.streamKey,
      schemaVersion: t.indexIdentity.schemaVersion, indexerBuild: t.indexIdentity.indexerBuild},
    indexBuildId: t.indexBuildId, picture: {sourceVersion: t.picture.sourceVersion, stream: t.picture.stream,
      configuration: t.picture.configuration, au: t.picture.au, picture: t.picture.picture,
      layer: t.picture.layer, field: t.picture.field}, sourcePtsUs: t.sourcePtsUs,
    ...(t.decode?{decode:{mode:t.decode.mode,startAu:t.decode.startAu}}:{}),
  });
  const normalized: QualityJobInput = {schema: input.schema, version: 1,
    client: {id: input.client.id, kind: input.client.kind}, request: {
      pairing: 'caller-specified', reference: target(request.reference), distorted: target(request.distorted),
      roi: {x: roi.x, y: roi.y, width: roi.width, height: roi.height},
      ...(request.spatial === undefined ? {} : {spatial:{blockWidth:request.spatial.blockWidth,blockHeight:request.spatial.blockHeight}}),
      ...(request.ssim === undefined ? {} : {ssim:{variant:request.ssim.variant}}),
      budget: {...pairBudget(request), maxSamples: request.budget?.maxSamples ?? PSNR_LIMITS.maxSamples,
        maxInputBytes: request.budget?.maxInputBytes ?? PSNR_LIMITS.maxInputBytes},
    }};
  const json = JSON.stringify(normalized);
  if (Buffer.byteLength(json) > QUALITY_JOB_LIMITS.requestBytes)
    throw new AdminError(413, 'PSNR job request budget exceeded.', 'budget-exceeded');
  return {input: normalized, json, fingerprint: createHash('sha256').update(json).digest('hex')};
}
export function qualityIdempotencyKey(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(value))
    throw new AdminError(400, 'Provide a bounded Idempotency-Key.', 'idempotency-key-required');
  return value;
}
