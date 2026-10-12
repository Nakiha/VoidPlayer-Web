/** Local appearance preference; independent of analysis tasks and workspace data. */
export type ChartHoverStyle = 'separate' | 'combined';
const KEY = 'voidplayer.chart-hover-style';
export const CHART_HOVER_STYLE_EVENT = 'chart-hover-style-change';
let current: ChartHoverStyle | undefined;
export function chartHoverStyle(): ChartHoverStyle {
  if (current) return current;
  try { current = localStorage.getItem(KEY) === 'combined' ? 'combined' : 'separate'; }
  catch { current = 'separate'; }
  return current;
}
export function setChartHoverStyle(style: ChartHoverStyle) {
  current = style;
  try { localStorage.setItem(KEY, style); } catch { /* Remains usable without storage. */ }
  window.dispatchEvent(new Event(CHART_HOVER_STYLE_EVENT));
}
window.addEventListener('storage', event => {
  if (event.key !== KEY && event.key !== null) return;
  current = undefined;
  window.dispatchEvent(new Event(CHART_HOVER_STYLE_EVENT));
});
