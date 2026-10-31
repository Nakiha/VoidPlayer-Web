import { randomUUID } from 'node:crypto';
import { canonicalJson } from '../../../shared/analysis/quality/correspondence.ts';
import type { QualityEvidenceRef } from '../../../shared/review/quality-evidence.ts';
import type { AnnotationStore } from '../../annotations.ts';
import type { Actor } from '../../identity.ts';
import type { openIndexDatabase } from '../../sqlite.ts';
import { AdminError } from '../../admin-error.ts';
import { settleScoringReservations } from './result-retention.ts';

type Database = ReturnType<typeof openIndexDatabase>;
type Kind = 'vmaf' | 'xpsnr';
export type CandidatePolicy = {
  space: string; side: 'reference' | 'distorted'; maxScore: number; limit: number;
  minFrameDistance: number; text: string; severity: number;
};
export type CandidatePublication = {
  policy: CandidatePolicy;
  selected: { index: number; id: string; operationId: string; ref: QualityEvidenceRef }[];
  createdIds: string[];
};
export function candidatePublication(db: Database, kind: Kind, id: string): CandidatePublication | null {
  const row = db.prepare(`SELECT body FROM quality_${kind}_publications WHERE job_id=?`).get(id);
  return row ? JSON.parse(String(row.body)) as CandidatePublication : null;
}
/** Borrows the temporal owner's database. Freeze before annotation submission;
 * each database commits independently. Replay never invokes selection/result reads. */
export function publishCandidates(
  db: Database, kind: Kind, job: { id: string; input: { client: { kind: 'browser' | 'agent' | 'other' } } },
  actor: Actor, policy: CandidatePolicy, origin: string, annotations: AnnotationStore, requestId: string,
  select: () => { index: number; ref: QualityEvidenceRef }[],
  resolve: NonNullable<Parameters<AnnotationStore['mutate']>[4]>['resolve'],
) {
  let publication = candidatePublication(db, kind, job.id);
  if (publication && canonicalJson(publication.policy) !== canonicalJson(policy))
    throw new AdminError(409, 'Candidate policy is already frozen.', 'candidate-policy-conflict');
  if (!publication) {
    publication = {
      policy, selected: select().map(item => ({ ...item, id: randomUUID(), operationId: randomUUID() })), createdIds: [],
    };
    db.prepare(`INSERT INTO quality_${kind}_publications VALUES(?,?)`).run(job.id, JSON.stringify(publication));
    settleScoringReservations(db, kind, job.id);
  }
  for (const item of publication.selected) {
    annotations.mutate(policy.space, {
      action: 'create-quality-candidate', operationId: item.operationId, id: item.id, revision: 0,
      client: { kind: job.input.client.kind === 'browser' ? 'gui' : job.input.client.kind === 'agent' ? 'agent' : 'http',
        id: kind + '_' + job.id },
      evidence: item.ref, candidate: { text: policy.text, severity: policy.severity },
    }, actor, requestId, { origin, resolve });
    if (!publication.createdIds.includes(item.id)) {
      publication.createdIds.push(item.id);
      db.prepare(`UPDATE quality_${kind}_publications SET body=? WHERE job_id=?`).run(JSON.stringify(publication), job.id);
      settleScoringReservations(db, kind, job.id);
    }
  }
  return publication;
}
