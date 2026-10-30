import { t, msg } from '../i18n.ts';
import { formatTime } from '../../shared/review/model.ts';
import { annotationThumbnails } from './annotation-thumbnails.ts';

export type TimeMark = { id: string; text: string; frame: { ptsUs: number } };
/** A screen-space magnet stays usable at different duration/zoom scales. */
export function seekTarget(x: number, width: number, durationUs: number, marks: TimeMark[] = [], snapPx = 10) {
  const raw = Math.round(Math.max(0, Math.min(1, width > 0 ? x / width : 0)) * Math.max(0, durationUs));
  const radius = width > 0 ? durationUs * snapPx / width : 0;
  const nearby = marks.filter(m => m.frame.ptsUs >= 0 && m.frame.ptsUs <= durationUs && Math.abs(m.frame.ptsUs - raw) <= radius)
    .sort((a, b) => Math.abs(a.frame.ptsUs - raw) - Math.abs(b.frame.ptsUs - raw) || a.frame.ptsUs - b.frame.ptsUs);
  return { ptsUs: nearby[0]?.frame.ptsUs ?? raw, nearby };
}

export function showSeekPreview(output: HTMLElement, x: number, ptsUs: number, nearby: TimeMark[] = [], anchor?: HTMLElement) {
  output.replaceChildren();
  const mark = nearby[0];
  const thumbnail = mark && annotationThumbnails.get(mark.id);
  if (thumbnail) {
    const image = document.createElement('img'); image.className = 'seek-preview-thumbnail';
    image.src = thumbnail.url; image.width = thumbnail.width; image.height = thumbnail.height;
    image.alt = t(msg('annotation.framePreview', '标注画面')); image.dataset.markId = mark.id;
    output.append(image);
  }
  const time = document.createElement('time'); time.textContent = formatTime(ptsUs); output.append(time);
  for (const mark of nearby.slice(0, 3)) {
    if (!mark.text.trim()) continue;
    const label = document.createElement('span'); label.className = 'seek-preview-mark';
    label.textContent = mark.text;
    output.append(label);
  }
  if (nearby.length > 3) output.append(document.createTextNode(` +${nearby.length - 3}`));
  output.hidden = false;
  if (anchor) {
    const rect = anchor.getBoundingClientRect();
    const half = output.offsetWidth / 2;
    output.style.left = `${Math.max(half + 8, Math.min(innerWidth - half - 8, rect.left + x))}px`;
    output.style.top = `${Math.max(4, rect.top - output.offsetHeight - 4)}px`;
    return;
  }
  const parent = output.parentElement!;
  const half = Math.min(output.offsetWidth, parent.clientWidth) / 2;
  output.style.left = `${Math.max(half, Math.min(parent.clientWidth - half, x))}px`;
}

/** Native input, painted rail, current pin and hover target share the full width. */
export function syncTimelineProgress(input: HTMLInputElement) {
  const ratio = Number(input.value) / Math.max(1, Number(input.max));
  input.parentElement!.style.setProperty('--progress-ratio', String(ratio));
}

export function bindTimelinePreview(input: HTMLInputElement, output: HTMLElement) {
  const marker = input.parentElement!.querySelector<HTMLElement>('.timeline-hover')!;
  const time = document.createElement('time');
  const label = document.createTextNode('');
  time.append(label); output.replaceChildren(time);
  // Escape the transport's backdrop root, while retaining one material and
  // text node throughout a hover (including incremental duration updates).
  output.setAttribute('popover', 'manual');
  let frame = 0, pointerX: number | null = null, keyboardUs: number | null = null;
  let geometry: { rail: DOMRect; width: number; height: number } | null = null;
  let shape = '', labelLength = 0, maximum = input.max;
  const active = () => pointerX !== null || keyboardUs !== null;
  const hide = () => {
    cancelAnimationFrame(frame); frame = 0;
    pointerX = keyboardUs = null; geometry = null;
    if (output.matches(':popover-open')) output.hidePopover();
    output.hidden = true; marker.hidden = true;
  };
  const render = () => {
    frame = 0;
    if (!active() || input.disabled) { hide(); return; }
    output.hidden = false;
    if (!output.matches(':popover-open')) output.showPopover();
    // Tabular numerals have a stable width. Only measure on entry, a real
    // layout change, or crossing from two-digit to three-digit minutes.
    const rail = geometry?.rail ?? input.getBoundingClientRect();
    if (!rail.width || !rail.height) { hide(); return; }
    const x = keyboardUs !== null || pointerX === null
      ? Number(input.value) / Math.max(1, Number(input.max)) * rail.width
      : Math.max(0, Math.min(rail.width, pointerX - rail.left));
    marker.style.transform = `translate3d(${x}px, 0, 0)`;
    marker.hidden = false;
    const text = formatTime(keyboardUs ?? seekTarget(x, rail.width, Number(input.max)).ptsUs);
    if (label.data !== text) label.data = text;
    if (!geometry || text.length !== labelLength) {
      const bounds = output.getBoundingClientRect();
      geometry = { rail, width: bounds.width, height: bounds.height };
      labelLength = text.length;
    }
    const { width, height } = geometry;
    const left = Math.max(8, Math.min(innerWidth - width - 8, rail.left + x - width / 2));
    const top = Math.max(4, rail.top + rail.height / 2 - height - 9);
    const bodyHeight = height - 8, radius = bodyHeight / 2;
    const tip = Math.max(radius + 10, Math.min(width - radius - 10,
      left === rail.left + x - width / 2 ? width / 2 : Math.round((rail.left + x - left) * devicePixelRatio) / devicePixelRatio));
    const key = `${width},${height},${tip}`;
    if (key !== shape) {
      // Rebuild only when the silhouette changes, not for every translated
      // position: otherwise tiny float differences create new SVG mask images.
      const d = `M ${radius} .5 H ${width - radius} A ${radius - .5} ${radius - .5} 0 0 1 ${width - .5} ${radius} A ${radius - .5} ${radius - .5} 0 0 1 ${width - radius} ${bodyHeight - .5} H ${tip + 12} C ${tip + 6} ${bodyHeight - .5} ${tip + 4} ${height - 4} ${tip + .6} ${height - 1} Q ${tip} ${height - .2} ${tip - .6} ${height - 1} C ${tip - 4} ${height - 4} ${tip - 6} ${bodyHeight - .5} ${tip - 12} ${bodyHeight - .5} H ${radius} A ${radius - .5} ${radius - .5} 0 0 1 .5 ${radius} A ${radius - .5} ${radius - .5} 0 0 1 ${radius} .5 Z`;
      output.style.clipPath = `path("${d}")`;
      output.style.setProperty('--seek-preview-outline', `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><path d="${d}" fill="none" stroke="white"/></svg>`)}")`);
      shape = key;
    }
    output.style.transform = `translate3d(${left}px, ${top}px, 0)`;
  };
  const schedule = () => { if (active() && !frame) frame = requestAnimationFrame(render); };
  const update = (event: PointerEvent) => {
    if (input.disabled) { hide(); return; }
    pointerX = event.clientX; keyboardUs = null; schedule();
  };
  input.addEventListener('pointermove', update);
  input.addEventListener('pointerenter', update);
  input.addEventListener('pointerleave', hide);
  input.addEventListener('blur', hide);
  window.addEventListener('resize', hide);
  window.addEventListener('scroll', event => {
    // Indexing can scroll a sibling media-library list. That does not move
    // this anchor and must not dismiss/reopen its glass preview.
    if (event.target instanceof Node && event.target.contains(input)) hide();
  }, true);
  document.addEventListener('beforetoggle', event => {
    if ((event as ToggleEvent).newState === 'open' && event.target instanceof Element &&
      event.target.matches('dialog, .popup-menu, .header-actions[popover]')) hide();
  }, true);
  new ResizeObserver(() => { geometry = null; schedule(); }).observe(input);
  new MutationObserver(() => {
    if (input.disabled) { hide(); return; }
    if (maximum !== input.max) { maximum = input.max; schedule(); }
  }).observe(input, { attributes: true, attributeFilter: ['max', 'disabled'] });
  input.addEventListener('input', () => {
    syncTimelineProgress(input);
    keyboardUs = Number(input.value); schedule();
  });
}
