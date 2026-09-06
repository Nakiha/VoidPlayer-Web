export type Point = { x: number; y: number };
export type Drawing = { tool: 'pen' | 'ellipse' | 'rect' | 'line' | 'text'; points: Point[]; text?: string };

export function drawingsValue(value: unknown): Drawing[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 200) throw new Error('画笔内容过多。');
  return value.map(d => {
    if (!d || !['pen', 'ellipse', 'rect', 'line', 'text'].includes(d.tool) || !Array.isArray(d.points) ||
      d.points.length < 1 || d.points.length > 4000 ||
      d.points.some((p: Point) => !p || ![p.x, p.y].every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1)) ||
      (d.tool === 'text' ? typeof d.text !== 'string' || !d.text.trim() || d.text.length > 2000 : d.tool !== 'pen' && d.points.length !== 2)) throw new Error('画笔内容无效。');
    return { tool: d.tool, points: d.points.map((p: Point) => ({ x: p.x, y: p.y })), ...(d.tool === 'text' ? { text: d.text } : {}) };
  });
}

export function drawAnnotations(ctx: CanvasRenderingContext2D, drawings: Drawing[], width: number, height: number, ink: string) {
  ctx.save(); ctx.strokeStyle = ctx.fillStyle = ink;
  ctx.lineWidth = Math.max(2, width / 400); ctx.lineCap = ctx.lineJoin = 'round';
  ctx.font = `500 ${Math.max(14, width / 42)}px system-ui`; ctx.textBaseline = 'top';
  for (const d of drawings) {
    const start = d.points[0], end = d.points.at(-1)!;
    const x = start.x * width, y = start.y * height;
    ctx.beginPath();
    if (d.tool === 'text') ctx.fillText(d.text!, x, y, Math.max(1, width - x));
    else if (d.tool === 'rect') ctx.strokeRect(x, y, (end.x - start.x) * width, (end.y - start.y) * height);
    else if (d.tool === 'ellipse') { ctx.ellipse((start.x + end.x) * width / 2, (start.y + end.y) * height / 2, Math.abs(end.x - start.x) * width / 2, Math.abs(end.y - start.y) * height / 2, 0, 0, Math.PI * 2); ctx.stroke(); }
    else { ctx.moveTo(x, y); for (const p of d.points.slice(1)) ctx.lineTo(p.x * width, p.y * height); if (d.points.length === 1) ctx.lineTo(x + .1, y); ctx.stroke(); }
  }
  ctx.restore();
}

export type AnnotationAnchor = { slot: string; mediaId: string; ptsUs: number };
/** Validate the whole drawing batch before any target is committed. */
export function annotationAnchorsCurrent(anchors: AnnotationAnchor[], tracks: { slot: string; id: string; frame: { ptsUs: number } | null }[]) {
  return anchors.every(anchor => tracks.some(track => track.slot === anchor.slot && track.id === anchor.mediaId && track.frame?.ptsUs === anchor.ptsUs));
}
