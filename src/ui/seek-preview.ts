import { formatTime } from '../model.ts';

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
  output.textContent = `${formatTime(ptsUs)}${nearby.length ? ` · ${nearby.slice(0, 3).map(m => m.text).join(' / ')}${nearby.length > 3 ? ` +${nearby.length - 3}` : ''}` : ''}`;
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

export function bindTimelinePreview(input: HTMLInputElement, output: HTMLElement) {
  const update = (event: PointerEvent) => {
    if (input.disabled) { output.hidden = true; return; }
    const rect = input.getBoundingClientRect();
    const thumb = Number.parseFloat(getComputedStyle(input).getPropertyValue('--timeline-thumb-size')) || 12;
    const target = seekTarget(event.clientX - rect.left - thumb / 2, rect.width - thumb, Number(input.max));
    showSeekPreview(output, event.clientX - rect.left, target.ptsUs);
  };
  input.addEventListener('pointermove', update);
  input.addEventListener('pointerleave', () => { output.hidden = true; });
  input.addEventListener('blur', () => { output.hidden = true; });
  input.addEventListener('input', () => {
    const ratio = Number(input.value) / Math.max(1, Number(input.max));
    input.style.setProperty('--progress-ratio', String(ratio));
    showSeekPreview(output, ratio * input.clientWidth, Number(input.value));
  });
}
