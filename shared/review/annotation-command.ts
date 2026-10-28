import {cambiRef,cambiEvidenceList,cambiCandidateDocument} from './cambi-evidence.ts';
import type {CambiEvidence} from './cambi-evidence.ts';
import { qualityCandidateDocument } from './quality-candidate.ts';
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
  if (!op || !validId(op.id) || !validId(op.operationId) || !Number.isSafeInteger(op.revision) || op.revision < 0 || !['put', 'delete', 'restore', 'attach-quality-result', 'create-quality-candidate','create-cambi-candidate'].includes(op.action)) {
    throw new AnnotationCommandError(400, 'invalid-annotation-command', '标注操作无效。');
  }
  if (op.client !== undefined && (!op.client || !['gui', 'agent', 'http'].includes(op.client.kind) || (op.client.id !== undefined && !validId(op.client.id)))) {
    throw new AnnotationCommandError(400, 'invalid-client', '操作客户端标识无效。');
  }
  if(op.action==='create-cambi-candidate'){
    if(Object.keys(op).some(k=>!['operationId','id','revision','action','cambi','candidate','client'].includes(k))||op.revision!==0)throw new AnnotationCommandError(400,'invalid-cambi-candidate','Invalid CAMBI command');
    const c=op.candidate;if(!c||Object.keys(c).sort().join(',')!=='severity,text'||typeof c.text!=='string'||!c.text.trim()||c.text.length>2000||!Number.isInteger(c.severity)||c.severity<1||c.severity>5)throw new AnnotationCommandError(400,'invalid-cambi-candidate','Explicit text and severity required');
    cambiRef(op.cambi);return op;
  }
  if(op.cambi!==undefined)throw new AnnotationCommandError(400,'invalid-cambi-candidate','CAMBI ref requires explicit creation command');
  if (op.action === 'attach-quality-result'||op.action==='create-quality-candidate') {
    if (Object.keys(op).some(key=>!['operationId','id','revision','action','evidence','client',...(op.action==='create-quality-candidate'?['candidate']:[])].includes(key)))
      throw new AnnotationCommandError(400, 'invalid-evidence-reference', 'Only an explicit result reference may be supplied.');
    if(op.action==='create-quality-candidate'){
      const c=op.candidate;
      if(op.revision!==0||!c||Object.keys(c).sort().join(',')!=='severity,text'||typeof c.text!=='string'||!c.text.trim()||c.text.length>2000||!Number.isInteger(c.severity)||c.severity<1||c.severity>5)
        throw new AnnotationCommandError(400,'invalid-quality-candidate','Provide explicit candidate text/severity and revision0.');
    }
    try { qualityEvidenceRef(op.evidence); } catch { throw new AnnotationCommandError(400, 'invalid-evidence-reference', 'PSNR reference is invalid.'); }
    if (op.document !== undefined) throw new AnnotationCommandError(400, 'invalid-evidence-reference', 'Only a result reference may be supplied.');
  } else if (op.evidence !== undefined) throw new AnnotationCommandError(400, 'invalid-evidence-reference', 'Use the explicit attachment command.');
  if(op.action!=='create-quality-candidate'&&op.candidate!==undefined)throw new AnnotationCommandError(400,'invalid-quality-candidate','Candidate fields require the explicit creation command.');
  return op;
}

/** The same transition rules apply to GUI, HTTP and future adapters.
 * The host owns storage, serialization, idempotency receipts and the clock. */
export function applyAnnotationOperation(operation: AnnotationOperation, current: AnnotationRecord | null,
  actor: NonNullable<Mark['author']>, now: string, evidence?: QualityEvidence, cambi?:CambiEvidence) {
  if ((current?.revision ?? 0) !== operation.revision || (!current && !['put','create-quality-candidate','create-cambi-candidate'].includes(operation.action)) || (current?.deleted && operation.action !== 'restore') || (current && !current.deleted && operation.action === 'restore')) {
    throw new AnnotationCommandError(409, 'annotation-revision-conflict', '标注已被其他人修改或删除，草稿已保留。');
  }
  const nr=operation.action==='create-cambi-candidate',creating=operation.action==='create-quality-candidate'||nr;
  if(creating&&current)throw new AnnotationCommandError(409,'annotation-revision-conflict','Candidate already exists.');
  let document;
  if(creating){
    if(nr){if(!cambi)throw new AnnotationCommandError(409,'evidence-unavailable','Completed CAMBI unavailable');document=cambiCandidateDocument(operation.id,operation.candidate!.text,operation.candidate!.severity,cambi,actor,now,operation.client?.kind==='agent'?'agent':'human');}
    else{
    if(!evidence)throw new AnnotationCommandError(409,'evidence-unavailable','Completed result is unavailable.');
    try{document=qualityCandidateDocument(operation.id,operation.candidate!,evidence,actor,now,operation.client?.kind==='agent'?'agent':'human');document.mark.qualityEvidence=[evidence];}
    catch(error){throw new AnnotationCommandError(409,'annotation-context-unavailable',(error as Error).message);}
  }
    }
  try { document = creating?parseAnnotationDocument(document):operation.action === 'put' ? parseAnnotationDocument(operation.document) : structuredClone(current!.document); }
  catch (error) { throw new AnnotationCommandError(400, 'invalid-annotation-document', (error as Error).message); }
  if (document.mark.id !== operation.id) throw new AnnotationCommandError(400, 'annotation-id-mismatch', '标注 ID 不一致。');
  if (current && annotationAnchor(current.document) !== annotationAnchor(document)) {
    throw new AnnotationCommandError(409, 'annotation-anchor-conflict', '不能更改已有标注的媒体版本或帧位置。');
  }
  if(nr){if(!cambi||JSON.stringify(cambiRef(cambi.ref))!==JSON.stringify(cambiRef(operation.cambi)))throw new AnnotationCommandError(409,'evidence-anchor-conflict','CAMBI reference changed');}
  else if (operation.action === 'attach-quality-result'||creating) {
    if (!evidence || JSON.stringify(qualityEvidenceRef(evidence.ref)) !== JSON.stringify(qualityEvidenceRef(operation.evidence)) || !evidenceApplies(document, evidence))
      throw new AnnotationCommandError(409, 'evidence-anchor-conflict', 'PSNR source version, source PTS or ROI does not match this annotation.');
    try { document.mark.qualityEvidence = qualityEvidenceList(creating?[evidence]:[...(document.mark.qualityEvidence ?? []), evidence], true); }
    catch { throw new AnnotationCommandError(413, 'evidence-limit', 'PSNR evidence attachment budget exceeded.'); }
  } else if (current) {
    const previousCandidate=current.document.mark.qualityCandidate;
    if(document.mark.qualityCandidate!==undefined&&JSON.stringify(document.mark.qualityCandidate)!==JSON.stringify(previousCandidate))throw new AnnotationCommandError(409,'candidate-immutable','Candidate creation facts are immutable.');
    if(previousCandidate)document.mark.qualityCandidate=structuredClone(previousCandidate);
    const nrPrevious=current.document.mark.cambiEvidence;if(document.mark.cambiEvidence!==undefined&&JSON.stringify(document.mark.cambiEvidence)!==JSON.stringify(nrPrevious??[]))throw new AnnotationCommandError(409,'evidence-immutable','CAMBI attachments immutable');if(nrPrevious)document.mark.cambiEvidence=structuredClone(nrPrevious);
    const previous = current.document.mark.qualityEvidence;
    // Old clients may omit attachments; they cannot remove, change or mint them.
    if (document.mark.qualityEvidence !== undefined && JSON.stringify(document.mark.qualityEvidence) !== JSON.stringify(previous ?? []))
      throw new AnnotationCommandError(409, 'evidence-immutable', 'Existing PSNR attachments are immutable.');
    if (previous) document.mark.qualityEvidence = structuredClone(previous);
  } else if (document.mark.qualityEvidence) document.mark.qualityEvidence = qualityEvidenceList(document.mark.qualityEvidence);
  if(!current&&!nr&&document.mark.cambiEvidence)document.mark.cambiEvidence=cambiEvidenceList(document.mark.cambiEvidence);
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
