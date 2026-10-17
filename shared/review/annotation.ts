export const DEFAULT_ANNOTATION_COLOR = '#ff3b30';
export type Point = { x: number; y: number };
export type Drawing = { tool: 'pen' | 'ellipse' | 'rect' | 'line' | 'text'; points: Point[]; text?: string; id?: string; color?: string; strokeWidth?: number; width?: number; fontSize?: number };

/** Drawing positions are relative to the source frame and may extend into the
 * surrounding workspace. Stroke width is a CSS-pixel style, not video geometry.
 * Legacy normalized widths lacked their creation scale; display them at 4 px. */
export const ANNOTATION_COORD_LIMIT = 10000;
export const drawingStrokeWidth = (drawing: Drawing) => drawing.strokeWidth ?? 4;

export function drawingsValue(value: unknown): Drawing[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 200) throw new Error('画笔内容过多。');
  return value.map(d => {
    if (!d || !['pen', 'ellipse', 'rect', 'line', 'text'].includes(d.tool) || !Array.isArray(d.points) ||
      d.points.length < 1 || d.points.length > 4000 ||
      d.points.some((p: Point) => !p || ![p.x, p.y].every(n => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= ANNOTATION_COORD_LIMIT)) ||
      (d.tool === 'text' ? typeof d.text !== 'string' || !d.text.trim() || d.text.length > 2000 : d.tool !== 'pen' && d.points.length !== 2)) throw new Error('画笔内容无效。');
    if ((d.id !== undefined && (typeof d.id !== 'string' || d.id.length > 100)) ||
      (d.color !== undefined && !/^#[0-9a-f]{6}$/i.test(d.color)) ||
      (d.strokeWidth !== undefined && (!Number.isFinite(d.strokeWidth) || d.strokeWidth <= 0 || d.strokeWidth > 64)) ||
      (d.width !== undefined && (!Number.isFinite(d.width) || d.width <= 0 || d.width > .1)) ||
      (d.fontSize !== undefined && (!Number.isFinite(d.fontSize) || d.fontSize <= 0 || d.fontSize > 1))) throw new Error('画笔样式无效。');
    return { ...(d.id ? { id: d.id } : {}), ...(d.color ? { color: d.color } : {}), ...(d.strokeWidth ? { strokeWidth: d.strokeWidth } : {}), ...(d.width ? { width: d.width } : {}), ...(d.fontSize ? { fontSize: d.fontSize } : {}), tool: d.tool, points: d.points.map((p: Point) => ({ x: p.x, y: p.y })), ...(d.tool === 'text' ? { text: d.text } : {}) };
  });
}


export type AnnotationAnchor = { slot: string; mediaId: string; ptsUs: number };
/** Validate the whole drawing batch before any target is committed. */
export function annotationAnchorsCurrent(anchors: AnnotationAnchor[], tracks: { slot: string; id: string; frame: { ptsUs: number } | null }[]) {
  return anchors.every(anchor => tracks.some(track => track.slot === anchor.slot && track.id === anchor.mediaId && track.frame?.ptsUs === anchor.ptsUs));
}
