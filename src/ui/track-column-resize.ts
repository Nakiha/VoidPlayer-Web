import { installResizeGesture } from './resize-gesture.ts';

/** Header and every row share one column width; resizing does not rebuild tracks. */
export function installTrackColumnResize(container: HTMLElement, handle: HTMLElement, signal: AbortSignal) {
  const token = (name: string) => Number.parseFloat(getComputedStyle(container).getPropertyValue(name));
  let preferred: number | undefined;
  const bounds = () => {
    const available = Math.max(0, container.clientWidth - token('--offset-column-width') - token('--button-size') - 2 * token('--tool-inset') - token('--timeline-column-gap'));
    const max = Math.max(32, available - Math.min(160, available / 2));
    return { min: Math.min(96, max), max };
  };
  function refresh() {
    const { min, max } = bounds();
    const width = Math.max(min, Math.min(max, preferred ?? token('--track-label-width')));
    container.style.setProperty('--track-label-size', `${width}px`);
    handle.setAttribute('aria-valuemin', String(Math.round(min)));
    handle.setAttribute('aria-valuemax', String(Math.round(max)));
    handle.setAttribute('aria-valuenow', String(Math.round(width)));
    handle.setAttribute('aria-valuetext', `${Math.round(width)} 像素`);
  }
  installResizeGesture(handle, {
    axis: 'x', direction: 1, size: () => token('--track-label-size'), bounds,
    resize(value) { preferred = value; refresh(); }, reset: () => token('--track-label-width'),
    threshold: () => Infinity, dragging() {}, preview() {}, collapse() {},
  }, signal);
  const observer = new ResizeObserver(refresh); observer.observe(container);
  window.addEventListener('resize', refresh, { signal });
  signal.addEventListener('abort', () => observer.disconnect(), { once: true });
  refresh();
  return { width: () => Math.round(token('--track-label-size')), resize(value: number) { preferred = value; refresh(); } };
}
