import { AnnotationClient } from './annotation-client.ts';
import { parseAnnotationOperation } from '../../shared/review/annotation-command.ts';
import type { AnnotationClientIdentity } from '../../shared/review/annotation-record.ts';
import type { QualityEvidenceRef } from '../../shared/review/quality-evidence.ts';

export type QualityAttachmentCommand = {space:string;id:string;revision:number;operationId:string;evidence:QualityEvidenceRef};
/** Same persistent domain command for GUI and Agent. No session or playback dependency. */
export function attachAnnotationQuality(input: QualityAttachmentCommand, client: AnnotationClientIdentity, actor?: string) {
  if (!/^[a-zA-Z0-9_-]{1,200}$/.test(input.space)) throw new Error('Invalid annotation space.');
  const operation = parseAnnotationOperation({operationId:input.operationId,id:input.id,revision:input.revision,
    action:'attach-quality-result',evidence:input.evidence,client});
  return new AnnotationClient(AbortSignal.timeout(10000)).mutate(input.space,operation,actor);
}
