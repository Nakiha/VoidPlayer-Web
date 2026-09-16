import { annotationMediaKey } from '../annotation-record.ts';
import type { AnnotationDocument } from '../annotation-record.ts';
import { drawingsValue } from '../annotation.ts';
import { regionValue, slotValue } from '../model.ts';
import type { FrameInfo, Mark, MediaInfo, Slot } from '../model.ts';
import { randomUUID } from '../uuid.ts';

/** Pure mark helpers shared by UI and Agent through ReviewSession. No decoder/clock access. */

export function validateMarkText(text: unknown, drawings: { length: number }, emptyMessage: string) {
  if (typeof text !== 'string' || text.length > 2000 || (!text.trim() && !drawings.length)) throw new Error(emptyMessage);
  return text.trim();
}

export function validateSeverity(severity: unknown) {
  const value = severity ?? 3;
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 5) throw new Error('严重度必须是 1–5。');
  return Number(value);
}

export function validateOrigin(origin: unknown) {
  const value = origin ?? 'human';
  if (value !== 'human' && value !== 'agent') throw new Error('标注来源无效。');
  return value;
}

export type MarkTrackSnapshot = { slot: Slot; mediaId: string; frame: FrameInfo; offsetUs: number };

export function buildMark(input: { slot: unknown; text: unknown; severity?: unknown; origin?: unknown; region?: unknown; drawings?: unknown },
  track: MarkTrackSnapshot, peers: MarkTrackSnapshot[], positionUs: number, actor: { id: string; name: string } | null): Mark {
  const slot = slotValue(input.slot);
  if (track.slot !== slot) throw new Error('标注轨道不一致。');
  const drawings = drawingsValue(input.drawings);
  const text = validateMarkText(input.text, drawings, '写点文字或在画面上画一笔即可保存。');
  const severity = validateSeverity(input.severity);
  const origin = validateOrigin(input.origin);
  return {
    ...(actor ? { author: { ...actor } } : {}),
    id: randomUUID(), text, severity, origin,
    createdAt: new Date().toISOString(), slot, mediaId: track.mediaId,
    frame: { ...track.frame }, offsetUs: track.offsetUs, sessionPtsUs: positionUs, region: regionValue(input.region),
    ...(drawings.length ? { drawings } : {}),
    comparison: peers.map(t => ({ slot: t.slot, mediaId: t.mediaId, frame: { ...t.frame }, offsetUs: t.offsetUs })),
  };
}

export function applyMarkEdit(mark: Mark, input: { text?: unknown; drawings?: unknown }) {
  const text = input.text === undefined ? mark.text : input.text;
  const drawings = input.drawings === undefined ? mark.drawings ?? [] : drawingsValue(input.drawings);
  const next = validateMarkText(text, drawings, '标注不能为空。');
  mark.text = next; mark.drawings = drawings;
  return mark;
}

/** Merge persisted annotation documents. Returns null when nothing changed. */
export function mergeStoredMarks(current: Mark[], documents: AnnotationDocument[], removeIds: string[],
  loaded: MediaInfo[], catalog: Map<string, MediaInfo>): Mark[] | null {
  const incoming: Mark[] = [];
  for (const document of documents) {
    const saved = document.media.find(media => media.id === document.mark.mediaId);
    const target = saved && loaded.find(media => annotationMediaKey(media) === annotationMediaKey(saved));
    if (!target) continue;
    for (const media of document.media) if (!catalog.has(media.id)) catalog.set(media.id, media);
    const mark = structuredClone(document.mark); mark.mediaId = target.id;
    mark.comparison = mark.comparison.map(item => {
      const media = document.media.find(media => media.id === item.mediaId);
      const match = media && loaded.find(candidate => annotationMediaKey(candidate) === annotationMediaKey(media));
      return match ? { ...item, mediaId: match.id } : item;
    });
    incoming.push(mark);
  }
  // Replacements keep their position; only genuinely new marks append.
  // Moving echoed marks to the end would reshuffle the annotation strip on
  // every sync roundtrip.
  const incomingById = new Map(incoming.map(mark => [mark.id, mark]));
  const removed = new Set(removeIds.filter(id => !incomingById.has(id)));
  const existing = new Set(current.map(mark => mark.id));
  const next: Mark[] = [];
  for (const mark of current) {
    const replacement = incomingById.get(mark.id);
    if (replacement) next.push(replacement);
    else if (!removed.has(mark.id)) next.push(mark);
  }
  for (const mark of incoming) if (!existing.has(mark.id)) next.push(mark);
  return JSON.stringify(next) !== JSON.stringify(current) ? next : null;
}
