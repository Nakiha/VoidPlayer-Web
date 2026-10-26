import type { Mark, MediaInfo } from './model.ts';
import { evidenceWorkspaceVersion, historicalMarks } from './quality-evidence.ts';
import type { QualityEvidenceRef } from './quality-evidence.ts';
import { parseWorkspace } from './workspace-file.ts';
import { Viewport } from '../presentation/viewport.ts';
import { randomUUID } from '../utils/uuid.ts';
import type { WorkspaceFile } from './workspace-file.ts';
import { referenceVersion } from '../media/io/media-reference.ts';

export type AnnotationDocument = { mark: Mark; media: MediaInfo[] };
export type AnnotationRecord = { id: string; space: string; revision: number; sequence: number; deleted: boolean; updatedAt: string; updatedBy: string; document: AnnotationDocument };
/** Client labels are attribution supplied by the caller, never authentication. */
export type AnnotationClientIdentity = { kind: 'gui' | 'agent' | 'http'; id?: string };
export type AnnotationOperation = { operationId: string; id: string; revision: number; action: 'put' | 'delete' | 'restore' | 'attach-quality-result' | 'create-quality-candidate'; candidate?:{text:string;severity:number}; evidence?: QualityEvidenceRef; document?: AnnotationDocument; client?: AnnotationClientIdentity };
export type AnnotationPage = { entries: AnnotationRecord[]; cursor: number; previewEpoch?: number; more: boolean };
export function parseAnnotationDocument(value: unknown): AnnotationDocument {
  const input = value as AnnotationDocument;
  const document = parseWorkspace({ schema: 'voidplayer-workspace', version: input?.mark?.qualityCandidate?3:2, generatedAt: new Date().toISOString(), serverUrl: 'http://localhost/', positionUs: 0, tracks: [], media: input?.media, marks: [input?.mark], viewport: {} }, undefined, true);
  return { mark: document.marks[0], media: document.media };
}
/** Only version-pinned library references can be shared across new playback sessions.
 * Local file IDs are deliberately not guessed from filename/size/mtime. */
export function annotationMediaKey(media: MediaInfo) {
  const version = referenceVersion(media.source?.url);
  return media.source && version ? JSON.stringify([media.source.id, version]) : `local:${media.id}`;
}
export function annotationAnchor(document: AnnotationDocument) {
  const media = document.media.find(item => item.id === document.mark.mediaId)!;
  return JSON.stringify([annotationMediaKey(media), document.mark.frame]);
}

/** A regular workspace backup: imported annotations stay local until explicitly published. */
export function annotationWorkspace(documents: AnnotationDocument[], serverUrl: string): WorkspaceFile {
  const media: MediaInfo[] = [], marks: Mark[] = [], keys = new Map<string,string>();
  for (const document of documents) {
    const ids = new Map<string,string>();
    for (const source of document.media) {
      const key = annotationMediaKey(source); let id=keys.get(key);
      if(!id){id=randomUUID();keys.set(key,id);media.push({...structuredClone(source),id});}
      ids.set(source.id,id);
    }
    const mark=structuredClone(document.mark);mark.id=randomUUID();mark.mediaId=ids.get(mark.mediaId)!;
    mark.comparison=mark.comparison.map(item=>({...item,mediaId:ids.get(item.mediaId)!}));marks.push(...historicalMarks([mark]));
  }
  const first=marks[0];
  return {schema:'voidplayer-workspace',version:evidenceWorkspaceVersion(marks),generatedAt:new Date().toISOString(),serverUrl,media,marks,tracks:first?[{slot:first.slot,mediaId:first.mediaId,offsetUs:0}]:[],positionUs:first?.frame.ptsUs??0,viewport:new Viewport().snapshot()};
}
