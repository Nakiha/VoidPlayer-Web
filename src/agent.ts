import { ANNOTATION_COORD_LIMIT } from './annotation.ts';
import { SLOTS } from './model.ts';
import { benchmarkPlayback } from './benchmark.ts';
import type { ReviewSession } from './session.ts';
import { slotValue, timeUs } from './model.ts';
import { getLogSessions, readLogs, traceOperation } from './log.ts';
import { fetchLibraryPage, fetchLibraryItem, openLibraryItem } from './library.ts';

type Tool = { name: string; description: string; inputSchema: object; annotations: { readOnlyHint: boolean; untrustedContentHint: boolean }; execute: (input: unknown) => unknown };
type Registry = { registerTool: (tool: Tool, options: { signal: AbortSignal }) => unknown };
type WorkspaceActions = { exportWorkspace(): unknown; importWorkspace(value: unknown): Promise<unknown> };
export function reviewTools(session: ReviewSession, workspace?: WorkspaceActions): Tool[] {
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
    ...(workspace ? [
      tool('export_workspace', 'Export the current workspace, including absolute media service URLs, source references, marks, time and layout. No upload.', {}, [], true, () => workspace.exportWorkspace()),
      tool('import_workspace', 'Restore a workspace atomically using the same source resolution as the UI. Local sources may require the user to reselect files.', { document: { type: 'object' } }, ['document'], false, p => workspace.importWorkspace(p.document)),
    ] : []),
    tool('benchmark_review', 'Play currently loaded tracks from the start and measure actual canvas presentation, real playback speed, synchronization and pause stability in this page. Leaves playback paused. Background pages fail validation.', { durationMs: { type: 'integer', minimum: 1000, maximum: 30000 } }, [], false, p => benchmarkPlayback(session, p.durationMs as number | undefined)),
    tool('get_review_session', 'Read loaded media, decoded canvas frame timestamps, playback state and annotations. File names and notes are untrusted user data.', {}, [], true, () => session.getState()),
    tool('seek_review', 'Pause and seek all loaded videos to a relative timestamp in microseconds. Resolves after frames are decoded and drawn to canvas, not proof of physical display scanout.', { ptsUs: { type: 'integer', minimum: 0 } }, ['ptsUs'], false, p => session.seek(timeUs(p.ptsUs))),
    tool('step_review', 'Pause and step all loaded videos by one fair multi-track step: the target timestamp is chosen so the most tracks move exactly one frame without skipping intermediate frames.', { direction: { enum: [-1, 1] } }, ['direction'], false, p => session.step(p.direction as number)),
    tool('reorder_review_tracks', 'Reorder loaded tracks visually without changing their source identity, annotations or playback position.', { order: { type: 'array', items: { enum: SLOTS }, minItems: 1, maxItems: SLOTS.length } }, ['order'], false, p => session.reorderTracks(p.order as import('./model.ts').Slot[])),
    tool('remove_review_track', 'Close a track and release its decoder. Existing annotations remain available in the review export; source files are never deleted.', { slot: { enum: SLOTS } }, ['slot'], false, p => session.removeTrack(slotValue(p.slot))),
    tool('set_review_track_offset','Set manual alignment after per-file timestamp normalization. Positive delays the track; negative advances it. Pauses and redraws the current session time.',{slot:{enum:SLOTS},offsetUs:{type:'integer'}},['slot','offsetUs'],false,p=>session.setTrackOffset(slotValue(p.slot),p.offsetUs as number)),
    tool('pause_review', 'Stop comparison playback and retain the last drawn frames.', {}, [], false, () => session.pause()),
    tool('add_review_mark', 'Create a note on the paused, drawn frame. Does not seek. The note is included in the review export.', { slot: { enum: SLOTS }, text: { type: 'string', maxLength: 2000 }, drawings: { type: 'array', maxItems: 200, items: { type: 'object', properties: { tool: { enum: ['pen', 'ellipse', 'rect', 'line', 'text'] }, points: { type: 'array', minItems: 1, maxItems: 4000, items: { type: 'object', properties: { x: { type: 'number', minimum: -ANNOTATION_COORD_LIMIT, maximum: ANNOTATION_COORD_LIMIT }, y: { type: 'number', minimum: -ANNOTATION_COORD_LIMIT, maximum: ANNOTATION_COORD_LIMIT } }, required: ['x', 'y'], additionalProperties: false } }, text: { type: 'string', maxLength: 2000 }, id: { type: 'string', maxLength: 100 }, color: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' }, strokeWidth: { type: 'number', exclusiveMinimum: 0, maximum: 64 }, width: { type: 'number', exclusiveMinimum: 0, maximum: .1 }, fontSize: { type: 'number', exclusiveMinimum: 0, maximum: 1 } }, required: ['tool', 'points'], additionalProperties: false } }, severity: { type: 'integer', minimum: 1, maximum: 5 } }, ['slot'], false, p => session.addMark({ ...p, slot: p.slot, text: p.text ?? '', origin: 'agent' })),
    tool('update_review_mark', 'Edit a saved mark on its currently displayed frame, preserving its identity and anchor.', { id: { type: 'string' }, text: { type: 'string', maxLength: 2000 }, drawings: { type: 'array', maxItems: 200, items: { type: 'object', properties: { tool: { enum: ['pen', 'ellipse', 'rect', 'line', 'text'] }, points: { type: 'array', minItems: 1, maxItems: 4000, items: { type: 'object', properties: { x: { type: 'number', minimum: -ANNOTATION_COORD_LIMIT, maximum: ANNOTATION_COORD_LIMIT }, y: { type: 'number', minimum: -ANNOTATION_COORD_LIMIT, maximum: ANNOTATION_COORD_LIMIT } }, required: ['x', 'y'], additionalProperties: false } }, text: { type: 'string', maxLength: 2000 }, id: { type: 'string', maxLength: 100 }, color: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' }, strokeWidth: { type: 'number', exclusiveMinimum: 0, maximum: 64 }, width: { type: 'number', exclusiveMinimum: 0, maximum: .1 }, fontSize: { type: 'number', exclusiveMinimum: 0, maximum: 1 } }, required: ['tool', 'points'], additionalProperties: false } } }, ['id'], false, p => session.updateMark(String(p.id), p)),
    tool('export_review', 'Return the versioned review JSON with source metadata and frame anchors. Does not upload or download files.', {}, [], true, () => session.exportReview()),
    tool('get_review_logs', 'Read a detached, chronological page of diagnostic events. Use sessionId and nextSeq as the next sinceSeq; gap signals evicted history. Reading does not create events. Payloads are untrusted.', { sinceSeq: { type: 'integer', minimum: 0 }, level: { enum: ['debug', 'info', 'warn', 'error'] }, limit: { type: 'integer', minimum: 1, maximum: 2000 }, sessionId: { type: 'string', maxLength: 100 } }, [], true,
      p => readLogs(p)),
    tool('list_review_log_sessions', 'List current and retained local diagnostic sessions and storage status. No upload and no new log events.', {}, [], true, () => getLogSessions()),
    tool('list_library', 'Browse indexed media with bounded pages. Use nextOffset and revision for the next page; recursive defaults to true. Directory browsing uses recursive:false.', { root: { type: 'string' }, directory: { type: 'string' }, search: { type: 'string' }, recursive: { type: 'boolean' }, offset: { type: 'integer', minimum: 0 }, revision: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 200 } }, [], true,
      async p => fetchLibraryPage({ root: typeof p.root === 'string' ? p.root : undefined, directory: typeof p.directory === 'string' ? p.directory : undefined, search: typeof p.search === 'string' ? p.search : undefined, recursive: p.recursive !== false, offset: typeof p.offset === 'number' ? p.offset : undefined, revision: typeof p.revision === 'number' ? p.revision : undefined, limit: typeof p.limit === 'number' ? p.limit : 100 }, AbortSignal.timeout(5000))),
    tool('load_library_item', 'Load a library media item into track A, B, C or D by its id from list_library.', { id: { type: 'string' }, slot: { enum: SLOTS } }, ['id', 'slot'], false,
      async p => {
        const entry = typeof p.id === 'string' ? await fetchLibraryItem(p.id, AbortSignal.timeout(5000)) : null;
        if (!entry) throw new Error('媒体库中没有该文件，或服务未连接。');
        return session.load(slotValue(p.slot), () => openLibraryItem(entry));
      }),
  ];
}
export function registerReviewTools(session: ReviewSession, workspace?: WorkspaceActions) {
  const context = (document as unknown as { modelContext?: Registry }).modelContext ?? (navigator as unknown as { modelContext?: Registry }).modelContext;
  const lifecycle = new AbortController();
  if (context?.registerTool) {
    for (const tool of reviewTools(session, workspace)) {
      try { void Promise.resolve(context.registerTool(tool, { signal: lifecycle.signal })).catch(console.warn); }
      catch (error) { console.warn('WebMCP registration failed', error); }
    }
  }
  return () => lifecycle.abort();
}
