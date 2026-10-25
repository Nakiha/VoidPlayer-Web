import { TECHNICAL_FILTER_PATH, TECHNICAL_FILTER_LIMITS, TECHNICAL_FILTER_SCHEMA } from '../media/indexing/technical-filter.ts';
import { QUALITY_JOB_LIMITS } from '../analysis/quality/jobs.ts';
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
    qualityJobs: { schema: 'voidplayer-psnr-frame-job', version: 1, metrics: ['psnr'], scope: 'single-explicit-frame-pair',
      submit: '/api/quality/jobs', changes: '/api/quality/jobs', job: '/api/quality/jobs/{jobId}',
      result: '/api/quality/jobs/{jobId}/result', cancel: '/api/quality/jobs/{jobId}/cancel',
      writeAction: 'quality-job', idempotencyHeader: 'Idempotency-Key', observerDisconnectCancels: false,
      automaticRetry: false, sharedWork: false, buildsIndexes: false, limits: QUALITY_JOB_LIMITS,
      frameCandidates:{endpoint:'/api/media/{id}/psnr-frames?v={version}&afterAu=0&limit=50',pagination:'absolute-au-with-original-buildId',eligibility:'container-key-candidate-execution-verifies-closed-au-and-pixels',buildsIndexes:false},
      source: { registeredLibraryOnly: true, indexKind: 'flv', enhancedFlv: true, producer: 'server-flv-scan-v1',
        codecs: ['h264', 'hevc'], bitDepths: [8, 10], chroma: 'yuv420', closedKeyAuOnly: true,
        explicitColorAndChromaLocation: true, explicitPairingAndSourcePts: true },
      resultSchema: 'voidplayer-quality-job-result', resultVersion: 1 },
    writes: { identity: '/api/identity', identityIsAuthentication: false, originRequired: true,
      actionHeader: 'X-VoidPlayer-Action', cookieRequired: true, completion: 'server-commit', guiAcknowledgementRequired: false },
    annotations: { version: 1, spaces: '/api/annotations/spaces',
      events: '/api/annotations/events/{space}?after={cursor}',
      qualityEvidence: {action:'attach-quality-result',metric:'psnr',result:'completed-owned-job',target:'existing-primary-source-version-and-source-pts',roi:'original-visible-pixel-grid',immutable:true,maxCount:4,maxBytes:131072,importVerification:'historical',workspaceVersion:2},
      identity: ['space', 'id'], concurrency: 'expected-revision', idempotency: 'operationId',
      frameTimeUnit: 'integer-microseconds', target: 'document.media + mark.mediaId + mark.frame',
      slotMeaning: 'legacy-display-hint; no loaded track required' },
  };
}
