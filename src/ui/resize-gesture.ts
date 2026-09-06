import { panelDragIntent } from './panel-resize.ts';

type ResizeOptions = {
  axis: 'x' | 'y'; direction: 1 | -1;
  size(): number; bounds(): {min:number;max:number}; resize(value:number): void;
  threshold(): number; reset(): number;
  dragging(active:boolean): void; preview(push:number, veil:number): void;
  collapse(): void;
};

/** Shared pointer/keyboard lifecycle for the dock and its annotation sidebar. */
export function installResizeGesture(handle: HTMLElement, options: ResizeOptions, signal: AbortSignal) {
  let drag: {pointer:number; origin:number; size:number; collapse:boolean} | null = null;
  const position = (e:PointerEvent) => options.axis === 'x' ? e.clientX : e.clientY;
  function finish(cancel:boolean) {
    if (!drag) return;
    const previous = drag; drag = null;
    if (handle.hasPointerCapture(previous.pointer)) handle.releasePointerCapture(previous.pointer);
    handle.classList.remove('resizing'); options.dragging(false);
    if (!cancel && previous.collapse) options.collapse();
    options.preview(0,0);
    if (cancel || previous.collapse) options.resize(previous.size);
  }
  handle.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation(); handle.focus({preventScroll:true});
    drag = {pointer:e.pointerId,origin:position(e),size:options.size(),collapse:false};
    handle.setPointerCapture(e.pointerId); handle.classList.add('resizing'); options.dragging(true);
  }, {signal});
  handle.addEventListener('pointermove', e => {
    if (!drag || e.pointerId !== drag.pointer) return;
    const delta = position(e) - drag.origin, bounds = options.bounds();
    const intent = panelDragIntent(drag.size,delta,options.direction,bounds,options.threshold());
    drag.collapse = intent.collapse; options.resize(intent.width);
    const overshoot = Math.max(0,bounds.min - (drag.size + options.direction * delta));
    options.preview(-options.direction * Math.min(bounds.min,overshoot),Math.min(1,overshoot/options.threshold()));
    if (intent.collapse) handle.setAttribute('aria-valuetext','松开收起面板');
  }, {signal});
  handle.addEventListener('pointerup', () => finish(false), {signal});
  handle.addEventListener('pointercancel', () => finish(true), {signal});
  handle.addEventListener('lostpointercapture', () => finish(true), {signal});
  window.addEventListener('blur', () => finish(true), {signal});
  handle.addEventListener('dblclick', () => options.resize(options.reset()), {signal});
  handle.addEventListener('keydown', e => {
    if (e.key === 'Escape' && drag) { e.preventDefault(); e.stopPropagation(); finish(true); return; }
    const keys = options.axis === 'x' ? ['ArrowLeft','ArrowRight'] : ['ArrowUp','ArrowDown'];
    if (![...keys,'Home','End'].includes(e.key)) return;
    e.preventDefault(); e.stopPropagation(); const bounds = options.bounds();
    options.resize(e.key === 'Home' ? bounds.min : e.key === 'End' ? bounds.max : options.size() + (e.key === keys[1] ? 16 : -16)*options.direction);
  }, {signal});
}
