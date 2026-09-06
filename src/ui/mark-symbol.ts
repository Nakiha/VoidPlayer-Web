import { markIdentity } from '../mark-identity.ts';
import { svgElement } from './annotation-svg.ts';

export function markSymbol(id: string) {
  const { color, shape } = markIdentity(id);
  const svg = svgElement('svg', { class: 'mark-symbol', viewBox: '0 0 18 18', 'aria-hidden': 'true' });
  svg.dataset.markShape = shape; svg.style.setProperty('--mark-color', color);
  const attrs = { 'stroke-width': 2, 'vector-effect': 'non-scaling-stroke', 'stroke-linejoin': 'round' };
  svg.append(shape === 'circle' ? svgElement('circle', { ...attrs, cx: 9, cy: 9, r: 6 })
    : shape === 'square' ? svgElement('rect', { ...attrs, x: 3, y: 3, width: 12, height: 12, rx: 1.5 })
    : shape === 'pentagon' ? svgElement('path', { ...attrs, d: 'M9 2 L15.66 6.84 L13.11 14.66 L4.89 14.66 L2.34 6.84 Z' })
    : shape === 'triangle' ? svgElement('path', { ...attrs, d: 'M9 2 L16 15 L2 15 Z' })
    : svgElement('path', { ...attrs, d: 'M9 2 L16 9 L9 16 L2 9 Z' }));
  return svg;
}
export function identifyMark(element: HTMLElement, id: string) {
  element.dataset.markId = id;
  element.style.setProperty('--mark-color', markIdentity(id).color);
}
/** Matching timeline and list entries respond together without changing selection. */
export function bindMarkHover(element: HTMLElement, id: string) {
  const highlight = (active: boolean) => {
    for (const node of document.querySelectorAll<HTMLElement>('[data-mark-id]')) {
      if (node.dataset.markId === id) node.classList.toggle('mark-linked-hover', active);
    }
  };
  element.addEventListener('pointerenter', () => highlight(true));
  element.addEventListener('pointerleave', () => highlight(false));
}
