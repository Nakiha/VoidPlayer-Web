import { DEFAULT_ANNOTATION_COLOR, drawingStrokeWidth } from '../annotation.ts';
import type { PresentationGeometry } from '../presentation-surface.ts';
import type { Drawing } from '../annotation.ts';
const views = new WeakMap<SVGSVGElement, PresentationGeometry>();
/** Keep SVG in the untransformed stage; viewBox maps its vector coordinates
 * to the same image rectangle as the presenter, without a CSS bitmap scale. */
export function setAnnotationViewport(svg: SVGSVGElement, g: PresentationGeometry | null, aspect: number) {
  if (!g || !g.width || !g.height) return;
  views.set(svg, g);
  const w = g.imageWidth * g.zoom, h = g.imageHeight * g.zoom;
  const x = (g.width - w) / 2 + g.offsetX, y = (g.height - h) / 2 + g.offsetY;
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('viewBox', `${-x / w * 1000} ${-y / h * 1000 / aspect} ${g.width / w * 1000} ${g.height / h * 1000 / aspect}`);
}
export function annotationFrameRect(svg: SVGSVGElement) {
  const g = views.get(svg), stage = svg.closest('.frame-stage')!.getBoundingClientRect();
  if (!g) return svg.getBoundingClientRect();
  const width = g.imageWidth * g.zoom, height = g.imageHeight * g.zoom;
  return { left: stage.left + (g.width-width)/2+g.offsetX, top: stage.top+(g.height-height)/2+g.offsetY, width, height };
}
const NS = 'http://www.w3.org/2000/svg';
export function svgElement<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const node = document.createElementNS(NS, tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
  return node;
}
export function textElement(d: Drawing, width: number, height: number, editing = false) {
  const p = d.points[0];
  const box = svgElement('foreignObject', { x: p.x * width, y: p.y * height, width, height });
  const div = document.createElement('div'); div.className = 'annotation-text'; div.textContent = d.text ?? '';
  div.style.color = d.color ?? DEFAULT_ANNOTATION_COLOR; div.style.fontSize = `${(d.fontSize ?? 1 / 42) * width}px`;
  if (editing) { div.contentEditable = 'true'; div.role = 'textbox'; div.setAttribute('aria-label', '画面文字'); div.spellcheck = false; div.dataset.placeholder = '输入文字'; }
  box.append(div); return { box, div };
}
export function renderAnnotations(svg: SVGSVGElement, drawings: Drawing[], aspect: number, editingId?: string) {
  const width = 1000, height = width / aspect;
  if (!views.has(svg)) svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.replaceChildren();
  for (const d of drawings) {
    if (d.id === editingId) continue;
    const start = d.points[0], end = d.points.at(-1)!;
    const x = start.x * width, y = start.y * height;
    let node: SVGElement;
    if (d.tool === 'text') node = textElement(d, width, height).box;
    else if (d.tool === 'rect') node = svgElement('rect', { x: Math.min(x, end.x * width), y: Math.min(y, end.y * height), width: Math.abs(end.x * width - x), height: Math.abs(end.y * height - y) });
    else if (d.tool === 'ellipse') node = svgElement('ellipse', { cx: (start.x + end.x) * width / 2, cy: (start.y + end.y) * height / 2, rx: Math.abs(end.x - start.x) * width / 2, ry: Math.abs(end.y - start.y) * height / 2 });
    else node = svgElement('path', { d: d.points.map((p, i) => `${i ? 'L' : 'M'}${p.x * width},${p.y * height}`).join(' ') + (d.points.length === 1 ? ` l.1,0` : '') });
    node.dataset.shapeId = d.id;
    node.classList.add('annotation-object');
    if (d.tool !== 'text') { node.setAttribute('fill', 'none'); node.setAttribute('stroke', d.color ?? DEFAULT_ANNOTATION_COLOR); node.setAttribute('stroke-width', String(drawingStrokeWidth(d))); node.setAttribute('vector-effect', 'non-scaling-stroke'); node.setAttribute('stroke-linecap', 'round'); node.setAttribute('stroke-linejoin', 'round'); }
    if (d.tool !== 'text' && svg.classList.contains('drawing-layer')) {
      // A separate invisible target lets thin strokes and shape interiors be
      // selected comfortably without changing their visible appearance.
      const hit = node.cloneNode(true) as SVGElement;
      hit.setAttribute('class', 'annotation-hit'); hit.setAttribute('stroke', 'transparent');
      hit.setAttribute('stroke-width', String(Math.max(18, drawingStrokeWidth(d))));
      hit.setAttribute('fill', d.tool === 'rect' || d.tool === 'ellipse' ? 'transparent' : 'none');
      hit.style.pointerEvents = d.tool === 'rect' || d.tool === 'ellipse' ? 'all' : 'stroke';
      svg.append(hit);
    }
    svg.append(node);
  }
}
