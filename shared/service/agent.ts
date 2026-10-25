import { SSIM_VARIANT, SSIM_LIMITS } from '../analysis/quality/ssim.ts';
import { TECHNICAL_FILTER_PATH, TECHNICAL_FILTER_LIMITS, TECHNICAL_FILTER_SCHEMA } from '../media/indexing/technical-filter.ts';
import { QUALITY_JOB_LIMITS } from '../analysis/quality/jobs.ts';
import { PSNR_SPATIAL_LIMITS } from '../analysis/quality/psnr.ts';
import { FORWARD_OUTPUT_GUARANTEE } from '../analysis/quality/frame-pair.ts';
/** Discovery describes this deployment without starting work or creating users. */
export function serviceCapabilities(storageEnabled: boolean, revealEnabled: boolean) {
  return { admin: storageEnabled, workspaces: storageEnabled, annotations: storageEnabled, reveal: revealEnabled };
}
type ServiceCapabilities = ReturnType<typeof serviceCapabilities>;
export type AgentCapability = {
  id: string;
  implemented: boolean;
  enabled: boolean;
  readiness: 'ready' | 'index-warming' | 'needs-identity' | 'per-source' | 'requires-live-session' | 'unavailable';
  requiresBrowser: boolean;
  guide: string;
};
export const AGENT_TASKS = {
  library: '/agent/library.md', workspaces: '/agent/workspaces.md', annotations: '/agent/annotations.md',
  quality: '/agent/quality.md', liveSession: '/agent/live-session.md', errors: '/agent/errors.md',
} as const;

export function agentManifest(input: { capabilities: ServiceCapabilities; libraryReady: boolean; frontendAvailable?: boolean; qualityJobsEnabled?: boolean; actor: { id: string; name: string } | null }) {
  const { capabilities: c, libraryReady, actor } = input;
  const capabilities: AgentCapability[] = [
    { id: 'library.browse', implemented: true, enabled: true, readiness: libraryReady ? 'ready' : 'index-warming', requiresBrowser: false, guide: AGENT_TASKS.library },
    { id: 'media.cached-info', implemented: true, enabled: true, readiness: 'per-source', requiresBrowser: false, guide: AGENT_TASKS.library },
    { id: 'media.cached-index-query', implemented: true, enabled: true, readiness: 'per-source', requiresBrowser: false, guide: AGENT_TASKS.library },
    { id: 'media.technical-filter', implemented: true, enabled: true, readiness: 'per-source', requiresBrowser: false, guide: AGENT_TASKS.library },
    { id: 'media.read', implemented: true, enabled: true, readiness: 'per-source', requiresBrowser: false, guide: AGENT_TASKS.library },
    { id: 'workspaces.read', implemented: true, enabled: c.workspaces, readiness: c.workspaces ? 'ready' : 'unavailable', requiresBrowser: false, guide: AGENT_TASKS.workspaces },
    { id: 'annotations.write', implemented: true, enabled: c.annotations, readiness: !c.annotations ? 'unavailable' : actor ? 'ready' : 'needs-identity', requiresBrowser: false, guide: AGENT_TASKS.annotations },
    { id: 'annotations.events', implemented: true, enabled: c.annotations, readiness: c.annotations ? 'ready' : 'unavailable', requiresBrowser: false, guide: AGENT_TASKS.annotations },
    { id: 'quality.jobs', implemented: true, enabled: !!input.qualityJobsEnabled, readiness: !input.qualityJobsEnabled ? 'unavailable' : actor ? 'per-source' : 'needs-identity', requiresBrowser: false, guide: AGENT_TASKS.quality },
    { id: 'quality.frame-pair', implemented: true, enabled: true, readiness: actor ? 'per-source' : 'needs-identity', requiresBrowser: false, guide: AGENT_TASKS.quality },
    { id: 'session.view', implemented: true, enabled: !!input.frontendAvailable, readiness: input.frontendAvailable ? 'requires-live-session' : 'unavailable', requiresBrowser: true, guide: AGENT_TASKS.liveSession },
    { id: 'bridge.local-mcp', implemented: false, enabled: false, readiness: 'unavailable', requiresBrowser: true, guide: AGENT_TASKS.liveSession },
    { id: 'compute.workers', implemented: false, enabled: false, readiness: 'unavailable', requiresBrowser: false, guide: AGENT_TASKS.quality },
  ];
  return {
    schema: 'voidplayer-agent', version: 1, service: 'voidplayer-media', actor,
    links: { guide: '/agent.md', index: '/llms.txt', health: '/api/health', tasks: AGENT_TASKS },
    capabilities,
    technicalFilter: { schema: TECHNICAL_FILTER_SCHEMA, version: 1, endpoint: TECHNICAL_FILTER_PATH, limits: TECHNICAL_FILTER_LIMITS, pagination: 'none', scope: 'explicit-candidates-cached-streams' },
    qualityJobs: { schema: 'voidplayer-psnr-frame-job', version: 1, metrics: ['psnr','ssim'], requiredMetrics:['psnr'],
      ssim:{optional:true,requestField:'ssim',variant:SSIM_VARIANT,standalone:false,resultField:'result.ssim',limits:SSIM_LIMITS,
        window:{size:8,step:4,weight:'uniform',border:'valid-truncate-to-4'},planes:'yuv420-native-code-values',weighting:'y4-u1-v1-plane-mean'}, scope: 'single-explicit-frame-pair',
      submit: '/api/quality/jobs', changes: '/api/quality/jobs', job: '/api/quality/jobs/{jobId}',
      result: '/api/quality/jobs/{jobId}/result', cancel: '/api/quality/jobs/{jobId}/cancel',
      writeAction: 'quality-job', idempotencyHeader: 'Idempotency-Key', observerDisconnectCancels: false,
      automaticRetry: false, sharedWork: false, buildsIndexes: false, limits: QUALITY_JOB_LIMITS,
      spatial: {optional:true,requestField:'spatial',parameters:['blockWidth','blockHeight'],units:'even-visible-source-pixels',
        partition:'roi-anchored-disjoint-even-grid',ranking:'aggregate-mse-desc-row-major-ties',resultSchema:'voidplayer-psnr-block-grid',resultVersion:1,limits:PSNR_SPATIAL_LIMITS},
      frameCandidates:{endpoint:'/api/media/{id}/psnr-frames?v={version}&afterAu=0&limit=50',pagination:'absolute-au-with-original-buildId',eligibility:'cached-au-candidate-execution-verifies-closed-start-and-output-identity',buildsIndexes:false},
      source: { registeredLibraryOnly: true, indexKind: 'flv', enhancedFlv: true, producer: 'server-flv-scan-v1',
        codecs: ['h264', 'hevc'], bitDepths: [8, 10], chroma: 'yuv420', closedKeyAuOnly: false, gop:{mode:'packet-identity-gop-v1',packetIdentityAbi:1,explicitStartEndAu:true,packetsPerSide:32,maxPackets:64,maxOutputFrames:64,reordering:true,delayedOutput:true,outputAssociation:'opaque-input-token-not-pts',singleThread:true,reportedDecodeErrors:'reject',guarantee:{...FORWARD_OUTPUT_GUARANTEE}}, forward:{mode:'forward-one-output-per-au-v1',explicitStartAu:true,packetsPerSide:32,maxPackets:64,maxOutputFrames:64,zeroCts:true,oneImmediateOutputPerAu:true,reordering:false,guarantee:{...FORWARD_OUTPUT_GUARANTEE}},
        explicitColorAndChromaLocation: true, explicitPairingAndSourcePts: true },
      resultSchema: 'voidplayer-quality-job-result', resultVersion: 1 },
    writes: { identity: '/api/identity', identityIsAuthentication: false, originRequired: true,
      actionHeader: 'X-VoidPlayer-Action', cookieRequired: true, completion: 'server-commit', guiAcknowledgementRequired: false },
    annotations: { version: 1, spaces: '/api/annotations/spaces',
      events: '/api/annotations/events/{space}?after={cursor}',
      qualityEvidence: {action:'attach-quality-result',metric:'psnr',optionalCompanion:'ssim',result:'completed-owned-job',target:'existing-primary-source-version-and-source-pts',roi:'original-visible-pixel-grid',immutable:true,maxCount:4,maxBytes:131072,importVerification:'historical',workspaceVersion:2},
      identity: ['space', 'id'], concurrency: 'expected-revision', idempotency: 'operationId',
      frameTimeUnit: 'integer-microseconds', target: 'document.media + mark.mediaId + mark.frame',
      slotMeaning: 'legacy-display-hint; no loaded track required' },
  };
}
