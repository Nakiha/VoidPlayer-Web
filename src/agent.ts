import { qualityPairViewUrl } from '../shared/review/quality-pair-view.ts';
import { frameIndexTools } from './services/frame-index.ts';
import { attachAnnotationQuality, createQualityCandidate } from './review/quality-evidence-client.ts';
import { AnnotationClient } from './review/annotation-client.ts';
import type { QualityEvidenceRef } from '../shared/review/quality-evidence.ts';
import { ANNOTATION_COORD_LIMIT } from '../shared/review/annotation.ts';
import { SLOTS } from '../shared/review/model.ts';
import { benchmarkPlayback } from './session/benchmark.ts';
import type { ReviewSession } from './session.ts';
import { slotValue, timeUs } from '../shared/review/model.ts';
import { getLogSessions, readLogs, traceOperation } from './logging/log.ts';
import { fetchLibraryPage, fetchLibraryItem, openLibraryItem } from './services/library.ts';
import { validateToolInput, type ToolInputSchema } from './agent/tool-input.ts';
import {PAGE_TOOLS} from '../shared/service/page-bridge.ts';

type Tool = { name: string; description: string; inputSchema: object; annotations: { readOnlyHint: boolean; untrustedContentHint: boolean }; execute: (input: unknown) => unknown };
type Registry = { registerTool: (tool: Tool, options: { signal: AbortSignal }) => unknown };
type WorkspaceActions = { exportWorkspace(): unknown; shareWorkspace?(): Promise<unknown>; importWorkspace(value: unknown): Promise<unknown> };
export function reviewTools(session: ReviewSession, workspace?: WorkspaceActions): Tool[] {
  const tool = (name: string, description: string, properties: Record<string, ToolInputSchema>, required: string[], readOnly: boolean, action: (p: Record<string, unknown>) => unknown): Tool => {
    const inputSchema: ToolInputSchema = { type: 'object', properties, required, additionalProperties: false };
    return {
      name, description, inputSchema,
      annotations: { readOnlyHint: readOnly, untrustedContentHint: true },
      execute(input) {
        const execute = () => {
          validateToolInput(inputSchema, input);
          return action(input as Record<string, unknown>);
        };
        // Successful polling must not manufacture events or evict useful history.
        return readOnly ? execute() : traceOperation('agent', name, input, execute);
      },
    };
  };
  const pageTool=(name:keyof typeof PAGE_TOOLS,action:(p:Record<string,unknown>)=>unknown)=>{
    const d=PAGE_TOOLS[name];return tool(name,d.description,d.inputSchema.properties!,[...d.inputSchema.required??[]],d.scope==='read',action);
  };
  return [
    tool('attach_annotation_psnr','Explicitly share the immutable facts of your completed PSNR job on an existing shared annotation. Requires exact source version/source PTS/ROI and revision; never scores, creates annotations or changes playback. Reuse operationId after a lost response.',
      {space:{type:'string'},id:{type:'string'},revision:{type:'integer',minimum:1},operationId:{type:'string'},evidence:{type:'object',properties:{jobId:{type:'string'},attemptId:{type:'string'},digest:{type:'string'},side:{enum:['reference','distorted']}},required:['jobId','attemptId','digest','side'],additionalProperties:false}},
      ['space','id','revision','operationId','evidence'],false,p=>attachAnnotationQuality({space:p.space as string,id:p.id as string,revision:p.revision as number,operationId:p.operationId as string,evidence:p.evidence as QualityEvidenceRef},{kind:'agent'})),
    tool('get_annotation_evidence','Read explicitly shared PSNR facts from an annotation. Historical imports are unverified; this does not grant access to the private original job or load a source.',
      {space:{type:'string'},id:{type:'string'}},['space','id'],true,p=>{
        if(![p.space,p.id].every(v=>typeof v==='string' && /^[a-zA-Z0-9_-]{1,200}$/.test(v)))throw new Error('Invalid annotation reference.');
        return new AnnotationClient(AbortSignal.timeout(10000)).read(p.space as string,p.id as string);
      }),
    tool('get_annotation_pair_view','Return the explicit isolated original-frame/ROI viewer URL for an existing shared attachment. Following it checks the originating service, pinned cache/AU/PTS/geometry; no score, private job read or change to this playback.',
      {space:{type:'string'},annotationId:{type:'string'},evidenceId:{type:'string'}},['space','annotationId','evidenceId'],true,p=>({url:qualityPairViewUrl({space:p.space as string,annotationId:p.annotationId as string,evidenceId:p.evidenceId as string},location.origin)})),
    tool('create_quality_candidate','Atomically derive a shared unassessed measurement candidate and immutable evidence from an owned completed quality result. Explicit text/severity; no playback requirement; receipt replay precedes result lookup.',
      {space:{type:'string'},id:{type:'string'},operationId:{type:'string'},evidence:{type:'object'},candidate:{type:'object'}},['space','id','operationId','evidence','candidate'],false,p=>createQualityCandidate({space:p.space as string,id:p.id as string,operationId:p.operationId as string,evidence:p.evidence as QualityEvidenceRef,candidate:p.candidate as {text:string;severity:number}},{kind:'agent'})),
    ...frameIndexTools(),
    tool('request_bitstream_range','Explicitly analyze a bounded half-open session-time range (up to 1 second and 32 pictures) independently of playback. Completed chunks are cached incrementally.',{slot:{enum:SLOTS},startUs:{type:'integer'},endUs:{type:'integer'}},['slot','startUs','endUs'],false,p=>session.requestBitstreamRange(slotValue(p.slot),p.startUs as number,p.endUs as number)),
    tool('get_presented_frame','Read the successful presentation commit and optional playback picture metadata. This is not quality cache/output proof: it lacks namespace/build and cannot select a measurement by PTS. No pixels or analysis IO.',{slot:{enum:SLOTS}},['slot'],true,p=>session.getPresentedFrame(slotValue(p.slot))),
    tool('capture_presented_quality_frame','Capture an exact successful paused WebCodecs FLV presentation input. Returns local unbound source/AU/epoch/commit evidence; join only the same AU to the existing trusted cache through its packet witness. No pixels, source scans, scoring, pause or seek. Unsupported playback paths reject. HTTP scoring remains independent of this optional browser tool.',{slot:{enum:SLOTS}},['slot'],true,p=>session.captureNativePresented(slotValue(p.slot))),
    tool('request_bitstream_analysis','Explicitly analyze the paused presented picture in an independent local worker or on its library server. No upload of local files.',{slot:{enum:SLOTS}},['slot'],false,p=>session.requestBitstreamAnalysis(slotValue(p.slot))),
    tool('cancel_bitstream_analysis','Cancel one track deep analysis, or all tracks when slot is omitted, without changing playback.',{slot:{enum:SLOTS}},[],false,p=>session.cancelBitstreamAnalysis(p.slot === undefined ? undefined : slotValue(p.slot))),
    tool('pause_bitstream_analysis','Pause one track analysis and retain its cached results without changing playback.',{slot:{enum:SLOTS}},['slot'],false,p=>session.pauseBitstreamAnalysis(slotValue(p.slot))),
    tool('resume_bitstream_analysis','Resume a paused track analysis in its previous window with retained coverage; decoding may replay the reference prefix.',{slot:{enum:SLOTS}},['slot'],false,p=>session.resumeBitstreamAnalysis(slotValue(p.slot))),
    tool('get_bitstream_analysis_state','Read one track deep analysis status; omitted slot reads the most recently requested track. Does not start work.',{slot:{enum:SLOTS}},[],true,p=>session.getBitstreamAnalysisState(p.slot === undefined ? undefined : slotValue(p.slot))),
    ...(workspace ? [
      ...(workspace.shareWorkspace ? [tool('share_workspace', 'Save the current writable workspace and copy a link restoring its sources, position and layout. Recipients can edit and save the same workspace; annotations remain live. Requires library sources, no video upload.', {}, [], false, () => workspace.shareWorkspace!())] : []),
      tool('export_workspace', 'Export the current workspace, including absolute media service URLs, source references, marks, time and layout. No upload.', {}, [], true, () => workspace.exportWorkspace()),
      tool('import_workspace', 'Restore a workspace atomically using the same source resolution as the UI. Local sources may require the user to reselect files.', { document: { type: 'object' } }, ['document'], false, p => workspace.importWorkspace(p.document)),
    ] : []),
    tool('benchmark_review', 'Play currently loaded tracks from the start and measure actual canvas presentation, real playback speed, synchronization and pause stability in this page. Leaves playback paused. Background pages fail validation.', { durationMs: { type: 'integer', minimum: 1000, maximum: 30000 } }, [], false, p => benchmarkPlayback(session, p.durationMs as number | undefined)),
    pageTool('get_review_session', () => session.getState()),
    pageTool('get_review_marks', p => {const marks=session.getState().marks;const after=p.afterId===undefined?-1:marks.findIndex(m=>m.id===p.afterId);if(p.afterId!==undefined&&after<0)throw Error('Mark cursor expired; read again without afterId.');const limit=p.limit as number|undefined??4,entries=marks.slice(after+1,after+1+limit);return {entries,nextAfterId:after+1+limit<marks.length?entries.at(-1)!.id:null};}),
    tool('get_analysis_capabilities', 'Read per-track bitstream analysis support (sample sizes, DTS axis, key flags, QP) without fetching statistics. Full sample arrays are never in session state; use query_analysis for bounded ranges.', {}, [], true, () => session.getAnalysisCapabilities()),
    tool('request_bitstream_stream', 'Explicitly check a source or optional viewport with GOP-grouped bounded chunks. Default keeps full results; product summary explicitly requests independently reusable chart metadata. Publishes progress and caches completed pictures; does not seek or change playback. Cancel through cancel_bitstream_analysis.', { slot: { enum: SLOTS }, product:{enum:['summary','blocks']}, window:{type:'object',properties:{startUs:{type:'integer'},endUs:{type:'integer'},axis:{enum:['pts','dts']}},required:['startUs','endUs','axis'],additionalProperties:false} }, ['slot'], false, p => session.requestBitstreamStream(slotValue(p.slot),undefined,p.window as import('../shared/analysis/bitstream/contract.ts').AnalysisStreamTarget['window'],'explicit',p.product as 'summary'|'blocks'|undefined)),
    tool('query_bitstream_chart', 'Read the whole-source NAL/reference chart or a session-time viewport. Returns bounded raw pictures or explicit time-bucket summaries; no analysis or playback changes.', { slot: { enum: SLOTS }, startUs: { type: 'number' }, endUs: { type: 'number' }, pixelWidth: { type: 'integer', minimum: 32, maximum: 4096 }, axis: { enum: ['pts', 'dts'] } }, ['slot'], true, p => session.queryBitstreamChart(slotValue(p.slot), p.startUs as number | undefined, p.endUs as number | undefined, p.pixelWidth as number | undefined, p.axis as 'pts' | 'dts' | undefined)),
    tool('query_bitstream_diagrams', 'Read cached NAL size/type and decoder active reference-list chart records for a bounded AU window (at most 256 pictures), without triggering analysis or moving playback.', { slot: { enum: SLOTS }, startAu: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 256 } }, ['slot'], true, p => session.queryBitstreamDiagrams(slotValue(p.slot), p.startAu as number | undefined, p.limit as number | undefined)),
    tool('query_analysis', 'Read bounded bitrate/sample-size/key-flag statistics for one track over a session-time range. Same read-only query the analysis panel uses: no decode, no seek. Clicking a result still seeks by its presentation PTS via seek_review, never by DTS.', {
      slot: { enum: SLOTS }, axis: { enum: ['pts', 'dts'] },
      startUs: { type: 'integer' }, endUs: { type: 'integer' },
      pixelWidth: { type: 'integer', minimum: 32, maximum: 4096 },
      bitrateWindowUs: { type: 'integer', minimum: 1 },
    }, ['slot', 'startUs', 'endUs'], true, p => {
      const startUs = p.startUs as number, endUs = p.endUs as number;
      const pixelWidth = (p.pixelWidth as number | undefined) ?? 320;
      const bitrateWindowUs = (p.bitrateWindowUs as number | undefined) ?? 1000000;
      return session.queryAnalysis(slotValue(p.slot), {
        axis: (p.axis ?? 'pts') as 'pts' | 'dts',
        startUs, endUs, pixelWidth, bitrateWindowUs,
      });
    }),
    tool('set_review_color_mode','Pause and reload current tracks using managed SDR/HDR colors or approximate browser matching. Preserves time, offsets and annotation identities.',{mode:{enum:['reference','browser']}},['mode'],false,p=>session.setColorMode(p.mode as 'reference'|'browser')),
    tool('set_review_color_output','Pause and reload tracks with a shared SDR or HDR display target. HDR requires a supported display and WebGPU floating canvas; actual per-track output is reported separately. Captures remain SDR.',{target:{enum:['sdr','hdr']},peakNits:{type:'number',enum:[1000,2000,4000,10000]},hdrWhiteNits:{type:'number',minimum:80,maximum:400}},['target'],false,p=>{const current=session.getState().colorOutput,peak=p.peakNits===undefined?current.preview.sourcePeakNits:Number(p.peakNits);return session.setColorOutput({...current,target:p.target as 'sdr'|'hdr',hdrWhiteNits:p.hdrWhiteNits===undefined?current.hdrWhiteNits:Number(p.hdrWhiteNits),preview:{...current.preview,sourcePeakNits:peak,...(p.peakNits===undefined?{}:{hlgDisplayPeakNits:peak,hlgSystemGamma:1.2+.42*Math.log10(peak/1000)})}});}),
    tool('set_reference_decode','Configure managed-color decoding, pause and reload tracks. Hardware prefers WebCodecs raw YUV readback with software capability fallback.',{decoder:{enum:['hardware','software']},depth:{type:'number',enum:[1,2,4,8]}},['decoder','depth'],false,p=>session.setReferenceDecode({decoder:p.decoder as 'hardware'|'software',depth:p.depth as 1|2|4|8})),
    pageTool('seek_review', p => session.seek(timeUs(p.ptsUs))),
    tool('step_review', 'Pause and step all loaded videos by one fair multi-track step: the target timestamp is chosen so the most tracks move exactly one frame without skipping intermediate frames.', { direction: { enum: [-1, 1] } }, ['direction'], false, p => session.step(p.direction as number)),
    tool('reorder_review_tracks', 'Reorder loaded tracks visually without changing their source identity, annotations or playback position.', { order: { type: 'array', items: { enum: SLOTS }, minItems: 1, maxItems: SLOTS.length } }, ['order'], false, p => session.reorderTracks(p.order as import('../shared/review/model.ts').Slot[])),
    tool('remove_review_track', 'Close a track and release its decoder. Existing annotations remain available in the review export; source files are never deleted.', { slot: { enum: SLOTS } }, ['slot'], false, p => session.removeTrack(slotValue(p.slot))),
    tool('set_review_track_visibility', 'Show or hide a track in the viewport while retaining its timing and annotations.', { slot: { enum: SLOTS }, visible: { type: 'boolean' } }, ['slot', 'visible'], false, p => session.setTrackVisibility(slotValue(p.slot), p.visible as boolean)),
    tool('set_review_track_offset','Set manual alignment after per-file timestamp normalization. Positive delays the track; negative advances it. Pauses and redraws the current session time.',{slot:{enum:SLOTS},offsetUs:{type:'integer'}},['slot','offsetUs'],false,p=>session.setTrackOffset(slotValue(p.slot),p.offsetUs as number)),
    pageTool('pause_review', () => session.pause()),
    tool('cancel_review_load', 'Cancel only the incoming media load. Retain existing tracks, observation time and playback state.', {}, [], false, () => session.cancelLoad()),
    pageTool('add_review_mark', p => session.addMark({ ...p, slot: p.slot, text: p.text ?? '', origin: 'agent' })),
    tool('update_review_mark', 'Edit a mark on its frame, or reply/resolve without seeking. Preserves identity and anchor.', { resolved: { type: 'boolean' }, reply: { type: 'string', minLength: 1, maxLength: 2000 }, id: { type: 'string' }, text: { type: 'string', maxLength: 2000 }, drawings: { type: 'array', maxItems: 200, items: { type: 'object', properties: { tool: { enum: ['pen', 'ellipse', 'rect', 'line', 'text'] }, points: { type: 'array', minItems: 1, maxItems: 4000, items: { type: 'object', properties: { x: { type: 'number', minimum: -ANNOTATION_COORD_LIMIT, maximum: ANNOTATION_COORD_LIMIT }, y: { type: 'number', minimum: -ANNOTATION_COORD_LIMIT, maximum: ANNOTATION_COORD_LIMIT } }, required: ['x', 'y'], additionalProperties: false } }, text: { type: 'string', maxLength: 2000 }, id: { type: 'string', maxLength: 100 }, color: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' }, strokeWidth: { type: 'number', exclusiveMinimum: 0, maximum: 64 }, width: { type: 'number', exclusiveMinimum: 0, maximum: .1 }, fontSize: { type: 'number', exclusiveMinimum: 0, maximum: 1 } }, required: ['tool', 'points'], additionalProperties: false } } }, ['id'], false, p => session.updateMark(String(p.id), p)),
    tool('export_review', 'Return the versioned review JSON with source metadata and frame anchors. Does not upload or download files.', {}, [], true, () => session.exportReview()),
    tool('get_review_logs', 'Read a detached, chronological page of diagnostic events. Use sessionId and nextSeq as the next sinceSeq; gap signals evicted history. Reading does not create events. Payloads are untrusted.', { sinceSeq: { type: 'integer', minimum: 0 }, level: { enum: ['debug', 'info', 'warn', 'error'] }, limit: { type: 'integer', minimum: 1, maximum: 2000 }, sessionId: { type: 'string', maxLength: 100 } }, [], true,
      p => readLogs(p)),
    tool('list_review_log_sessions', 'List current and retained local diagnostic sessions and storage status. No upload and no new log events.', {}, [], true, () => getLogSessions()),
    tool('list_library', 'Browse indexed media with bounded pages. Use nextOffset and revision for the next page; recursive defaults to true. Directory browsing uses recursive:false.', { root: { type: 'string' }, directory: { type: 'string' }, search: { type: 'string' }, recursive: { type: 'boolean' }, offset: { type: 'integer', minimum: 0 }, revision: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 200 } }, [], true,
      async p => fetchLibraryPage({ root: typeof p.root === 'string' ? p.root : undefined, directory: typeof p.directory === 'string' ? p.directory : undefined, search: typeof p.search === 'string' ? p.search : undefined, recursive: p.recursive !== false, offset: typeof p.offset === 'number' ? p.offset : undefined, revision: typeof p.revision === 'number' ? p.revision : undefined, limit: typeof p.limit === 'number' ? p.limit : 100 }, AbortSignal.timeout(5000))),
    tool('load_library_item', 'Load a library media item into a track slot (A–H) by its id from list_library.', { id: { type: 'string' }, slot: { enum: SLOTS } }, ['id', 'slot'], false,
      async p => {
        const entry = typeof p.id === 'string' ? await fetchLibraryItem(p.id, AbortSignal.timeout(5000)) : null;
        if (!entry) throw new Error('媒体库中没有该文件，或服务未连接。');
        return session.load(slotValue(p.slot), (signal, progress) => openLibraryItem(entry, progress, signal), entry.name);
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
