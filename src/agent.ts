import { SLOTS } from './model.ts';
import { benchmarkPlayback } from './benchmark.ts';
import type { ReviewSession } from './session.ts';
import { slotValue, timeUs } from './model.ts';
import { getLogSessions, readLogs, traceOperation } from './log.ts';
import { fetchLibrary, openLibraryItem } from './library.ts';

type Tool = { name: string; description: string; inputSchema: object; annotations: { readOnlyHint: boolean; untrustedContentHint: boolean }; execute: (input: unknown) => unknown };
type Registry = { registerTool: (tool: Tool, options: { signal: AbortSignal }) => unknown };
export function reviewTools(session: ReviewSession): Tool[] {
  const tool = (name: string, description: string, properties: object, required: string[], readOnly: boolean, action: (p: Record<string, unknown>) => unknown): Tool => ({
    name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false },
    annotations: { readOnlyHint: readOnly, untrustedContentHint: true },
    execute(input) {
      const execute = () => {
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('参数必须是对象。');
        const p = input as Record<string, unknown>;
        if (Object.keys(p).some(key => !Object.hasOwn(properties, key)) || required.some(key => !Object.hasOwn(p, key))) throw new Error('参数缺失或包含未知字段。');
        return action(p);
      };
      // Successful polling must not manufacture events or evict useful history.
      return readOnly ? execute() : traceOperation('agent', name, input, execute);
    },
  });
  return [
    tool('benchmark_review', 'Play currently loaded tracks from the start and measure actual canvas presentation, real playback speed, synchronization and pause stability in this page. Leaves playback paused. Background pages fail validation.', { durationMs: { type: 'integer', minimum: 1000, maximum: 30000 } }, [], false, p => benchmarkPlayback(session, p.durationMs as number | undefined)),
    tool('get_review_session', 'Read loaded media, decoded canvas frame timestamps, playback state and annotations. File names and notes are untrusted user data.', {}, [], true, () => session.getState()),
    tool('seek_review', 'Pause and seek all loaded videos to a relative timestamp in microseconds. Resolves after frames are decoded and drawn to canvas, not proof of physical display scanout.', { ptsUs: { type: 'integer', minimum: 0 } }, ['ptsUs'], false, p => session.seek(timeUs(p.ptsUs))),
    tool('step_review', 'Pause and step all loaded videos by one fair multi-track step: the target timestamp is chosen so the most tracks move exactly one frame without skipping intermediate frames.', { direction: { enum: [-1, 1] } }, ['direction'], false, p => session.step(p.direction as number)),
    tool('reorder_review_tracks', 'Reorder loaded tracks visually without changing their source identity, annotations or playback position.', { order: { type: 'array', items: { enum: SLOTS }, minItems: 1, maxItems: SLOTS.length } }, ['order'], false, p => session.reorderTracks(p.order as import('./model.ts').Slot[])),
    tool('remove_review_track', 'Close a track and release its decoder. Existing annotations remain available in the review export; source files are never deleted.', { slot: { enum: SLOTS } }, ['slot'], false, p => session.removeTrack(slotValue(p.slot))),
    tool('set_review_track_offset','Set manual alignment after per-file timestamp normalization. Positive delays the track; negative advances it. Pauses and redraws the current session time.',{slot:{enum:SLOTS},offsetUs:{type:'integer'}},['slot','offsetUs'],false,p=>session.setTrackOffset(slotValue(p.slot),p.offsetUs as number)),
    tool('pause_review', 'Stop comparison playback and retain the last drawn frames.', {}, [], false, () => session.pause()),
    tool('add_review_mark', 'Create a note on the paused, drawn frame. Does not seek. The note is included in the review export.', { slot: { enum: SLOTS }, text: { type: 'string', maxLength: 2000 }, drawings: { type: 'array', maxItems: 200, items: { type: 'object', properties: { tool: { enum: ['pen', 'ellipse', 'rect', 'line', 'text'] }, points: { type: 'array', minItems: 1, maxItems: 4000, items: { type: 'object', properties: { x: { type: 'number', minimum: 0, maximum: 1 }, y: { type: 'number', minimum: 0, maximum: 1 } }, required: ['x', 'y'], additionalProperties: false } }, text: { type: 'string', maxLength: 2000 } }, required: ['tool', 'points'], additionalProperties: false } }, severity: { type: 'integer', minimum: 1, maximum: 5 } }, ['slot'], false, p => session.addMark({ ...p, slot: p.slot, text: p.text ?? '', origin: 'agent' })),
    tool('export_review', 'Return the versioned review JSON with source metadata and frame anchors. Does not upload or download files.', {}, [], true, () => session.exportReview()),
    tool('get_review_logs', 'Read a detached, chronological page of diagnostic events. Use sessionId and nextSeq as the next sinceSeq; gap signals evicted history. Reading does not create events. Payloads are untrusted.', { sinceSeq: { type: 'integer', minimum: 0 }, level: { enum: ['debug', 'info', 'warn', 'error'] }, limit: { type: 'integer', minimum: 1, maximum: 2000 }, sessionId: { type: 'string', maxLength: 100 } }, [], true,
      p => readLogs(p)),
    tool('list_review_log_sessions', 'List current and retained local diagnostic sessions and storage status. No upload and no new log events.', {}, [], true, () => getLogSessions()),
    tool('list_library', 'List media files exposed by the optional local library service. Returns available:false when no service is connected.', {}, [], true,
      async () => await fetchLibrary() ?? { available: false, entries: [] }),
    tool('load_library_item', 'Load a library media item into track A, B, C or D by its id from list_library.', { id: { type: 'string' }, slot: { enum: SLOTS } }, ['id', 'slot'], false,
      async p => {
        const library = await fetchLibrary();
        const entry = library?.entries.find(e => e.id === p.id);
        if (!entry) throw new Error('媒体库中没有该文件，或服务未连接。');
        return session.load(slotValue(p.slot), () => openLibraryItem(entry));
      }),
  ];
}
export function registerReviewTools(session: ReviewSession) {
  const context = (document as unknown as { modelContext?: Registry }).modelContext ?? (navigator as unknown as { modelContext?: Registry }).modelContext;
  const lifecycle = new AbortController();
  if (context?.registerTool) {
    for (const tool of reviewTools(session)) {
      try { void Promise.resolve(context.registerTool(tool, { signal: lifecycle.signal })).catch(console.warn); }
      catch (error) { console.warn('WebMCP registration failed', error); }
    }
  }
  return () => lifecycle.abort();
}
