import { pairBudget } from "./frame-pair.ts";
import { PSNR_LIMITS } from "./psnr.ts";
import type { QualityJobInput } from "./jobs.ts";

/** Canonical v1 request projection shared by durable acceptance and receipt validation.
 * This never rewrites a frozen wire request; callers validate its shape separately. */
export function normalizeQualityJobInput(
  input: QualityJobInput,
): QualityJobInput {
  const request = input.request,
    roi = request.roi;
  const target = (t: typeof request.reference) => ({
    mediaId: t.mediaId,
    mediaVersion: t.mediaVersion,
    size: t.size,
    indexIdentity: {
      kind: t.indexIdentity.kind,
      streamKey: t.indexIdentity.streamKey,
      schemaVersion: t.indexIdentity.schemaVersion,
      indexerBuild: t.indexIdentity.indexerBuild,
    },
    indexBuildId: t.indexBuildId,
    picture: {
      sourceVersion: t.picture.sourceVersion,
      stream: t.picture.stream,
      configuration: t.picture.configuration,
      au: t.picture.au,
      picture: t.picture.picture,
      layer: t.picture.layer,
      field: t.picture.field,
    },
    sourcePtsUs: t.sourcePtsUs,
    ...(t.decode
      ? {
          decode:
            t.decode.mode === "packet-identity-gop-v1"
              ? {
                  mode: t.decode.mode,
                  startAu: t.decode.startAu,
                  endAu: t.decode.endAu,
                }
              : { mode: t.decode.mode, startAu: t.decode.startAu },
        }
      : {}),
  });
  return {
    schema: input.schema,
    version: 1,
    client: { id: input.client.id, kind: input.client.kind },
    request: {
      pairing: "caller-specified",
      reference: target(request.reference),
      distorted: target(request.distorted),
      roi: { x: roi.x, y: roi.y, width: roi.width, height: roi.height },
      ...(request.spatial === undefined
        ? {}
        : {
            spatial: {
              blockWidth: request.spatial.blockWidth,
              blockHeight: request.spatial.blockHeight,
            },
          }),
      ...(request.ssim === undefined
        ? {}
        : { ssim: { variant: request.ssim.variant } }),
      budget: {
        ...pairBudget(request),
        maxSamples: request.budget?.maxSamples ?? PSNR_LIMITS.maxSamples,
        maxInputBytes:
          request.budget?.maxInputBytes ?? PSNR_LIMITS.maxInputBytes,
      },
    },
  };
}
