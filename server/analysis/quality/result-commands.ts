import { AdminError } from '../../admin-error.ts';
import type { ResultReleaseServices, ResultEvidence } from '../../quality-service-ports.ts';
import { TASK_RESULT_KINDS } from '../../../shared/service/tasks.ts';
import type { TaskKind } from '../../../shared/service/tasks.ts';

/** Application command owner for cross-store retention policy. No owned resources;
 * ranges retain their existing durable intent and independent child transactions. */
export class QualityResultCommands {
  private services: ResultReleaseServices;
  constructor(services: ResultReleaseServices) { this.services = services; }
  release(kind: TaskKind, id: string, actor: string, evidence?: ResultEvidence) {
    if (!TASK_RESULT_KINDS.includes(kind))
      throw new AdminError(400, 'This task has no releasable scoring payload.', 'unsupported-result-release');
    if (!evidence)
      throw new AdminError(503, 'Evidence storage must be available before releasing results.', 'storage-unavailable');
    const s = this.services;
    if (kind === 'range') return s.qualityRanges.releaseResult(id, actor, child => evidence.referencesQualityResult(child));
    const service = kind === 'single' ? s.qualityJobs : kind === 'vmaf' ? s.qualityVmaf : kind === 'cambi' ? s.qualityCambi : s.qualityXpsnr;
    service.get(id, actor);
    if (kind === 'single' && s.qualityRanges.referencesResult(id))
      throw new AdminError(409, 'A range still references this result; it is retained.', 'result-pinned-by-range');
    if (evidence.referencesQualityResult(id))
      throw new AdminError(409, 'Shared or historical evidence still references this result; it is retained.', 'result-pinned-by-evidence');
    return service.releaseResult(id, actor);
  }
}
