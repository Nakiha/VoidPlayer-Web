import { animatePanelLayout } from './panel-motion.ts';
/** Bound panel widths while reserving room for the comparison surface. */
export function panelWidthBounds(workspaceWidth: number, otherWidth: number, overlay: boolean, min = 160, max = 480, comparisonMin = 360) {
  const upper = Math.max(1, Math.min(max, overlay ? workspaceWidth * .75 : workspaceWidth - otherWidth - comparisonMin));
  return { min: Math.min(min, upper), max: upper };
}

/** Overshoot is measured before clamping, so the minimum remains an ordinary usable width. */
export function panelDragIntent(width: number, delta: number, direction: 1 | -1, bounds: { min: number; max: number }, threshold: number) {
  const requested = width + direction * delta;
  return { width: Math.max(bounds.min, Math.min(bounds.max, requested)), collapse: requested <= bounds.min - threshold };
}

export function installPanelResize(workspace: HTMLElement, signal: AbortSignal, collapse: (panel: 'inspector' | 'sources') => void) {
  const key = 'voidplayer.panel-widths.v1';
  let saved: Record<string, number> = {};
  try { saved = JSON.parse(localStorage.getItem(key) ?? '{}') ?? {}; } catch { /* Optional preferences. */ }
  const panels = ['inspector', 'sources'] as const;
  const readToken = (name: string) => Number.parseFloat(getComputedStyle(workspace).getPropertyValue(name));
  const defaults = { inspector: readToken('--inspector-width'), sources: readToken('--sources-width') };
  const preferred = { ...defaults };
  for (const panel of panels) if (Number.isFinite(saved[panel])) preferred[panel] = saved[panel];
  const save = () => { try { localStorage.setItem(key, JSON.stringify(preferred)); } catch { /* Resizing still works. */ } };
  const update = (panel: typeof panels[number]) => {
    const other = panel === 'inspector' ? 'sources' : 'inspector';
    const otherEl = document.getElementById(`${other}-panel`)!;
    const overlay = false;
    const bounds = panelWidthBounds(workspace.clientWidth, otherEl.hidden || otherEl.classList.contains('panel-closed') ? 0 : otherEl.getBoundingClientRect().width, overlay,
      readToken('--side-panel-min-width'), readToken('--side-panel-max-width'), Math.min(readToken('--comparison-min-width'), workspace.clientWidth * .4));
    const width = Math.round(Math.max(bounds.min, Math.min(bounds.max, preferred[panel])));
    workspace.style.setProperty(`--${panel}-user-width`, `${width}px`);
    const handle = document.getElementById(`${panel}-resize`)!;
    const panelEl = document.getElementById(`${panel}-panel`)!;
    handle.hidden = panelEl.hidden || panelEl.classList.contains('panel-closed');
    handle.setAttribute('aria-valuemin', String(Math.ceil(bounds.min)));
    handle.setAttribute('aria-valuemax', String(Math.floor(bounds.max)));
    handle.setAttribute('aria-valuenow', String(width));
    handle.setAttribute('aria-valuetext', `${width} 像素`);
    return { width, ...bounds };
  };
  for (const panel of panels) {
    const handle = document.getElementById(`${panel}-resize`)!;

    let drag: { pointer: number; x: number; width: number; previous: number; collapse: boolean } | null = null;
    const direction = panel === 'inspector' ? 1 : -1;
    handle.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      e.preventDefault(); handle.focus({ preventScroll: true });
      drag = { pointer: e.pointerId, x: e.clientX, width: update(panel).width, previous: preferred[panel], collapse: false };
      handle.setPointerCapture(e.pointerId); handle.classList.add('resizing');
      workspace.classList.add('panel-dragging');
      document.getElementById(`${panel}-panel`)!.classList.add('panel-pushing');
    }, { signal });
    handle.addEventListener('pointermove', e => {
      if (!drag || e.pointerId !== drag.pointer) return;
      const bounds = update(panel);
      const intent = panelDragIntent(drag.width, e.clientX - drag.x, direction, bounds, readToken('--panel-collapse-distance'));
      preferred[panel] = intent.width; drag.collapse = intent.collapse;
      const overshoot = Math.max(0, bounds.min - (drag.width + direction * (e.clientX - drag.x)));
      const panelEl = document.getElementById(`${panel}-panel`)!;
      panelEl.style.setProperty('--panel-push', `${-direction * Math.min(bounds.min, overshoot)}px`);
      handle.style.setProperty('--panel-push', `${-direction * Math.min(bounds.min, overshoot)}px`);
      workspace.style.setProperty(`--${panel}-push-space`, `${Math.min(bounds.min, overshoot)}px`);
      panelEl.style.setProperty('--panel-veil-opacity', String(Math.min(1, overshoot / readToken('--panel-collapse-distance'))));
      handle.classList.toggle('collapse-ready', intent.collapse);
      update(panel);
      if (intent.collapse) handle.setAttribute('aria-valuetext', '松开收起面板');
    }, { signal });
    const finish = (cancel: boolean) => {
      if (!drag) return;
      const shouldCollapse = !cancel && drag.collapse;
      const previous = drag.previous, pointer = drag.pointer;
      drag = null;
      if (handle.hasPointerCapture(pointer)) handle.releasePointerCapture(pointer);
      handle.classList.remove('resizing', 'collapse-ready');
      const panelEl = document.getElementById(`${panel}-panel`)!;
      panelEl.classList.remove('panel-pushing'); workspace.classList.remove('panel-dragging'); animatePanelLayout(workspace);
      if (shouldCollapse) collapse(panel);
      panelEl.style.removeProperty('--panel-push'); panelEl.style.removeProperty('--panel-veil-opacity');
      handle.style.removeProperty('--panel-push');
      workspace.style.removeProperty(`--${panel}-push-space`);
      if (cancel || shouldCollapse) preferred[panel] = previous;
      update(panel); if (!cancel) save();
    };
    handle.addEventListener('pointerup', () => finish(false), { signal });
    handle.addEventListener('pointercancel', () => finish(true), { signal });
    handle.addEventListener('lostpointercapture', () => finish(true), { signal });
    window.addEventListener('blur', () => finish(true), { signal });
    handle.addEventListener('dblclick', () => { preferred[panel] = defaults[panel]; update(panel); save(); }, { signal });
    handle.addEventListener('keydown', e => {
      if (e.key === 'Escape' && drag) { e.preventDefault(); finish(true); return; }
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
      e.preventDefault(); e.stopPropagation(); const bounds = update(panel);
      preferred[panel] = e.key === 'Home' ? bounds.min : e.key === 'End' ? bounds.max : bounds.width + (e.key === 'ArrowRight' ? 16 : -16) * direction;
      preferred[panel] = Math.max(bounds.min, Math.min(bounds.max, preferred[panel])); update(panel); save();
    }, { signal });
  }
  const refresh = () => panels.forEach(update);
  window.addEventListener('resize', refresh, { signal });
  refresh();
  return { refresh };
}
