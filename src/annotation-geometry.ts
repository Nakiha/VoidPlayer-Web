import type { Drawing, Point } from './annotation.ts';
export type Bounds = { x: number; y: number; width: number; height: number };

export function drawingBounds(d: Drawing, aspect = 1): Bounds {
  const xs = d.points.map(p => p.x), ys = d.points.map(p => p.y);
  if (d.tool === 'text') {
    const size = d.fontSize ?? 1 / 42, lines = d.text!.split('\n');
    return { x: xs[0], y: ys[0], width: Math.max(size, ...lines.map(line => [...line].reduce((n, c) => n + (/[^\x00-\xff]/.test(c) ? 1 : .62), 0) * size)), height: lines.length * size * 1.2 * aspect };
  }
  return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
}
export function moveDrawing(d: Drawing, dx: number, dy: number): Drawing {
  return { ...d, points: d.points.map(p => ({ x: p.x + dx, y: p.y + dy })) };
}
export function resizeDrawing(d: Drawing, box: Bounds, aspect = 1): Drawing {
  const old = drawingBounds(d, aspect);
  return { ...d, ...(d.tool === 'text' ? { fontSize: Math.min(1, (d.fontSize ?? 1 / 42) * Math.max(.01, box.width) / Math.max(.001, old.width)) } : {}), points: d.points.map(p => ({ x: box.x + (p.x - old.x) / Math.max(.00001, old.width) * box.width, y: box.y + (p.y - old.y) / Math.max(.00001, old.height) * box.height })) };
}

/** Split vector strokes at exact circle/segment intersections. The eraser
 * removes ink, never pixels from the underlying video. */
export function eraseAt(drawings: Drawing[], point: Point, radius: number, width: number, height: number): Drawing[] {
  const result: Drawing[] = [];
  const inside = (p: Point) => Math.hypot((p.x - point.x) * width, (p.y - point.y) * height) < radius;
  for (const d of drawings) {
    if (d.tool !== 'pen') {
      const b = drawingBounds(d, width / height);
      const x = Math.max(b.x, Math.min(point.x, b.x + b.width)), y = Math.max(b.y, Math.min(point.y, b.y + b.height));
      if (Math.hypot((x - point.x) * width, (y - point.y) * height) >= radius) result.push(d);
      continue;
    }
    if (d.points.length === 1) { if (!inside(d.points[0])) result.push(d); continue; }
    const runs: Point[][] = []; let run: Point[] = inside(d.points[0]) ? [] : [d.points[0]], changed = false;
    for (let i = 1; i < d.points.length; i++) {
      const a = d.points[i - 1], b = d.points[i];
      const dx = (b.x - a.x) * width, dy = (b.y - a.y) * height, px = (a.x - point.x) * width, py = (a.y - point.y) * height;
      const A = dx * dx + dy * dy, B = 2 * (dx * px + dy * py), C = px * px + py * py - radius * radius;
      const discriminant = B * B - 4 * A * C;
      const enter = A && discriminant > 0 ? Math.max(0, (-B - Math.sqrt(discriminant)) / (2 * A)) : 1;
      const leave = A && discriminant > 0 ? Math.min(1, (-B + Math.sqrt(discriminant)) / (2 * A)) : 0;
      const at = (t: number) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      if (enter < leave) {
        changed = true;
        if (enter > 0) run.push(at(enter));
        if (run.length) runs.push(run); run = [];
        if (leave < 1) run = [at(leave), b];
      } else if (!inside(b)) run.push(b); else { changed = true; if (run.length) runs.push(run); run = []; }
    }
    if (run.length) runs.push(run);
    if (!changed) result.push(d);
    else result.push(...runs.filter(r => r.length > 1).map(points => ({ ...d, id: crypto.randomUUID(), points })));
  }
  return result;
}
