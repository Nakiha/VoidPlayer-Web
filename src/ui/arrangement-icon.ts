import gridSvg from '@phosphor-icons/core/assets/regular/squares-four.svg?raw';
import columnsSvg from '@phosphor-icons/core/assets/regular/columns.svg?raw';
import type { Arrangement } from '../../shared/presentation/viewport.ts';

const gridPath = gridSvg.match(/d="([^"]+)"/)![1];
const columnsPath = columnsSvg.match(/d="([^"]+)"/)![1];

function outline(x: number, y: number, width: number, height: number, top: number, bottom: number) {
  const right = x + width, lower = y + height;
  return `M${x + top},${y} H${right - top} A${top},${top} 0 0 1 ${right},${y + top}
    V${lower - bottom} A${bottom},${bottom} 0 0 1 ${right - bottom},${lower}
    H${x + bottom} A${bottom},${bottom} 0 0 1 ${x},${lower - bottom}
    V${y + top} A${top},${top} 0 0 1 ${x + top},${y} Z`;
}

// The four squares grow into two columns as their middle edges and inner
// corners recede. At the join, shared edges cancel under evenodd without a seam.
function intermediatePath(progress: number) {
  return [40 + 8 * progress, 136].flatMap(x => [false, true].map(lower => {
    const y = lower ? 136 - 8 * progress : 40 - 8 * progress;
    const top = lower ? 16 * (1 - progress) : 16, bottom = lower ? 16 : 16 * (1 - progress);
    const width = 80 - 8 * progress, height = 80 + 16 * progress;
    return outline(x, y, width, height, top, bottom)
      + outline(x + 16, y + top, width - 32, height - top - bottom, 0, 0);
  })).join(' ');
}

const animations = new WeakMap<HTMLElement, { progress: number; frame: number }>();
export function animateArrangementIcon(button: HTMLElement, arrangement: Arrangement) {
  const svg = button.querySelector<SVGSVGElement>('.arrangement-icon'), path = svg?.querySelector('path');
  if (!svg || !path) return;
  const target = Number(arrangement === 'grid');
  const state = animations.get(button) ?? { progress: target, frame: 0 };
  animations.set(button, state);
  cancelAnimationFrame(state.frame);
  svg.dataset.icon = target ? 'columns' : 'grid';
  svg.setAttribute('fill-rule', 'evenodd');
  const from = state.progress;
  const paint = (progress: number) => {
    state.progress = progress;
    path.setAttribute('d', progress === 0 ? gridPath : progress === 1 ? columnsPath : intermediatePath(progress));
  };
  if (matchMedia('(prefers-reduced-motion: reduce)').matches || from === target) { paint(target); return; }
  const start = performance.now(), duration = 240 * Math.abs(target - from);
  const step = (now: number) => {
    if (!button.isConnected) return;
    const elapsed = Math.min(1, (now - start) / duration);
    const eased = 1 - (1 - elapsed) ** 3;
    paint(elapsed === 1 ? target : from + (target - from) * eased);
    if (elapsed < 1) state.frame = requestAnimationFrame(step);
  };
  state.frame = requestAnimationFrame(step);
}
