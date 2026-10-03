import { t, msg, onLanguageChange } from '../i18n.ts';
import { installResizeGesture } from './resize-gesture.ts';

/** Header and every row share one column width; resizing does not rebuild tracks. */
export function installTrackColumnResize(container: HTMLElement, handle: HTMLElement, signal: AbortSignal) {
  const token = (name: string) => Number.parseFloat(getComputedStyle(container).getPropertyValue(name));
  let preferred: number | undefined;
  const bounds = () => {
    // 行内边距必须与 .subtrack-row / .subtrack-columns 使用同一个 token：少算像素时，
    // 最大列宽会吃掉时间轴本应保留的空间（对应 check-timeline-browser 的
    // 「splitter leaves timeline space」断言）。
    const available = Math.max(0, container.clientWidth - token('--offset-column-width') - token('--button-size') - 2 * token('--track-row-padding-inline') - token('--timeline-column-gap'));
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
    handle.setAttribute('aria-valuetext', t(msg('ui.pixelWidth','{width} 像素'),{width:Math.round(width)}));
  }
  installResizeGesture(handle, {
    axis: 'x', direction: 1, size: () => token('--track-label-size'), bounds,
    resize(value) { preferred = value; refresh(); }, reset: () => token('--track-label-width'),
    threshold: () => Infinity, dragging() {}, preview() {}, collapse() {},
  }, signal);
  const observer = new ResizeObserver(refresh); observer.observe(container);
  window.addEventListener('resize', refresh, { signal });
  onLanguageChange(refresh, signal);
  signal.addEventListener('abort', () => observer.disconnect(), { once: true });
  refresh();
  return { width: () => Math.round(token('--track-label-size')), resize(value: number) { preferred = value; refresh(); } };
}
