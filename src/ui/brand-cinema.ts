import type { BrandCinemaStyle } from './brand-effects.ts';
import { createEmulsion } from './brand-scenes/emulsion.ts';
import { createFilm } from './brand-scenes/film.ts';
import { createPrism } from './brand-scenes/prism.ts';
import { ease, mix } from './brand-scenes/timing.ts';
import './brand-cinema.css';

type Pose = { x: number; y: number; scale: number; angle: number; split: number; light: number; opacity: number };
const EXIT_MS = 170;

export function playBrandCinema(button: HTMLButtonElement, scene: BrandCinemaStyle, done: () => void) {
  const w = innerWidth, h = innerHeight, bounds = button.getBoundingClientRect(), font = getComputedStyle(button);
  const overlay = document.createElement('div');
  overlay.className = 'brand-cinema brand-cinema--' + scene;
  overlay.setAttribute('aria-hidden', 'true');
  const canvas = document.createElement('canvas');
  const ratio = Math.min(devicePixelRatio || 1, 1.5, Math.sqrt(1_500_000 / (w * h)));
  canvas.width = Math.max(1, Math.round(w * ratio)); canvas.height = Math.max(1, Math.round(h * ratio));
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx || !bounds.width || !bounds.height) throw new Error('Brand stage unavailable');
  ctx.scale(canvas.width / w, canvas.height / h);
  const film = scene === 'film';
  const paint = film ? createFilm(ctx, w, h) : createPrism(ctx, w, h);
  const emulsion = film ? createEmulsion(w, h) : undefined;

  const title = document.createElement('span');
  title.className = 'brand-cinema-title';
  title.textContent = button.textContent;
  title.dataset.word = title.textContent ?? '';
  const heroScale = (film ? Math.min(w * .48, h * .80) : Math.min(w * .53, h * .74)) / bounds.width;
  title.style.fontFamily = font.fontFamily; title.style.fontWeight = font.fontWeight;
  title.style.fontSize = parseFloat(font.fontSize) * heroScale + 'px';
  title.style.letterSpacing = (parseFloat(font.letterSpacing) || 0) * heroScale + 'px';
  title.style.setProperty('--source-ink', font.color);
  const home: Pose = { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2,
    scale: 1 / heroScale, angle: 0, split: 0, light: 0, opacity: 1 };
  const start = performance.now(), originalOpacity = button.style.opacity;
  let current = home, frame = 0, lastTick = -1, timer: number | undefined, finished = false;
  let exit: { from: Pose; start: number } | undefined;

  function place(p: Pose) {
    current = p;
    title.style.transform = `translate(${p.x}px, ${p.y}px) translate(-50%, -50%) rotate(${p.angle}deg) scale(${p.scale})`;
    title.style.setProperty('--light', p.light * 100 + '%');
    title.style.setProperty('--separation', p.split + 'px');
    const channels = Math.min(1, p.split / 8);
    title.style.setProperty('--channel-opacity', String(channels * .82));
    title.style.setProperty('--channel-tint', channels * 100 + '%');
    title.style.opacity = String(p.opacity);
    canvas.style.opacity = String(p.light);
    if (emulsion) emulsion.canvas.style.opacity = String(p.light * .26);
  }
  function cleanup() {
    if (finished) return;
    finished = true;
    cancelAnimationFrame(frame);
    clearTimeout(timer);
    overlay.remove();
    button.style.opacity = originalOpacity;
    canvas.width = canvas.height = 1;
    if (emulsion) emulsion.canvas.width = emulsion.canvas.height = 1;
    done();
  }
  function retract() {
    if (finished || exit) return;
    exit = { from: current, start: performance.now() };
    timer = window.setTimeout(cleanup, EXIT_MS + 16);
  }
  function draw(now: number) {
    const t = (now - start) / 1000;
    if (exit) {
      const { from, start } = exit, u = ease(0, EXIT_MS, now - start);
      place({ x: mix(from.x, home.x, u), y: mix(from.y, home.y, u), scale: mix(from.scale, home.scale, u),
        angle: from.angle * (1 - u), split: from.split * (1 - u), light: from.light * (1 - u), opacity: mix(from.opacity, 1, u) });
      if (u >= 1) { cleanup(); return; }
    } else if (Math.floor(t * 24) !== lastTick) {
      lastTick = Math.floor(t * 24);
      const beam = paint(t), light = ease(0, .85, t);
      if ('entry' in beam) {
        const approach = ease(0, .95, t), pass = ease(.88, 1.34, t), project = ease(1.22, 2.90, t);
        const x = mix(mix(home.x, beam.entry[0], approach), beam.exit[0], pass);
        const y = mix(mix(home.y, beam.entry[1], approach), beam.exit[1], pass);
        const arc = Math.sin(Math.PI * project);
        place({ x: mix(x, w * .5, project) + arc * w * .10, y: mix(y, h * .79, project),
          scale: mix(mix(home.scale, .034, approach), 1, project) + arc * .13, angle: -9 * arc,
          split: ease(1.13, 1.98, t) * (1 - ease(2.01, 3.28, t)) * Math.min(w, h) * .045, light, opacity: 1 });
      } else {
        emulsion?.develop(t);
        const u = ease(.04, 2.7, t), arc = Math.sin(Math.PI * u);
        place({ x: mix(home.x, beam.x, u) + arc * w * .10, y: mix(home.y, beam.y, u) - arc * h * .09,
          scale: mix(home.scale, 1, u) + arc * .12, angle: -8 * arc + beam.angle * u, split: 0, light, opacity: mix(1, beam.opacity, u) });
      }
    }
    frame = requestAnimationFrame(draw);
  }
  place(home);
  overlay.append(canvas, title);
  if (emulsion) overlay.append(emulsion.canvas);
  document.body.append(overlay);
  button.style.opacity = '0';
  frame = requestAnimationFrame(draw);
  return (immediate = false) => { if (immediate) cleanup(); else retract(); };
}
