import playSvg from '@phosphor-icons/core/assets/regular/play.svg?raw';
import pauseSvg from '@phosphor-icons/core/assets/regular/pause.svg?raw';

const playPath = playSvg.match(/d="([^"]+)"/)![1];
const pausePath = pauseSvg.match(/d="([^"]+)"/)![1];
// Preserve the original play glyph's -1.5px optical correction at 18px.
const playOffset = -256 / 12;
const playTransform = `translate(${playOffset} 0)`;
type Point = { x: number; y: number };
type Contours = Point[][];
let endpoints: { play: Contours; pause: Contours } | undefined;

export function playbackIcon() {
  return `<svg class="icon playback-icon" data-icon="playback" viewBox="0 0 256 256" fill="currentColor" fill-rule="evenodd" aria-hidden="true" focusable="false"><path d="${playPath}" transform="${playTransform}"/></svg>`;
}

function sample(d: string): Point[] {
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', d);
  const length = path.getTotalLength();
  return Array.from({ length: 256 }, (_, i) => {
    const point = path.getPointAtLength(length * i / 256);
    return { x: point.x, y: point.y };
  });
}

// Split both the outside and the hole, so the triangle's two halves become
// outlined bars. Shared edges cancel under evenodd; there is no painted seam.
function split(points: Point[], left: boolean): Point[] {
  const clipped: Point[] = [];
  const inside = (point: Point) => left ? point.x <= 128 : point.x >= 128;
  for (let i = 0; i < points.length; i++) {
    const previous = points[(i + points.length - 1) % points.length], current = points[i];
    if (inside(previous) !== inside(current)) {
      const t = (128 - previous.x) / (current.x - previous.x);
      clipped.push({ x: 128, y: previous.y + t * (current.y - previous.y) });
    }
    if (inside(current)) clipped.push(current);
  }
  return clipped.map(point => ({ x: point.x + playOffset, y: point.y }));
}

// Corresponding clockwise contours begin at the upper left and have equal
// numbers of points. Native SVG geometry retains the existing glyph's curves.
function normalize(points: Point[]): Point[] {
  const area = points.reduce((sum, p, i) => {
    const next = points[(i + 1) % points.length];
    return sum + p.x * next.y - next.x * p.y;
  }, 0);
  if (area < 0) points.reverse();
  let first = 0;
  points.forEach((p, i) => {
    if (p.y < points[first].y || (p.y === points[first].y && p.x < points[first].x)) first = i;
  });
  const ordered = [...points.slice(first), ...points.slice(0, first)];
  ordered.push(ordered[0]);
  const lengths = ordered.slice(1).map((p, i) => Math.hypot(p.x - ordered[i].x, p.y - ordered[i].y));
  const perimeter = lengths.reduce((sum, length) => sum + length, 0);
  let edge = 0, traversed = 0;
  return Array.from({ length: 128 }, (_, i) => {
    const distance = perimeter * i / 128;
    while (edge < lengths.length - 1 && traversed + lengths[edge] < distance) traversed += lengths[edge++];
    const t = lengths[edge] ? (distance - traversed) / lengths[edge] : 0;
    return { x: ordered[edge].x + t * (ordered[edge + 1].x - ordered[edge].x), y: ordered[edge].y + t * (ordered[edge + 1].y - ordered[edge].y) };
  });
}

function getEndpoints() {
  if (endpoints) return endpoints;
  const [outside, hole] = playPath.split(/(?=M)/).map(sample);
  const play = [true, false].flatMap(left => [normalize(split(outside, left)), normalize(split(hole, left))]);
  const pause = [40, 144].flatMap(x => [
    normalize(sample(`M${x + 16},32 H${x + 56} A16,16 0 0 1 ${x + 72},48 V208 A16,16 0 0 1 ${x + 56},224 H${x + 16} A16,16 0 0 1 ${x},208 V48 A16,16 0 0 1 ${x + 16},32 Z`)),
    normalize(sample(`M${x + 16},48 H${x + 56} V208 H${x + 16} Z`)),
  ]);
  return endpoints = { play, pause };
}

const animations = new WeakMap<HTMLElement, { progress: number; frame: number }>();
export function animatePlaybackIcon(button: HTMLElement, playing: boolean) {
  const path = button.querySelector<SVGPathElement>('.playback-icon path');
  if (!path) return;
  const state = animations.get(button) ?? { progress: 0, frame: 0 };
  animations.set(button, state);
  cancelAnimationFrame(state.frame);
  const from = state.progress, target = Number(playing);
  const paint = (progress: number) => {
    state.progress = progress;
    if (progress === 0 || progress === 1) {
      // Endpoints use the unmodified assets, not approximations of their outlines.
      path.setAttribute('d', progress ? pausePath : playPath);
      path.setAttribute('transform', progress ? '' : playTransform);
      return;
    }
    const shapes = getEndpoints();
    path.setAttribute('transform', '');
    path.setAttribute('d', shapes.play.map((contour, c) => contour.map((point, i) => {
      const end = shapes.pause[c][i];
      const x = point.x + (end.x - point.x) * progress, y = point.y + (end.y - point.y) * progress;
      return `${i ? 'L' : 'M'}${x.toFixed(3)},${y.toFixed(3)}`;
    }).join(' ') + ' Z').join(' '));
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
