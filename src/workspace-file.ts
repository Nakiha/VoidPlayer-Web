import { drawingsValue } from './annotation.ts';
import { regionValue, slotValue, timeUs } from './model.ts';
import type { FrameInfo, Mark, MediaInfo, Slot } from './model.ts';
import { Viewport } from './viewport.ts';
import type { ViewportSnapshot } from './viewport.ts';

export type WorkspaceLayout = {
  panels: { inspector: boolean; subtracks: boolean; sources: boolean };
  selected: Slot; dockHeight: number; marksExpanded: boolean;
  filenameWidth?: number; marksWidth?: number;
};
export type WorkspaceFile = {
  schema: 'voidplayer-workspace'; version: 1; generatedAt: string; serverUrl: string;
  positionUs: number; tracks: { slot: Slot; mediaId: string; offsetUs: number }[];
  media: MediaInfo[]; marks: Mark[]; viewport: ViewportSnapshot; layout?: WorkspaceLayout;
  thumbnails?: { id: string; url: string; width: number; height: number }[];
};
const MAX_BYTES = 32 * 1024 * 1024;
function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('工作区内容无效。');
  return value as Record<string, any>;
}
function text(value: unknown, max = 2000): string {
  if (typeof value !== 'string' || value.length > max) throw new Error('工作区文本字段无效。');
  return value;
}
function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error('工作区数值无效。');
  return value;
}
function array(value: unknown, max: number): any[] {
  if (!Array.isArray(value) || value.length > max) throw new Error('工作区列表无效或过大。');
  return value;
}
function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('工作区开关无效。');
  return value;
}
export function workspaceUrl(value: unknown, base?: string) {
  const url = new URL(text(value, 8192), base);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('工作区片源必须使用 HTTP(S) 服务地址。');
  return url.href;
}
function frame(value: unknown): FrameInfo {
  const f = object(value);
  return { ptsUs: timeUs(f.ptsUs), sourcePtsUs: integer(f.sourcePtsUs), durationUs: timeUs(f.durationUs) };
}
/** Validate before any source is opened or the active session is changed. */
export function parseWorkspace(value: unknown, baseUrl?: string): WorkspaceFile {
  let d = object(value);
  // Read the previous review export too; it did not contain a view or position.
  if (d.schema === 'voidplayer-web-review' && d.version === 1) d = { ...d, schema: 'voidplayer-workspace', tracks: d.alignment, serverUrl: baseUrl, positionUs: 0, viewport: new Viewport().snapshot() };
  if (d.schema !== 'voidplayer-workspace' || d.version !== 1) throw new Error('不支持的工作区文件或版本。');
  const serverUrl = workspaceUrl(d.serverUrl, baseUrl);
  const media: MediaInfo[] = array(d.media, 1000).map(value => {
    const m = object(value);
    if (!['webcodecs', 'ffmpeg-wasm'].includes(m.decoder)) throw new Error('工作区媒体信息无效。');
    const result: MediaInfo = { id: text(m.id, 200), name: text(m.name), size: timeUs(m.size), lastModified: timeUs(m.lastModified), codec: text(m.codec), decoder: m.decoder, width: timeUs(m.width), height: timeUs(m.height), durationUs: timeUs(m.durationUs), firstPtsUs: integer(m.firstPtsUs) };
    if (m.source) { const source = object(m.source); if (source.kind !== 'library') throw new Error('工作区片源类型无效。'); result.source = { kind: 'library', id: text(source.id, 200), url: workspaceUrl(source.url, serverUrl) }; }
    return result;
  });
  const ids = new Set(media.map(m => m.id));
  if (ids.size !== media.length || ids.has('')) throw new Error('工作区媒体 ID 重复或为空。');
  const tracks = array(d.tracks, 4).map(value => { const t = object(value); return { slot: slotValue(t.slot), mediaId: text(t.mediaId, 200), offsetUs: integer(t.offsetUs) }; });
  if (new Set(tracks.map(t => t.slot)).size !== tracks.length || new Set(tracks.map(t => t.mediaId)).size !== tracks.length) throw new Error('工作区轨道重复。');
  for (const t of tracks) { const m = media.find(m => m.id === t.mediaId); if (!m || m.durationUs + t.offsetUs <= 0 || !Number.isSafeInteger(m.durationUs + t.offsetUs)) throw new Error('工作区轨道引用或时间范围无效。'); }
  const marks: Mark[] = array(d.marks, 10000).map(value => {
    const m = object(value), mediaId = text(m.mediaId, 200), severity = integer(m.severity);
    if (!ids.has(mediaId) || severity < 1 || severity > 5 || !['human', 'agent'].includes(m.origin)) throw new Error('工作区标注引用或属性无效。');
    const mark: Mark = { id: text(m.id, 200), text: text(m.text), severity, origin: m.origin, createdAt: text(m.createdAt, 100), slot: slotValue(m.slot), mediaId, frame: frame(m.frame), region: regionValue(m.region), drawings: drawingsValue(m.drawings), comparison: array(m.comparison, 4).map(value => {
      const c = object(value); if (!ids.has(c.mediaId)) throw new Error('标注对比片源不存在。');
      return { slot: slotValue(c.slot), mediaId: text(c.mediaId, 200), frame: frame(c.frame), ...(c.offsetUs === undefined ? {} : { offsetUs: integer(c.offsetUs) }) };
    }) };
    if (m.offsetUs !== undefined) mark.offsetUs = integer(m.offsetUs);
    if (m.sessionPtsUs !== undefined) mark.sessionPtsUs = timeUs(m.sessionPtsUs);
    if (m.author) { const a = object(m.author); mark.author = { id: text(a.id, 200), name: text(a.name, 200) }; }
    return mark;
  });
  if (new Set(marks.map(m => m.id)).size !== marks.length || marks.some(m => !m.id)) throw new Error('工作区标注 ID 重复或为空。');
  const viewport = new Viewport(); viewport.apply(object(d.viewport));
  let layout: WorkspaceLayout | undefined;
  if (d.layout) {
    const l = object(d.layout), p = object(l.panels);
    layout = { panels: { inspector: boolean(p.inspector), subtracks: boolean(p.subtracks), sources: boolean(p.sources) }, selected: slotValue(l.selected), dockHeight: timeUs(l.dockHeight), marksExpanded: boolean(l.marksExpanded) };
    for (const key of ['filenameWidth', 'marksWidth'] as const) if (l[key] !== undefined) layout[key] = timeUs(l[key]);
  }
  const thumbnails = array(d.thumbnails ?? [], 10000).map(value => {
    const t = object(value), url = text(t.url, 2 * 1024 * 1024), id = text(t.id, 200);
    if (!marks.some(m => m.id === id) || !/^data:image\/jpeg;base64,[a-zA-Z0-9+/=]+$/.test(url)) throw new Error('工作区缩略图无效。');
    return { id, url, width: timeUs(t.width), height: timeUs(t.height) };
  });
  return { schema: 'voidplayer-workspace', version: 1, generatedAt: text(d.generatedAt, 100), serverUrl, positionUs: timeUs(d.positionUs), tracks, media, marks, viewport: viewport.snapshot(), ...(layout ? { layout } : {}), thumbnails };
}
export async function readWorkspaceFile(file: Blob, baseUrl: string): Promise<WorkspaceFile> {
  if (file.size > MAX_BYTES) throw new Error('工作区文件超过 32 MiB。');
  const signature = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  const stream = signature[0] === 31 && signature[1] === 139 ? file.stream().pipeThrough(new DecompressionStream('gzip')) : file.stream();
  const reader = stream.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > MAX_BYTES) throw new Error('工作区解压后超过 32 MiB。'); chunks.push(value); } }
  finally { await reader.cancel(); }
  return parseWorkspace(JSON.parse(await new Blob(chunks as BlobPart[]).text()), baseUrl);
}
export async function compressWorkspace(document: WorkspaceFile): Promise<Blob> {
  const blob = new Blob([JSON.stringify(document)]);
  if (blob.size > MAX_BYTES) throw new Error('工作区内容超过 32 MiB，请减少缩略图或标注。');
  return new Response(blob.stream().pipeThrough(new CompressionStream('gzip'))).blob();
}
