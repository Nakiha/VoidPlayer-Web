import type { QualityResultCommands } from './analysis/quality/result-commands.ts';
import type {QualityJobService} from './analysis/quality/job-service.ts';
import type {QualityRangeService} from './analysis/quality/range-service.ts';
import type {CorrespondenceService} from './analysis/quality/correspondence-service.ts';
import type {LibraryPairRunner} from './analysis/quality/runner.ts';
import type {QualityReexecutionService} from './analysis/quality/reexecution-service.ts';
import type {NativeVmafService} from './analysis/vmaf/service.ts';
import type {NativeXpsnrService} from './analysis/xpsnr/service.ts';
import type {NativeCambiService} from './analysis/cambi/service.ts';
import type {DiscoveryStore} from './discovery/store.ts';
import type {TaskKind} from '../shared/service/tasks.ts';

/** Explicit command dependencies; no media lookup, construction or lifetime access. */
export type ReexecutionServices={
 readonly quality:Pick<LibraryPairRunner,'reexecutionPreflight'>;
 readonly qualityJobs:Pick<QualityJobService,'get'|'resources'|'reexecutionInput'|'reexecutionReceipt'|'reexecute'>;
 readonly qualityRanges:Pick<QualityRangeService,'get'|'reexecutionInput'|'executionContract'|'coverage'|'reexecutionReceipt'|'reexecute'>;
 readonly qualityCorrespondence:Pick<CorrespondenceService,'executionContext'>;
 readonly qualityVmaf:Pick<NativeVmafService,'get'|'frozenSnapshot'|'reexecutionReceipt'|'reexecute'|'reexecutionPreflight'>;
 readonly qualityXpsnr:Pick<NativeXpsnrService,'get'|'frozenSnapshot'|'reexecutionReceipt'|'reexecute'|'reexecutionPreflight'>;
 readonly qualityCambi:Pick<NativeCambiService,'get'|'reexecutionReceipt'|'reexecute'|'reexecutionPreflight'>;
};
/** Read projections cannot submit, cancel, start recovery or close a service. */
export type TaskReadServices={
 readonly durableQualityJobsEnabled:boolean;
 readonly discovery:{readonly store:Pick<DiscoveryStore,'taskSummaries'>};
 readonly qualityJobs:Pick<QualityJobService,'taskSummaries'|'taskRetainedResults'>;
 readonly qualityRanges:Pick<QualityRangeService,'taskSummaries'|'taskChildEdges'|'taskEdges'|'taskChild'>;
 readonly qualityCorrespondence:Pick<CorrespondenceService,'taskSummaries'|'taskEdges'|'taskRange'|'get'|'relation'>;
 readonly qualityVmaf:Pick<NativeVmafService,'taskSummaries'|'taskEdges'|'get'>;
 readonly qualityXpsnr:Pick<NativeXpsnrService,'taskSummaries'|'taskEdges'|'get'>;
 readonly qualityCambi:Pick<NativeCambiService,'taskSummaries'>;
 readonly qualityReexecutions:Pick<QualityReexecutionService,'chain'>;
};
export type TaskCommands=Readonly<Record<TaskKind,(id:string,actor:string,requestId:string)=>unknown>>;

/** Result reclamation borrows commands and retention queries, never storage/lifetime access. */
export type ResultReleaseServices = {
 readonly qualityJobs: Pick<QualityJobService, 'get' | 'releaseResult'>;
 readonly qualityRanges: Pick<QualityRangeService, 'referencesResult' | 'releaseResult'>;
 readonly qualityVmaf: Pick<NativeVmafService, 'get' | 'releaseResult'>;
 readonly qualityXpsnr: Pick<NativeXpsnrService, 'get' | 'releaseResult'>;
 readonly qualityCambi: Pick<NativeCambiService, 'get' | 'releaseResult'>;
};
export type ResultEvidence = { referencesQualityResult(id: string): boolean };
export type ResultCommands = Pick<QualityResultCommands, 'release'>;
