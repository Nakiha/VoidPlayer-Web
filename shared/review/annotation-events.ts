import type { AnnotationClientIdentity, AnnotationOperation, AnnotationRecord } from './annotation-record.ts';
import type { FrameInfo } from '../media/types.ts';
import type { Mark } from './model.ts';
import { referenceVersion } from '../media/io/media-reference.ts';

export type AnnotationEvent = {
  version: 1;
  sequence: number;
  operationId: string;
  requestId?: string;
  space: string;
  id: string;
  revision: number;
  action: AnnotationOperation['action'];
  state: 'committed';
  actor: NonNullable<Mark['author']>;
  client: AnnotationClientIdentity;
  occurredAt: string;
  summary: string;
  target: { name: string; mediaId: string; source?: { id: string; version: string }; frame: FrameInfo };
};
export type AnnotationEventPage = {
  schema: 'voidplayer-annotation-events';
  version: 1;
  space: string;
  events: AnnotationEvent[];
  cursor: number;
  head: number;
  more: boolean;
  resetRequired: boolean;
  reason?: 'history-expired' | 'cursor-ahead';
  snapshotUrl: string;
};

export function annotationEvent(record: AnnotationRecord, operation: AnnotationOperation,
  actor: AnnotationEvent['actor'], requestId?: string): AnnotationEvent {
  const media = record.document.media.find(item => item.id === record.document.mark.mediaId)!;
  const version = referenceVersion(media.source?.url);
  return {
    version: 1, sequence: record.sequence, operationId: operation.operationId,
    ...(requestId ? { requestId } : {}), space: record.space, id: record.id, revision: record.revision,
    action: operation.action, state: 'committed', actor: { ...actor },
    client: operation.client ? { kind: operation.client.kind, ...(operation.client.id ? { id: operation.client.id } : {}) } : { kind: 'http' },
    occurredAt: record.updatedAt, summary: record.document.mark.text.slice(0, 160),
    target: { name: media.name.slice(0, 200), mediaId: media.id,
      ...(media.source && version ? { source: { id: media.source.id, version } } : {}), frame: { ...record.document.mark.frame } },
  };
}

/** At-least-once delivery: duplicates cannot create duplicate activity rows.
 * A space's sequence may have gaps because other spaces share the server clock. */
export function mergeAnnotationEvents(current: AnnotationEvent[], page: AnnotationEventPage, limit = 50) {
  const entries = new Map((page.resetRequired ? [] : current).filter(event => event.space === page.space).map(event => [event.sequence, event]));
  for (const event of page.events) entries.set(event.sequence, event);
  return [...entries.values()].sort((a, b) => a.sequence - b.sequence).slice(-limit);
}
