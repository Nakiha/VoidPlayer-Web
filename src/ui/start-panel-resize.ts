import { installResizeGesture } from './resize-gesture.ts';

const WIDTH_KEY = 'voidplayer.start-panel-width.v1';
const DEFAULT_WIDTH = 680, MIN_WIDTH = 320, HANDLE_GUTTERS = 48;

/** Both edges move around the same center; window clamps preserve the preference. */
export function installStartPanelResize(panel: HTMLElement, signal: AbortSignal) {
  const host = panel.parentElement!;
  const handles = [...panel.querySelectorAll<HTMLElement>('.start-resize')];
  let preferred = DEFAULT_WIDTH;
  try {
    const saved = Number(localStorage.getItem(WIDTH_KEY));
    if (Number.isFinite(saved) && saved > 0 && saved <= 10000) preferred = saved;
  } catch { /* Resizing remains available when storage is disabled. */ }
  const bounds = () => {
    const style = getComputedStyle(host);
    const max = Math.max(0, Math.floor(host.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight) - HANDLE_GUTTERS));
    return { min: Math.min(MIN_WIDTH, max), max };
  };
  function refresh() {
    const { min, max } = bounds();
    if (!max) return; // The start panel is hidden while a source occupies A.
    const width = Math.max(min, Math.min(max, preferred));
    panel.style.setProperty('--start-panel-width', `${width}px`);
    for (const handle of handles) {
      handle.setAttribute('aria-valuemin', String(min)); handle.setAttribute('aria-valuemax', String(max));
      handle.setAttribute('aria-valuenow', String(Math.round(width))); handle.setAttribute('aria-valuetext', `${Math.round(width)} 像素`);
      handle.setAttribute('aria-disabled', String(max <= min)); handle.tabIndex = max > min ? 0 : -1;
    }
  }
  for (const handle of handles) {
    const followPointer = (event: PointerEvent) => {
      const rect = handle.getBoundingClientRect();
      // Keep the complete gradient inside the padded gutter at both ends.
      const inset = Math.min(68, rect.height / 2);
      handle.style.setProperty('--start-resize-y', `${Math.max(inset, Math.min(rect.height - inset, event.clientY - rect.top))}px`);
    };
    handle.addEventListener('pointerenter', followPointer, { signal });
    handle.addEventListener('pointermove', followPointer, { signal });
    installResizeGesture(handle, {
      axis: 'x', direction: handle.dataset.edge === 'left' ? -1 : 1,
      // The shared gesture adjusts one edge's distance from the center. A 1px
      // edge movement therefore changes the full list width by exactly 2px.
      size: () => panel.getBoundingClientRect().width / 2,
      bounds() { const { min, max } = bounds(); return { min: min / 2, max: max / 2 }; },
      resize(halfWidth) {
        const { min, max } = bounds(); preferred = Math.round(Math.max(min, Math.min(max, halfWidth * 2)));
        refresh();
        try { localStorage.setItem(WIDTH_KEY, String(preferred)); } catch { /* Width persistence is optional. */ }
      },
      reset: () => DEFAULT_WIDTH / 2, threshold: () => Infinity,
      dragging(active) { panel.classList.toggle('resizing', active); }, preview() {}, collapse() {},
    }, signal);
  }
  const observer = new ResizeObserver(refresh); observer.observe(host);
  window.addEventListener('resize', refresh, { signal });
  signal.addEventListener('abort', () => { observer.disconnect(); panel.classList.remove('resizing'); }, { once: true });
  refresh();
}
