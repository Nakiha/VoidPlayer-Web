export type BrandCinemaStyle = 'runaway' | 'portal';
const DWELL_MS = 1100;

// Only this small hover controller is loaded at startup.
export function installBrandEffects(button: HTMLButtonElement, openAbout: () => void) {
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  const life = new AbortController();
  let hovered = false, played = false, pending = false;
  let anchor = { x: 0, y: 0 };
  let epoch = 0;
  let timer: number | undefined;
  let stop: ((immediate?: boolean) => void) | undefined;
  const clear = (immediate = false) => {
    ++epoch;
    clearTimeout(timer);
    pending = false;
    button.removeAttribute('aria-busy');
    stop?.(immediate);
  };
  const play = async () => {
    if (!hovered || played || motion.matches || document.hidden || document.querySelector('dialog[open]')) return;
    played = true;
    pending = true;
    button.setAttribute('aria-busy', 'true');
    const request = ++epoch;
    try {
      const { playBrandCinema } = await import('./brand-cinema.ts');
      if (request !== epoch || life.signal.aborted || !hovered || motion.matches || document.hidden) return;
      stop = playBrandCinema(button, Math.random() < .5 ? 'runaway' : 'portal', () => { stop = undefined; });
    } catch {
      // Optional animation failure must not change the working About button.
    } finally {
      if (request === epoch) { pending = false; button.removeAttribute('aria-busy'); }
    }
  };
  const schedule = () => { clearTimeout(timer); timer = window.setTimeout(play, DWELL_MS); };
  button.addEventListener('pointerenter', event => {
    if (event.pointerType === 'touch') return;
    hovered = true; played = false;
    anchor = { x: event.clientX, y: event.clientY };
    schedule();
  }, { signal: life.signal });
  button.addEventListener('pointermove', event => {
    if (!hovered || played || stop || pending) return;
    if (Math.hypot(event.clientX - anchor.x, event.clientY - anchor.y) > 5) {
      anchor = { x: event.clientX, y: event.clientY };
      schedule();
    }
  }, { signal: life.signal });
  button.addEventListener('pointerleave', () => { hovered = false; clear(); }, { signal: life.signal });
  button.addEventListener('pointercancel', () => { hovered = false; clear(); }, { signal: life.signal });
  button.addEventListener('click', () => { clear(true); openAbout(); }, { signal: life.signal });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && (stop || pending)) {
      event.preventDefault(); event.stopImmediatePropagation(); clear();
    } else if (stop) clear();
  }, { capture: true, signal: life.signal });
  document.addEventListener('pointerdown', () => clear(true), { signal: life.signal });
  document.addEventListener('visibilitychange', () => { if (document.hidden) { hovered = false; clear(true); } }, { signal: life.signal });
  window.addEventListener('resize', () => { hovered = false; clear(true); }, { signal: life.signal });
  window.addEventListener('pagehide', () => clear(true), { signal: life.signal });
  motion.addEventListener('change', () => clear(true), { signal: life.signal });
  return () => { life.abort(); clear(true); };
}
