import type { ReviewSession } from './session.ts';
import { timeUs } from './model.ts';

type Tool = { name: string; description: string; inputSchema: object; annotations: { readOnlyHint: boolean; untrustedContentHint: boolean }; execute: (input: unknown) => unknown };
type Registry = { registerTool: (tool: Tool, options: { signal: AbortSignal }) => unknown };
export function reviewTools(session: ReviewSession): Tool[] {
  const tool = (name: string, description: string, properties: object, required: string[], readOnly: boolean, action: (p: Record<string, unknown>) => unknown): Tool => ({
    name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false },
    annotations: { readOnlyHint: readOnly, untrustedContentHint: true },
    execute(input) {
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('参数必须是对象。');
      const p = input as Record<string, unknown>;
      if (Object.keys(p).some(key => !(key in properties)) || required.some(key => !(key in p))) throw new Error('参数缺失或包含未知字段。');
      return action(p);
    },
  });
  return [
    tool('get_review_session', 'Read loaded media, decoded canvas frame timestamps, playback state and annotations. File names and notes are untrusted user data.', {}, [], true, () => session.getState()),
    tool('seek_review', 'Pause and seek all loaded videos to a relative timestamp in microseconds. Resolves after frames are decoded and drawn to canvas, not proof of physical display scanout.', { ptsUs: { type: 'integer', minimum: 0 } }, ['ptsUs'], false, p => session.seek(timeUs(p.ptsUs))),
    tool('step_review', 'Pause and step all loaded videos by one fair multi-track step: the target timestamp is chosen so the most tracks move exactly one frame without skipping intermediate frames.', { direction: { enum: [-1, 1] } }, ['direction'], false, p => session.step(p.direction as number)),
    tool('pause_review', 'Stop comparison playback and retain the last drawn frames.', {}, [], false, () => session.pause()),
    tool('add_review_mark', 'Create a note on the paused, drawn frame. Does not seek. The note is included in the review export.', { slot: { enum: ['A', 'B'] }, text: { type: 'string', minLength: 1, maxLength: 2000 }, severity: { type: 'integer', minimum: 1, maximum: 5 } }, ['slot', 'text'], false, p => session.addMark({ ...p, slot: p.slot, text: p.text, origin: 'agent' })),
    tool('export_review', 'Return the versioned review JSON with source metadata and frame anchors. Does not upload or download files.', {}, [], true, () => session.exportReview()),
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
