import type { AnalysisDiagram } from '../../../shared/analysis/metadata/types.ts';

// Dedicated chart symbols share a 24px grid and the toolbar's theme color.
const shapes: Record<AnalysisDiagram, string> = {
  bitrate: '<path d="M3 4v16h18M5 15l4-5 4 3 3-7 4 2"/>',
  size: '<path d="M3 20h18"/><path d="M5 19V12h3v7m3 0V5h3v14m3 0V9h3v10"/>',
  'nalu-size': '<path d="M3 20h18"/><path fill="currentColor" fill-opacity=".12" d="M5 19V9h3v10m3 0V4h3v15m3 0V12h3v7"/><path d="M5 14h3m3-6h3m3 8h3"/>',
  'nalu-types': '<path d="M8 6h13M8 12h13M8 18h13" opacity=".3"/><path d="M9 6h4m3 6h4m-9 6h5" stroke-width="3"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>',
  references: '<path d="M5 18l7-12 7 12M5 18h14M8.5 12h7" opacity=".55"/><g fill="currentColor" stroke="none"><circle cx="5" cy="18" r="2.2"/><circle cx="12" cy="6" r="2.2"/><circle cx="19" cy="18" r="2.2"/><circle cx="8.5" cy="12" r="1.8"/><circle cx="15.5" cy="12" r="1.8"/></g>',
};

export function analysisDiagramIcon(diagram: AnalysisDiagram): string {
  return `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${shapes[diagram]}</svg>`;
}
