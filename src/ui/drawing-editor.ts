import { SLOTS, formatTime } from '../model.ts';
import { drawAnnotations, annotationAnchorsCurrent } from '../annotation.ts';
import type { Drawing, Point } from '../annotation.ts';
import type { Slot, Region } from '../model.ts';
import type { ReviewSession } from '../session.ts';

export const annotationThumbnails = new Map<string, { url: string; width: number; height: number }>();
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
type Draft = { mediaId: string; ptsUs: number; drawings: Drawing[] };

/** Draw in the existing, transformed viewports; never replace comparison with a snapshot. */
export function installDrawingEditor(session: ReviewSession, sources: Record<Slot, HTMLCanvasElement>) {
  const bar = $('annotation-toolbar');
  const note = $<HTMLTextAreaElement>('note');
  const input = $<HTMLInputElement>('drawing-text');
  const error = $('drawing-error');
  const drafts = new Map<Slot, Draft>();
  const history: Slot[] = [];
  let active = false, stale = false;
  let selected: Slot = 'A';
  let tool: Drawing['tool'] = 'pen';
  let pending: { slot: Slot; drawing: Drawing; pointer: number } | null = null;
  let textPoint: { slot: Slot; point: Point } | null = null;
  let overlaySignature = '';
  const ink = () => getComputedStyle(bar).getPropertyValue('--annotation-ink').trim();
  const layer = (slot: Slot) => $<HTMLCanvasElement>(`drawing-${slot}`);
  function ensureDraft(slot: Slot) {
    if (drafts.has(slot)) return drafts.get(slot)!;
    const track = session.getState().tracks.find(t => t.slot === slot);
    if (!track?.frame) return null;
    const draft = { mediaId: track.id, ptsUs: track.frame.ptsUs, drawings: [] };
    drafts.set(slot, draft); return draft;
  }
  function redraw(slot?: Slot) {
    for (const current of slot ? [slot] : SLOTS) {
      const canvas = layer(current), ctx = canvas.getContext('2d')!;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const shapes = drafts.get(current)?.drawings ?? [];
      drawAnnotations(ctx, pending?.slot === current ? [...shapes, pending.drawing] : shapes, canvas.width, canvas.height, ink());
    }
    $<HTMLButtonElement>('drawing-undo').disabled = stale || !history.length;
    $<HTMLButtonElement>('add-mark').disabled = stale || (!history.length && !note.value.trim() && !input.value.trim());
  }
  function push(slot: Slot, drawing: Drawing) {
    const draft = ensureDraft(slot);
    if (draft && draft.drawings.length < 200) { draft.drawings.push(drawing); history.push(slot); }
  }
  function commitText() {
    if (textPoint && input.value.trim() && !stale) push(textPoint.slot, { tool: 'text', points: [textPoint.point], text: input.value.trim() });
    input.hidden = true; input.value = ''; textPoint = null; redraw();
  }
  function close() {
    if (pending && layer(pending.slot).hasPointerCapture(pending.pointer)) layer(pending.slot).releasePointerCapture(pending.pointer);
    active = false; stale = false; pending = null; textPoint = null; drafts.clear(); history.length = 0;
    note.value = input.value = ''; input.hidden = true; bar.hidden = true;
    for (const slot of SLOTS) layer(slot).hidden = true;
    document.body.classList.remove('annotating');
  }
  function chooseTool(next: Drawing['tool']) {
    commitText(); tool = next;
    for (const button of document.querySelectorAll<HTMLElement>('[data-drawing-tool]')) button.setAttribute('aria-pressed', String(button.dataset.drawingTool === tool));
  }
  for (const button of document.querySelectorAll<HTMLElement>('[data-drawing-tool]')) button.onclick = () => chooseTool(button.dataset.drawingTool as Drawing['tool']);
  note.oninput = () => redraw(); input.oninput = () => redraw();
  input.onkeydown = e => {
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); commitText(); }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); input.value = ''; commitText(); }
  };
  $('drawing-undo').onclick = () => { commitText(); const slot = history.pop(); if (slot) drafts.get(slot)?.drawings.pop(); redraw(); };
  $('mark-close').onclick = close;
  const life = new AbortController();
  document.addEventListener('keydown', e => {
    if (!active) return;
    if (e.key === 'Escape' && input.hidden) { e.preventDefault(); close(); }
    else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && !(e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement)) { e.preventDefault(); $('drawing-undo').click(); }
  }, { signal: life.signal });
  for (const slot of SLOTS) {
    const canvas = layer(slot);
    const point = (e: PointerEvent): Point => {
      const r = canvas.getBoundingClientRect();
      return { x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)) };
    };
    canvas.onpointerdown = e => {
      if (e.button !== 0 || !active || stale) return;
      e.preventDefault(); e.stopPropagation(); commitText(); selected = slot;
      if ((ensureDraft(slot)?.drawings.length ?? 200) >= 200) return;
      const p = point(e);
      if (tool === 'text') {
        textPoint = { slot, point: p }; input.hidden = false;
        input.style.left = `${Math.max(4, Math.min(e.clientX, innerWidth - 224))}px`;
        input.style.top = `${Math.max(4, Math.min(e.clientY, innerHeight - 36))}px`; input.focus(); return;
      }
      pending = { slot, drawing: { tool, points: tool === 'pen' ? [p] : [p, p] }, pointer: e.pointerId };
      canvas.setPointerCapture(e.pointerId); redraw(slot);
    };
    canvas.onpointermove = e => {
      if (!pending || pending.slot !== slot || pending.pointer !== e.pointerId) return;
      e.stopPropagation();
      if (pending.drawing.tool === 'pen') { if (pending.drawing.points.length < 4000) pending.drawing.points.push(point(e)); }
      else pending.drawing.points[1] = point(e);
      redraw(slot);
    };
    canvas.onpointerup = e => {
      if (!pending || pending.slot !== slot || pending.pointer !== e.pointerId) return;
      e.stopPropagation(); push(slot, pending.drawing); pending = null;
      canvas.releasePointerCapture(e.pointerId); redraw(slot);
    };
    canvas.onpointercancel = () => { pending = null; redraw(slot); };
  }
  $('mark-form').onsubmit = e => {
    e.preventDefault(); commitText(); if (!active || stale) return;
    try {
      const state = session.getState();
      const entries = [...drafts].filter(([,draft]) => draft.drawings.length);
      if (!entries.length && note.value.trim()) { const draft = ensureDraft(selected); if (draft) entries.push([selected, draft]); }
      // Validate all anchors before adding any mark, so a stale multi-view draft cannot partially commit.
      if (!annotationAnchorsCurrent(entries.map(([slot, draft]) => ({slot, ...draft})), state.tracks)) throw new Error('画面已变化，请返回原帧后保存，或取消本次绘制。');
      for (const [slot, draft] of entries) {
        const source = sources[slot], thumb = document.createElement('canvas');
        thumb.width = 320; thumb.height = Math.max(1, Math.round(320 * source.height / source.width));
        const ctx = thumb.getContext('2d')!; ctx.drawImage(source, 0, 0, thumb.width, thumb.height);
        drawAnnotations(ctx, draft.drawings, thumb.width, thumb.height, ink());
        const preview = thumb.toDataURL('image/jpeg', .78);
        const mark = session.addMark({ slot, text: note.value, drawings: draft.drawings });
        annotationThumbnails.set(mark.id, { url: preview, width: thumb.width, height: thumb.height });
        for (const content of document.querySelectorAll<HTMLElement>('[data-mark-content]')) if (content.dataset.markContent === mark.id) {
          const image = document.createElement('img'); image.src = preview; image.alt = '标注画面'; content.append(image);
        }
      }
      close();
    } catch (err) { error.textContent = err instanceof Error ? err.message : String(err); error.hidden = false; }
  };
  return {
    active: () => active,
    dispose: () => { close(); life.abort(); },
    open(slot: Slot, region: Region | null) {
      if (session.getState().busy || active) return;
      session.pause();
      const visible = session.getState().tracks.filter(t => !$(`stage-${t.slot}`).closest<HTMLElement>('.video-card')!.hidden);
      const track = visible.find(t => t.slot === slot) ?? visible[0];
      if (!track?.frame) return;
      active = true; stale = false; selected = track.slot; ensureDraft(track.slot);
      if (region) push(track.slot, { tool: 'rect', points: [{ x: region.left, y: region.top }, { x: region.left + region.width, y: region.top + region.height }] });
      for (const current of SLOTS) {
        const canvas = layer(current), source = sources[current];
        canvas.width = Math.min(1440, source.width); canvas.height = Math.max(1, Math.round(canvas.width * source.height / Math.max(1, source.width)));
        canvas.hidden = !session.getState().tracks.some(t => t.slot === current);
      }
      bar.hidden = false; error.hidden = true; document.body.classList.add('annotating');
      $('mark-frame-label').textContent = formatTime(session.getState().positionUs);
      chooseTool(region ? 'rect' : 'pen');
    },
    render(state: ReturnType<ReviewSession['getState']>) {
      if (active) {
        stale = state.playing || !annotationAnchorsCurrent([...drafts].map(([slot, draft]) => ({slot, ...draft})), state.tracks);
        error.hidden = !stale;
        if (stale) error.textContent = '画面已变化，请返回原帧后保存，或取消本次绘制。';
        for (const slot of SLOTS) layer(slot).hidden = stale || !state.tracks.some(t => t.slot === slot);
        redraw();
      }
      const signature = state.tracks.map(t => `${t.slot}:${t.id}:${t.frame?.ptsUs}`).join('/') + state.marks.map(m => m.id).join('/');
      if (signature === overlaySignature) return;
      overlaySignature = signature;
      for (const id of annotationThumbnails.keys()) if (!state.marks.some(m => m.id === id)) annotationThumbnails.delete(id);
      for (const slot of SLOTS) {
        const overlay = $<HTMLCanvasElement>(`annotations-${slot}`), track = state.tracks.find(t => t.slot === slot);
        const shapes = state.marks.filter(m => m.mediaId === track?.id && m.frame.ptsUs === track?.frame?.ptsUs).flatMap(m => m.drawings ?? []);
        overlay.hidden = !shapes.length; if (!shapes.length) continue;
        overlay.width = Math.min(1440, sources[slot].width); overlay.height = Math.max(1, Math.round(overlay.width * sources[slot].height / sources[slot].width));
        drawAnnotations(overlay.getContext('2d')!, shapes, overlay.width, overlay.height, ink());
      }
    },
  };
}
