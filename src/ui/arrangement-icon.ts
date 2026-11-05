import gridSvg from '@phosphor-icons/core/assets/regular/squares-four.svg?raw';
import columnsSvg from '@phosphor-icons/core/assets/regular/columns.svg?raw';
import type { Arrangement } from '../../shared/presentation/viewport.ts';

const gridPath = gridSvg.match(/d="([^"]+)"/)![1];
const columnsPath = columnsSvg.match(/d="([^"]+)"/)![1];

function cap(x: number, progress: number, lower: boolean) {
  const width = 80 - 8 * progress, height = 80 + 16 * progress, radius = 16 * (1 - progress);
  const y = 40 - 8 * progress;
  // Rotate the lower cap by 180 degrees so every contour has the same winding.
  const point = (u: number, v: number) => `${lower ? x + width - u : x + u},${lower ? 256 - y - v : y + v}`;
  return `M${point(16, 0)} L${point(width - 16, 0)} A16,16 0 0 1 ${point(width, 16)}
    L${point(width, height - radius)} A${radius},${radius} 0 0 1 ${point(width - radius, height)}
    L${point(width - 16, height)} L${point(width - 16, 16)} L${point(16, 16)} L${point(16, height)}
    L${point(radius, height)} A${radius},${radius} 0 0 1 ${point(0, height - radius)}
    L${point(0, 16)} A16,16 0 0 1 ${point(16, 0)} Z`;
}

// Open caps grow into columns. The middle bars stay at their original height
// and fade separately, instead of sweeping shrinking subpixel edges together.
function intermediatePath(progress: number) {
  return [40 + 8 * progress, 136].flatMap(x => [cap(x, progress, false), cap(x, progress, true)]).join(' ');
}

function separatorPath(progress: number) {
  return [56 + 8 * progress, 152].flatMap(x => [104, 136].map(y =>
    `M${x},${y} h${48 - 8 * progress} v16 h${-48 + 8 * progress} Z`)).join(' ');
}

const animations = new WeakMap<HTMLElement, { progress: number; frame: number }>();
export function animateArrangementIcon(button: HTMLElement, arrangement: Arrangement) {
  const svg = button.querySelector<SVGSVGElement>('.arrangement-icon'), path = svg?.querySelector('path');
  if (!svg || !path) return;
  let separators = svg.querySelector<SVGPathElement>('[data-arrangement-separators]');
  if (!separators) {
    separators = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    separators.setAttribute('data-arrangement-separators', '');
    svg.append(separators);
  }
  const target = Number(arrangement === 'grid');
  const state = animations.get(button) ?? { progress: target, frame: 0 };
  animations.set(button, state);
  cancelAnimationFrame(state.frame);
  svg.dataset.icon = target ? 'columns' : 'grid';
  svg.setAttribute('fill-rule', 'nonzero');
  const from = state.progress;
  const paint = (progress: number) => {
    state.progress = progress;
    path.setAttribute('d', progress === 0 ? gridPath : progress === 1 ? columnsPath : intermediatePath(progress));
    separators.setAttribute('d', separatorPath(progress));
    separators.setAttribute('opacity', progress === 0 || progress === 1 ? '0' : String(1 - progress));
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
