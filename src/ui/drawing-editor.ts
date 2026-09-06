import { annotationThumbnails } from './annotation-thumbnails.ts';
import { installColorMenu } from './color-menu.ts';
import { installChoiceMenu, strokePreview } from './choice-menu.ts';
import { SLOTS } from '../model.ts';
import type { Slot } from '../model.ts';
import { DEFAULT_ANNOTATION_COLOR, drawAnnotations, annotationAnchorsCurrent, drawingStrokeWidth } from '../annotation.ts';
import type { Drawing, Point } from '../annotation.ts';
import { drawingBounds, moveDrawing, resizeDrawing, eraseAt } from '../annotation-geometry.ts';
import { renderAnnotations, svgElement, textElement, annotationFrameRect } from './annotation-svg.ts';
import type { ReviewSession } from '../session.ts';


const $ = <T extends Element = HTMLElement>(id: string) => document.getElementById(id) as unknown as T;
type Group = { markId?: string; drawings: Drawing[] };
type Draft = { mediaId: string; ptsUs: number; groups: Group[] };
type Tool = Drawing['tool'] | 'select' | 'eraser';
type Snapshot = [Slot, Draft][];

/** Objects remain editable after every autosave; video pixels are never edited. */
export function installDrawingEditor(session: ReviewSession, sources: Record<Slot, HTMLCanvasElement>) {
  const bar = $('annotation-toolbar'), error = $('drawing-error');
  const life = new AbortController(), drafts = new Map<Slot, Draft>();
  const undo: Snapshot[] = [], redo: Snapshot[] = [];
  let active = false, saving = false, closing = false, tool: Tool = 'pen', selectedSlot: Slot = 'A', selectedId: string | undefined;
  let text: { slot: Slot; drawing: Drawing; div: HTMLDivElement; before: Snapshot } | undefined;
  let gesture: { slot: Slot; pointer: number; start: Point; previous: Point; before: Snapshot; original?: Drawing; mode: 'pending' | 'draw' | 'move' | 'resize' | 'erase'; corner?: string; clickId?: string; drawingTool?: Drawing['tool'] } | undefined;
  let lastTap: { id: string; slot: Slot; time: number; x: number; y: number } | undefined;
  let positioned = false, savedSignature = '', observedMarks = '', viewSignature = '', thumbTimer: ReturnType<typeof setTimeout> | undefined;
  const layer = (slot: Slot) => $<SVGSVGElement>(`drawing-${slot}`);
  const aspect = (slot: Slot) => sources[slot].width / Math.max(1, sources[slot].height);
  const all = (slot: Slot) => drafts.get(slot)?.groups.flatMap(g => g.drawings) ?? [];
  const snapshot = (): Snapshot => structuredClone([...drafts]);
  const find = (slot: Slot, id?: string) => all(slot).find(d => d.id === id);
  const selected = () => find(selectedSlot, selectedId);
  const replace = (slot: Slot, d: Drawing) => { for (const g of drafts.get(slot)?.groups ?? []) g.drawings = g.drawings.map(old => old.id === d.id ? d : old); };
  function history(before: Snapshot) {
    if (JSON.stringify(before) !== JSON.stringify(snapshot())) { undo.push(before); if (undo.length > 80) undo.shift(); redo.length = 0; }
  }
  function ensure(slot: Slot) {
    if (!drafts.has(slot)) {
      const track = session.getState().tracks.find(t => t.slot === slot);
      if (!track?.frame) return null;
      const groups = session.getState().marks.filter(m => m.mediaId === track.id && m.frame.ptsUs === track.frame!.ptsUs).map(mark => {
        const drawings = (mark.drawings ?? []).map(d => ({ ...d, id: d.id ?? crypto.randomUUID() }));
        if (mark.text && !drawings.some(d => d.tool === 'text')) drawings.push({ id: crypto.randomUUID(), tool: 'text', text: mark.text, points: [{ x: .05, y: .05 }] });
        return { markId: mark.id, drawings };
      });
      drafts.set(slot, { mediaId: track.id, ptsUs: track.frame.ptsUs, groups: groups.length ? groups : [{ drawings: [] }] });
    }
    return drafts.get(slot)!;
  }
  function selectionStyle() {
    const d = selected(); if (!d) return;
    $<HTMLInputElement>('drawing-color').value = d.color ?? DEFAULT_ANNOTATION_COLOR;
    const width = annotationFrameRect(layer(selectedSlot)).width;
    $<HTMLInputElement>('drawing-width').value = String(drawingStrokeWidth(d));
    $<HTMLInputElement>('drawing-font').value = String(Math.round((d.fontSize ?? 1 / 42) * width * 10) / 10);
    syncStyleMenus();
  }
  function controls() {
    $<HTMLButtonElement>('drawing-undo').disabled = !undo.length;
    $<HTMLButtonElement>('drawing-redo').disabled = !redo.length;
    $<HTMLButtonElement>('drawing-delete').disabled = !selected();
    for (const button of bar.querySelectorAll<HTMLElement>('[data-drawing-tool]')) button.setAttribute('aria-pressed', String(button.dataset.drawingTool === tool));
  }
  function redraw() {
    for (const slot of SLOTS) {
      const svg = layer(slot); svg.toggleAttribute('hidden', !active || !drafts.has(slot));
      if (text?.slot === slot) continue; // Keep the live DOM and IME selection intact.
      renderAnnotations(svg, all(slot), aspect(slot)); svg.dataset.tool = tool;
      const d = selectedSlot === slot ? selected() : undefined;
      if (d && tool !== 'eraser') {
        const b = drawingBounds(d, aspect(slot)), W = 1000, H = W / aspect(slot), rect = annotationFrameRect(svg);
        const group = svgElement('g', { class: 'annotation-selection' });
        const bounds = { x: b.x * W, y: b.y * H, width: Math.max(.001, b.width) * W, height: Math.max(.001, b.height) * H, fill: 'none', 'stroke-width': 1, 'vector-effect': 'non-scaling-stroke' };
        group.append(svgElement('rect', { ...bounds, stroke: 'var(--annotation-outline-dark)' }));
        group.append(svgElement('rect', { ...bounds, class: 'annotation-selection-dashes', stroke: 'var(--annotation-outline-light)', 'stroke-dasharray': '4 4' }));
        for (const corner of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']) {
          const cx = (b.x + (corner.includes('w') ? 0 : corner.includes('e') ? b.width : b.width / 2)) * W;
          const cy = (b.y + (corner.includes('n') ? 0 : corner.includes('s') ? b.height : b.height / 2)) * H;
          // Hit target and visible ring both stay constant in screen pixels.
          const handle = svgElement('g'); handle.dataset.corner = corner;
          handle.append(svgElement('ellipse', { cx, cy, rx: 9 * W / Math.max(1, rect.width), ry: 9 * H / Math.max(1, rect.height), fill: 'transparent' }));
          handle.append(svgElement('ellipse', { cx, cy, rx: 4.5 * W / Math.max(1, rect.width), ry: 4.5 * H / Math.max(1, rect.height), fill: 'var(--annotation-handle)', stroke: 'var(--annotation-outline-light)', 'stroke-width': 1.5, 'vector-effect': 'non-scaling-stroke' }));
          group.append(handle);
        }
        svg.append(group);
      }
    }
    controls();
  }
  function refreshThumbnails() {
    for (const [slot, draft] of drafts) for (const g of draft.groups) {
      if (!g.markId || !g.drawings.length) continue;
      const source = sources[slot], thumb = document.createElement('canvas'); thumb.width = 320; thumb.height = Math.max(1, Math.round(320 / aspect(slot)));
      const ctx = thumb.getContext('2d')!; ctx.drawImage(source, 0, 0, thumb.width, thumb.height); drawAnnotations(ctx, g.drawings.filter(d => d.tool !== 'text' || d.text?.trim()), thumb.width, thumb.height, DEFAULT_ANNOTATION_COLOR, thumb.width / annotationFrameRect(layer(slot)).width);
      const url = thumb.toDataURL('image/jpeg', .78); annotationThumbnails.set(g.markId, { url, width: thumb.width, height: thumb.height });
      for (const content of document.querySelectorAll<HTMLElement>('[data-mark-content]')) if (content.dataset.markContent === g.markId) {
        let image = content.querySelector('img'); if (!image) { image = document.createElement('img'); image.alt = '标注画面'; content.append(image); } image.src = url;
      }
    }
  }
  function thumbnails() { clearTimeout(thumbTimer); thumbTimer = setTimeout(refreshThumbnails, 180); }
  function persist() {
    if (!active || saving) return;
    saving = true;
    try {
      const state = session.getState();
      if (!annotationAnchorsCurrent([...drafts].map(([slot, d]) => ({ slot, ...d })), state.tracks) || state.playing || state.busy) throw new Error('画面已变化，未将编辑写入其他帧。');
      for (const [slot, draft] of drafts) for (const group of draft.groups) {
        const drawings = group.drawings.filter(d => d.tool !== 'text' || d.text?.trim());
        const exists = session.getState().marks.find(m => m.id === group.markId);
        if (!drawings.length) { if (exists) session.deleteMark(exists.id); group.markId = undefined; continue; }
        const value = { text: drawings.filter(d => d.tool === 'text').map(d => d.text).join('\n').slice(0, 2000), drawings };
        if (exists) { if (JSON.stringify(exists.drawings) !== JSON.stringify(drawings) || exists.text !== value.text) session.updateMark(exists.id, value); }
        else group.markId = session.addMark({ slot, ...value }).id;
      }
      $('drawing-status').textContent = '已记录'; error.hidden = true; thumbnails();
    } catch (e) { error.hidden = false; error.textContent = e instanceof Error ? e.message : String(e); $('drawing-status').textContent = '未记录'; }
    finally { saving = false; }
  }
  function finishText() {
    if (!text) return;
    const editing = text; text = undefined;
    editing.drawing.text = editing.div.innerText.replace(/\r/g, '').slice(0, 2000);
    if (!editing.drawing.text.trim()) for (const g of drafts.get(editing.slot)!.groups) g.drawings = g.drawings.filter(d => d !== editing.drawing);
    history(editing.before); persist(); redraw();
  }
  function startText(slot: Slot, drawing: Drawing, before = snapshot()) {
    finishText(); selectedSlot = slot; selectedId = drawing.id;
    renderAnnotations(layer(slot), all(slot), aspect(slot), drawing.id);
    const { box, div } = textElement(drawing, 1000, 1000 / aspect(slot), true);
    layer(slot).append(box); text = { slot, drawing, div, before };
    div.onpointerdown = e => e.stopPropagation();
    div.oninput = () => { drawing.text = div.innerText.replace(/\r/g, '').slice(0, 2000); if (!div.isConnected) return; persist(); };
    div.onkeydown = e => { e.stopPropagation(); if (e.key === 'Escape' && !e.isComposing) { e.preventDefault(); finishText(); layer(slot).focus(); } };
    div.onpaste = e => { e.preventDefault(); const value = e.clipboardData?.getData('text/plain') ?? ''; document.execCommand('insertText', false, value.slice(0, 2000)); };
    div.focus(); const selection = window.getSelection(); selection?.selectAllChildren(div); selection?.collapseToEnd(); controls();
  }
  function choose(next: Tool) { finishText(); tool = next; redraw(); }
  function close() {
    if (!active || closing) return;
    closing = true; finishText(); clearTimeout(thumbTimer); refreshThumbnails(); active = false; gesture = undefined; drafts.clear(); undo.length = redo.length = 0; selectedId = undefined;
    styleMenus.forEach(menu => menu.sync('', '', false));
    bar.hidden = true; document.body.classList.remove('annotating'); redraw(); savedSignature = ''; render(session.getState()); closing = false;
  }
  function positionBar() {
    if (!active) return;
    const viewport = document.querySelector<HTMLElement>('.viewport-surface')!.getBoundingClientRect();
    const transport = document.querySelector<HTMLElement>('.transport')!.getBoundingClientRect();
    const r = bar.getBoundingClientRect();
    const x = positioned ? r.left - viewport.left : (viewport.width - r.width) / 2;
    const y = positioned ? r.top - viewport.top : transport.top - viewport.top - r.height - 12;
    bar.style.left = `${Math.max(8, Math.min(viewport.width - r.width - 8, x))}px`;
    bar.style.top = `${Math.max(8, Math.min(viewport.height - r.height - 8, y))}px`;
  }
  for (const button of bar.querySelectorAll<HTMLElement>('[data-drawing-tool]')) button.onclick = () => choose(button.dataset.drawingTool as Tool);
  $('mark-close').onclick = close;
  $('drawing-delete').onclick = () => { finishText(); const before = snapshot(); for (const g of drafts.get(selectedSlot)?.groups ?? []) g.drawings = g.drawings.filter(d => d.id !== selectedId); selectedId = undefined; history(before); persist(); redraw(); };
  const restore = (stack: Snapshot[], other: Snapshot[]) => {
    finishText(); const value = stack.pop(); if (!value) return; other.push(snapshot());
    // Mark IDs are assigned by autosave after the history snapshot. Carry the
    // current IDs forward so undoing the first stroke also deletes its mark.
    for (const [slot, draft] of value) draft.groups.forEach((group, i) => { group.markId = drafts.get(slot)?.groups[i]?.markId; });
    drafts.clear(); for (const [slot, draft] of value) drafts.set(slot, draft);
    selectedId = undefined; persist(); redraw();
  };
  $('drawing-undo').onclick = () => restore(undo, redo); $('drawing-redo').onclick = () => restore(redo, undo);
  const styleMenus = [
    installChoiceMenu('drawing-width-choice', [{ value: '1', label: '1 px' }, { value: '2', label: '细 · 2 px' }, { value: '4', label: '中 · 4 px' }, { value: '6', label: '6 px' }, { value: '8', label: '粗 · 8 px' }, { value: '12', label: '12 px' }], value => setStyle('drawing-width', value), undefined, strokePreview),
    installChoiceMenu('drawing-font-choice', [{ value: '18', label: '小 · 18 px' }, { value: '24', label: '中 · 24 px' }, { value: '36', label: '大 · 36 px' }], value => setStyle('drawing-font', value), 'text'),
    installColorMenu('drawing-color-choice', value => setStyle('drawing-color', value)),
  ];
  function setStyle(id: string, value: string) { const input = $<HTMLInputElement>(id); input.value = value; input.dispatchEvent(new Event('change')); syncStyleMenus(); }
  function syncStyleMenus() { styleMenus[0].sync($<HTMLInputElement>('drawing-width').value, '笔画粗细', true); styleMenus[1].sync($<HTMLInputElement>('drawing-font').value, '文字大小', true); styleMenus[2].sync($<HTMLInputElement>('drawing-color').value, '标注颜色', true); }
  syncStyleMenus();
  for (const id of ['drawing-color', 'drawing-width', 'drawing-font']) $<HTMLInputElement>(id).onchange = () => {
    finishText(); const d = selected(); if (!d) return;
    const before = snapshot(), width = annotationFrameRect(layer(selectedSlot)).width;
    if (id === 'drawing-color') d.color = $<HTMLInputElement>(id).value;
    if (id === 'drawing-width') d.strokeWidth = Number($<HTMLInputElement>(id).value);
    if (id === 'drawing-font') d.fontSize = Math.min(1, Number($<HTMLInputElement>(id).value) / width);
    history(before); persist(); redraw();
  };
  for (const slot of SLOTS) {
    const svg = layer(slot);
    const point = (e: PointerEvent): Point => { const r = annotationFrameRect(svg); return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height }; };
    const erase = (from: Point, to: Point) => {
      const r = annotationFrameRect(svg), count = Math.max(1, Math.ceil(Math.hypot((to.x - from.x) * r.width, (to.y - from.y) * r.height) / 6));
      for (let i = 1; i <= count; i++) for (const g of drafts.get(slot)!.groups) {
        const updated = eraseAt(g.drawings, { x: from.x + (to.x - from.x) * i / count, y: from.y + (to.y - from.y) * i / count }, 12, r.width, r.height);
        if (updated.length <= 200) g.drawings = updated;
      }
    };
    function beginDrawing(next: Drawing['tool'], p: Point, before: Snapshot, pointer: number) {
      if (all(slot).length >= 200) return;
      const w = annotationFrameRect(svg).width;
      const drawing: Drawing = { id: crypto.randomUUID(), tool: next, points: next === 'text' || next === 'pen' ? [p] : [p, p], color: $<HTMLInputElement>('drawing-color').value, strokeWidth: Number($<HTMLInputElement>('drawing-width').value), fontSize: Math.min(1, Number($<HTMLInputElement>('drawing-font').value) / w), ...(next === 'text' ? { text: '' } : {}) };
      ensure(slot)!.groups[0].drawings.push(drawing); selectedId = drawing.id;
      if (next === 'text') { startText(slot, drawing, before); return; }
      gesture = { slot, pointer, start: p, previous: p, before, mode: 'draw' };
    }
    svg.onpointerdown = e => {
      if (e.button !== 0 || !active || session.getState().busy) return;
      e.preventDefault(); e.stopPropagation();
      const target = e.target as Element, id = target.closest<SVGElement>('[data-shape-id]')?.dataset.shapeId, corner = target.closest<SVGElement>('[data-corner]')?.dataset.corner;
      finishText(); selectedSlot = slot; ensure(slot); const p = point(e), before = snapshot();
      if (corner && selected()) gesture = { slot, pointer: e.pointerId, start: p, previous: p, before, original: structuredClone(selected()), mode: 'resize', corner };
      else if (tool === 'eraser') { selectedId = undefined; gesture = { slot, pointer: e.pointerId, start: p, previous: p, before, mode: 'erase' }; erase(p, p); }
      else if (id && (tool === 'select' || (tool === 'text' && find(slot, id)?.tool === 'text'))) {
        selectedId = id; selectionStyle();
        const d = selected();
        const second = lastTap?.id === id && lastTap.slot === slot && performance.now() - lastTap.time < 450 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 6;
        lastTap = { id, slot, time: performance.now(), x: e.clientX, y: e.clientY };
        if (second && d?.tool === 'text') { gesture = undefined; lastTap = undefined; startText(slot, d); return; }
        gesture = { slot, pointer: e.pointerId, start: p, previous: p, before, original: structuredClone(selected()), mode: 'move' };
      } else if (tool === 'select') selectedId = undefined;
      else {
        if (id) gesture = { slot, pointer: e.pointerId, start: p, previous: p, before, mode: 'pending', clickId: id, drawingTool: tool };
        else { beginDrawing(tool, p, before, e.pointerId); if (text) return; }
      }
      if (gesture) svg.setPointerCapture(e.pointerId); svg.focus(); redraw();
    };
    svg.onpointermove = e => {
      if (!gesture || gesture.slot !== slot || gesture.pointer !== e.pointerId) return;
      e.stopPropagation(); const p = point(e);
      if (gesture.mode === 'pending') {
        const r = annotationFrameRect(svg);
        if (Math.hypot((p.x - gesture.start.x) * r.width, (p.y - gesture.start.y) * r.height) < 3) return;
        // Decide once from travel distance: a drag keeps the drawing tool,
        // even if the pointer later returns to its starting position.
        const pending = gesture; gesture = undefined;
        beginDrawing(pending.drawingTool!, pending.start, pending.before, pending.pointer);
        if (!gesture) return;
      }
      const d = selected();
      if (gesture.mode === 'erase') erase(gesture.previous, p);
      else if (gesture.mode === 'move' && gesture.original) replace(slot, moveDrawing(gesture.original, p.x - gesture.start.x, p.y - gesture.start.y));
      else if (gesture.mode === 'resize' && gesture.original) {
        const old = drawingBounds(gesture.original, aspect(slot)), c = gesture.corner!;
        const ax = c.includes('w') ? old.x + old.width : old.x, ay = c.includes('n') ? old.y + old.height : old.y;
        const box = { ...old };
        if (/[we]/.test(c)) { box.x = Math.min(ax, p.x); box.width = Math.abs(p.x - ax); }
        if (/[ns]/.test(c)) { box.y = Math.min(ay, p.y); box.height = Math.abs(p.y - ay); }
        if (gesture.original.tool === 'text' && !/[we]/.test(c)) box.width = old.width * box.height / Math.max(.001, old.height);
        replace(slot, resizeDrawing(gesture.original, box, aspect(slot)));
      } else if (d) { if (d.tool === 'pen') { if (d.points.length < 4000) d.points.push(p); } else d.points[1] = p; }
      gesture.previous = p; redraw();
    };
    svg.onpointerup = e => {
      if (!gesture || gesture.slot !== slot || gesture.pointer !== e.pointerId) return;
      e.stopPropagation();
      if (gesture.mode === 'pending') {
        selectedId = gesture.clickId; tool = 'select'; selectionStyle();
        lastTap = { id: selectedId!, slot, time: performance.now(), x: e.clientX, y: e.clientY };
        gesture = undefined; svg.releasePointerCapture(e.pointerId); redraw(); return;
      }
      const d = selected(), r = annotationFrameRect(svg);
      if (gesture.mode === 'draw' && d && d.tool !== 'pen' && d.tool !== 'text' && Math.hypot((d.points[1].x-d.points[0].x)*r.width, (d.points[1].y-d.points[0].y)*r.height) < 3) {
        for (const group of drafts.get(slot)!.groups) group.drawings = group.drawings.filter(shape => shape !== d);
        selectedId = undefined;
      }
      history(gesture.before); gesture = undefined; svg.releasePointerCapture(e.pointerId); persist(); redraw();
    };
    svg.onpointercancel = () => { if (!gesture) return; drafts.clear(); for (const [s, draft] of gesture.before) drafts.set(s, draft); gesture = undefined; redraw(); };
    svg.ondblclick = e => { e.preventDefault(); e.stopPropagation(); const id = (e.target as Element).closest<SVGElement>('[data-shape-id]')?.dataset.shapeId; const d = find(slot, id); if (d?.tool === 'text') startText(slot, d); };
  }
  const grip = $('drawing-grip');
  grip.onpointerdown = e => {
    const left = parseFloat(bar.style.left), top = parseFloat(bar.style.top), x = e.clientX, y = e.clientY; grip.setPointerCapture(e.pointerId); positioned = true;
    grip.onpointermove = event => { bar.style.left = `${left + event.clientX - x}px`; bar.style.top = `${top + event.clientY - y}px`; positionBar(); };
    grip.onpointerup = event => { grip.releasePointerCapture(event.pointerId); grip.onpointermove = null; };
  };
  window.addEventListener('resize', () => { positionBar(); if (active && !text) redraw(); }, { signal: life.signal });
  document.addEventListener('keydown', e => {
    if (!active || (e.target as Element)?.closest?.('[popover]:popover-open') || e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || (e.target as HTMLElement)?.isContentEditable) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); close(); }
    else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); (e.shiftKey ? $('drawing-redo') : $('drawing-undo')).click(); }
    else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); $('drawing-delete').click(); }
    else if (!e.metaKey && !e.ctrlKey && !e.altKey) { const next = ({ v: 'select', p: 'pen', r: 'rect', o: 'ellipse', l: 'line', t: 'text', e: 'eraser' } as Record<string, Tool>)[e.key.toLowerCase()]; if (next) { e.preventDefault(); choose(next); } }
  }, { capture: true, signal: life.signal });
  function render(state: ReturnType<ReviewSession['getState']>) {
    if (active && !saving && !closing && (state.playing || !annotationAnchorsCurrent([...drafts].map(([slot, d]) => ({ slot, ...d })), state.tracks))) { close(); }
    const marksSignature = JSON.stringify(state.marks);
    if (active && !saving && !closing && observedMarks && marksSignature !== observedMarks) {
      // A panel or Agent edit is authoritative; stale draft objects must not
      // recreate a deleted mark or overwrite an external update on the next gesture.
      text = undefined; gesture = undefined; drafts.clear(); undo.length = redo.length = 0; selectedId = undefined;
      for (const track of state.tracks) ensure(track.slot);
      redraw();
    }
    observedMarks = marksSignature;
    const signature = JSON.stringify([state.tracks.map(t => [t.slot, t.id, t.frame?.ptsUs]), state.marks]);
    if (signature !== savedSignature) {
      savedSignature = signature;
      for (const id of annotationThumbnails.keys()) if (!state.marks.some(m => m.id === id)) annotationThumbnails.delete(id);
      for (const slot of SLOTS) {
        const svg = $<SVGSVGElement>(`annotations-${slot}`), track = state.tracks.find(t => t.slot === slot);
        const shapes = state.marks.filter(m => m.mediaId === track?.id && m.frame.ptsUs === track?.frame?.ptsUs).flatMap(m => m.drawings ?? []);
        renderAnnotations(svg, shapes, aspect(slot)); svg.toggleAttribute('hidden', active || !shapes.length);
      }
    }
    if (!active) return;
    for (const slot of SLOTS) $<SVGSVGElement>(`annotations-${slot}`).setAttribute('hidden', '');
  }
  return {
    active: () => active,
    beginRectangle(slot: Slot, event: PointerEvent, current: PointerEvent) {
      this.open(slot); choose('rect');
      layer(slot).onpointerdown?.call(layer(slot), event);
      layer(slot).onpointermove?.call(layer(slot), current);
    },
    viewChanged() {
      if (!active) return;
      const signature = SLOTS.map(slot => { const r = annotationFrameRect(layer(slot)); return `${r.width}:${r.height}`; }).join('/');
      if (signature !== viewSignature) { viewSignature = signature; redraw(); }
      positionBar();
    },
    render,
    dispose() { close(); clearTimeout(thumbTimer); life.abort(); styleMenus.forEach(menu => menu.dispose()); },
    open(slot: Slot, markId?: string) {
      if (session.getState().busy) return;
      if (active) close(); session.pause();
      const state = session.getState(); if (!state.tracks.some(t => t.slot === slot && t.frame)) return;
      for (const track of state.tracks) ensure(track.slot);
      $<HTMLInputElement>('drawing-color').value = DEFAULT_ANNOTATION_COLOR;
      active = true; syncStyleMenus(); selectedSlot = slot; selectedId = undefined; positioned = false; bar.hidden = false; error.hidden = true; document.body.classList.add('annotating');
      if (markId) selectedId = drafts.get(slot)?.groups.find(g => g.markId === markId)?.drawings[0]?.id;
      tool = all(slot).length ? 'select' : 'pen'; selectionStyle(); redraw(); savedSignature = ''; render(session.getState()); positionBar();
    },
  };
}
