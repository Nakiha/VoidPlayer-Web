import { annotationAnchor, parseAnnotationDocument } from './annotation-record.ts';
import type { AnnotationOperation, AnnotationRecord } from './annotation-record.ts';
import { evidenceApplies, qualityEvidenceList, qualityEvidenceRef } from './quality-evidence.ts';
import type { QualityEvidence } from './quality-evidence.ts';
import type { Mark } from './model.ts';

export class AnnotationCommandError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}
const validId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,200}$/.test(value);

/** Host-neutral command envelope; IDs/revisions do not refer to a loaded track. */
export function parseAnnotationOperation(value: unknown): AnnotationOperation {
  const op = value as AnnotationOperation | null;
  if (!op || !validId(op.id) || !validId(op.operationId) || !Number.isSafeInteger(op.revision) || op.revision < 0 || !['put', 'delete', 'restore', 'attach-quality-result'].includes(op.action)) {
    throw new AnnotationCommandError(400, 'invalid-annotation-command', '标注操作无效。');
  }
  if (op.client !== undefined && (!op.client || !['gui', 'agent', 'http'].includes(op.client.kind) || (op.client.id !== undefined && !validId(op.client.id)))) {
    throw new AnnotationCommandError(400, 'invalid-client', '操作客户端标识无效。');
  }
  if (op.action === 'attach-quality-result') {
    if (Object.keys(op).some(key=>!['operationId','id','revision','action','evidence','client'].includes(key)))
      throw new AnnotationCommandError(400, 'invalid-evidence-reference', 'Only an explicit result reference may be supplied.');
    try { qualityEvidenceRef(op.evidence); } catch { throw new AnnotationCommandError(400, 'invalid-evidence-reference', 'PSNR reference is invalid.'); }
    if (op.document !== undefined) throw new AnnotationCommandError(400, 'invalid-evidence-reference', 'Only a result reference may be supplied.');
  } else if (op.evidence !== undefined) throw new AnnotationCommandError(400, 'invalid-evidence-reference', 'Use the explicit attachment command.');
  return op;
}

/** The same transition rules apply to GUI, HTTP and future adapters.
 * The host owns storage, serialization, idempotency receipts and the clock. */
export function applyAnnotationOperation(operation: AnnotationOperation, current: AnnotationRecord | null,
  actor: NonNullable<Mark['author']>, now: string, evidence?: QualityEvidence) {
  if ((current?.revision ?? 0) !== operation.revision || (!current && operation.action !== 'put') || (current?.deleted && operation.action !== 'restore') || (current && !current.deleted && operation.action === 'restore')) {
    throw new AnnotationCommandError(409, 'annotation-revision-conflict', '标注已被其他人修改或删除，草稿已保留。');
  }
  let document;
  try { document = operation.action === 'put' ? parseAnnotationDocument(operation.document) : structuredClone(current!.document); }
  catch (error) { throw new AnnotationCommandError(400, 'invalid-annotation-document', (error as Error).message); }
  if (document.mark.id !== operation.id) throw new AnnotationCommandError(400, 'annotation-id-mismatch', '标注 ID 不一致。');
  if (current && annotationAnchor(current.document) !== annotationAnchor(document)) {
    throw new AnnotationCommandError(409, 'annotation-anchor-conflict', '不能更改已有标注的媒体版本或帧位置。');
  }
  if (operation.action === 'attach-quality-result') {
    if (!evidence || JSON.stringify(qualityEvidenceRef(evidence.ref)) !== JSON.stringify(qualityEvidenceRef(operation.evidence)) || !evidenceApplies(document, evidence))
      throw new AnnotationCommandError(409, 'evidence-anchor-conflict', 'PSNR source version, source PTS or ROI does not match this annotation.');
    try { document.mark.qualityEvidence = qualityEvidenceList([...(document.mark.qualityEvidence ?? []), evidence], true); }
    catch { throw new AnnotationCommandError(413, 'evidence-limit', 'PSNR evidence attachment budget exceeded.'); }
  } else if (current) {
    const previous = current.document.mark.qualityEvidence;
    // Old clients may omit attachments; they cannot remove, change or mint them.
    if (document.mark.qualityEvidence !== undefined && JSON.stringify(document.mark.qualityEvidence) !== JSON.stringify(previous ?? []))
      throw new AnnotationCommandError(409, 'evidence-immutable', 'Existing PSNR attachments are immutable.');
    if (previous) document.mark.qualityEvidence = structuredClone(previous);
  } else if (document.mark.qualityEvidence) document.mark.qualityEvidence = qualityEvidenceList(document.mark.qualityEvidence);
  if (!current) document.mark.author = { ...actor };
  else { document.mark.author = current.document.mark.author; document.mark.createdAt = current.document.mark.createdAt; }
  if (document.mark.replies) {
    const previous = new Map((current?.document.mark.replies ?? []).map(reply => [reply.id, reply]));
    document.mark.replies = document.mark.replies.map(reply => previous.get(reply.id) ?? { ...reply, author: { ...actor }, createdAt: now });
    if ([...previous.keys()].some(id => !document.mark.replies!.some(reply => reply.id === id))) {
      throw new AnnotationCommandError(409, 'annotation-replies-conflict', '不能移除已有回复。');
    }
  } else if (current?.document.mark.replies?.length) throw new AnnotationCommandError(409, 'annotation-replies-conflict', '不能移除已有回复。');
  return document;
}
