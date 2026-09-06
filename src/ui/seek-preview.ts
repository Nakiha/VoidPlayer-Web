import { formatTime } from '../model.ts';
import { annotationThumbnails } from './drawing-editor.ts';

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
    image.alt = '标注画面'; image.dataset.markId = mark.id;
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
  const hide = () => { output.hidden = true; marker.hidden = true; };
  const preview = (x: number, ptsUs: number) => {
    marker.style.left = `${x}px`; marker.hidden = false;
    showSeekPreview(output, x, ptsUs);
  };
  const update = (event: PointerEvent) => {
    if (input.disabled) { hide(); return; }
    const rect = input.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, event.clientX - rect.left));
    const target = seekTarget(x, rect.width, Number(input.max));
    preview(x, target.ptsUs);
  };
  input.addEventListener('pointermove', update);
  input.addEventListener('pointerenter', update);
  input.addEventListener('pointerleave', hide);
  input.addEventListener('blur', hide);
  input.addEventListener('input', () => {
    syncTimelineProgress(input);
    preview(Number(input.value) / Math.max(1, Number(input.max)) * input.clientWidth, Number(input.value));
  });
}
