import {drawingStrokeWidth} from '../../../shared/review/annotation.ts';
import type {Drawing} from '../../../shared/review/annotation.ts';
export function drawAnnotations(ctx: CanvasRenderingContext2D, drawings: Drawing[], width: number, height: number, ink: string, screenScale = 1) {
  ctx.save(); ctx.strokeStyle = ctx.fillStyle = ink;
  ctx.lineWidth = Math.max(2, width / 400); ctx.lineCap = ctx.lineJoin = 'round';
  ctx.font = `500 ${Math.max(14, width / 42)}px system-ui`; ctx.textBaseline = 'top';
  for (const d of drawings) {
    ctx.strokeStyle = ctx.fillStyle = d.color ?? ink;
    ctx.lineWidth = drawingStrokeWidth(d) * screenScale;
    ctx.font = `500 ${d.fontSize ? d.fontSize * width : Math.max(14, width / 42)}px system-ui`;
    const start = d.points[0], end = d.points.at(-1)!;
    const x = start.x * width, y = start.y * height;
    ctx.beginPath();
    if (d.tool === 'text') d.text!.split('\n').forEach((line, i) => ctx.fillText(line, x, y + i * (d.fontSize ?? 1 / 42) * width * 1.2));
    else if (d.tool === 'rect') ctx.strokeRect(x, y, (end.x - start.x) * width, (end.y - start.y) * height);
    else if (d.tool === 'ellipse') { ctx.ellipse((start.x + end.x) * width / 2, (start.y + end.y) * height / 2, Math.abs(end.x - start.x) * width / 2, Math.abs(end.y - start.y) * height / 2, 0, 0, Math.PI * 2); ctx.stroke(); }
    else { ctx.moveTo(x, y); for (const p of d.points.slice(1)) ctx.lineTo(p.x * width, p.y * height); if (d.points.length === 1) ctx.lineTo(x + .1, y); ctx.stroke(); }
  }
  ctx.restore();
}
