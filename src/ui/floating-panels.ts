/** Viewport tools are peers: the overlay controls make room for the annotation
 * toolbar when their rectangles overlap, including while the toolbar is dragged. */
export function installFloatingPanelAvoidance(panel: HTMLElement, peer: HTMLElement, signal: AbortSignal) {
  const viewport = panel.closest<HTMLElement>('.viewport-surface')!;
  const transport = viewport.querySelector<HTMLElement>('.transport')!;
  let frame = 0;
  let position: { x: number; y: number } | undefined;
  const grip = panel.querySelector<HTMLElement>('[data-floating-grip]');
  const property = (name: string, value: string) => {
    if (panel.style.getPropertyValue(name) !== value) panel.style.setProperty(name, value);
  };
  const layout = () => {
    frame = 0;
    if (panel.hidden) return;
    const bounds = viewport.getBoundingClientRect(), controls = transport.getBoundingClientRect();
    const inset = Math.max(8, bounds.bottom - controls.top + 12);
    const height = Math.min(panel.scrollHeight + 2, Math.max(48, bounds.height - inset - 8));
    if (position) {
      position.x = Math.max(8, Math.min(bounds.width - panel.offsetWidth - 8, position.x));
      position.y = Math.max(8, Math.min(bounds.height - inset - height, position.y));
      property('left', `${position.x}px`);
      property('right', 'auto');
    }
    const bottom = position ? bounds.height - position.y - height : inset;
    property('bottom', `${bottom}px`);
    let available = Math.max(48, bounds.height - bottom - 8);
    let shift = 0;
    if (!peer.hidden) {
      const annotation = peer.getBoundingClientRect();
      const left = bounds.left + panel.offsetLeft, right = left + panel.offsetWidth;
      const baselineBottom = bounds.bottom - bottom;
      const baselineHeight = height;
      if (right > annotation.left - 8 && left < annotation.right + 8 && baselineBottom > annotation.top - 8 && baselineBottom - baselineHeight < annotation.bottom + 8) {
        const above = Math.max(0, annotation.top - bounds.top - 16);
        const below = Math.max(0, baselineBottom - annotation.bottom - 8);
        if (above >= baselineHeight || above >= below) {
          available = above;
          shift = Math.min(0, annotation.top - 8 - baselineBottom);
        } else {
          // A toolbar dragged near the top leaves more room underneath it.
          available = below;
        }
      }
    }
    property('max-height', `${available}px`);
    property('--floating-offset-y', `${shift}px`);
  };
  const update = () => { if (!frame) frame = requestAnimationFrame(layout); };
  grip?.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    event.preventDefault();
    const bounds = viewport.getBoundingClientRect(), rect = panel.getBoundingClientRect();
    const start = { x: rect.left - bounds.left, y: rect.top - bounds.top, clientX: event.clientX, clientY: event.clientY };
    grip.setPointerCapture(event.pointerId);
    const move = (next: PointerEvent) => {
      position = { x: start.x + next.clientX - start.clientX, y: start.y + next.clientY - start.clientY };
      update();
    };
    const end = () => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', end);
      grip.removeEventListener('pointercancel', end);
      if (grip.hasPointerCapture(event.pointerId)) grip.releasePointerCapture(event.pointerId);
    };
    grip.addEventListener('pointermove', move, {signal});
    grip.addEventListener('pointerup', end, {signal});
    grip.addEventListener('pointercancel', end, {signal});
  }, {signal});
  const resize = new ResizeObserver(update); resize.observe(viewport); resize.observe(panel); resize.observe(peer); resize.observe(transport);
  const changes = new MutationObserver(update);
  changes.observe(peer, {attributes:true, attributeFilter:['hidden','style']});
  changes.observe(panel, {attributes:true, attributeFilter:['hidden']});
  window.addEventListener('resize', update, {signal});
  return { update, dispose() { resize.disconnect(); changes.disconnect(); if(frame) cancelAnimationFrame(frame); } };
}
