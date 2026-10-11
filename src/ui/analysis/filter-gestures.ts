/** Shared click / right-click / touch long-press input for chart and track filters. */
export function installFilterGestures(host: HTMLElement, signal: AbortSignal, apply: (button: HTMLButtonElement, solo: boolean) => void) {
  const buttonFor = (target: EventTarget | null) => target instanceof Element ? target.closest<HTMLButtonElement>('button') : null;
  let timer: ReturnType<typeof setTimeout> | undefined, touchStart: { id: number; x: number; y: number } | undefined, suppressClick = false;
  const cancel = () => { clearTimeout(timer); timer = undefined; touchStart = undefined; };
  host.addEventListener('click', event => {
    if (suppressClick) { suppressClick = false; event.preventDefault(); return; }
    const button = buttonFor(event.target); if (button) apply(button, false);
  }, { signal });
  host.addEventListener('contextmenu', event => {
    const button = buttonFor(event.target); if (!button) return;
    event.preventDefault();
    // Native touch context menus can follow our timer; handle each gesture once.
    if (suppressClick) return;
    if (touchStart) suppressClick = true;
    cancel(); apply(button, true);
  }, { signal });
  host.addEventListener('pointerdown', event => {
    cancel(); suppressClick = false;
    const button = buttonFor(event.target);
    if (!button || event.pointerType === 'mouse') return;
    touchStart = { id: event.pointerId, x: event.clientX, y: event.clientY };
    timer = setTimeout(() => { suppressClick = true; apply(button, true); cancel(); }, 500);
  }, { signal });
  host.addEventListener('pointermove', event => {
    if (touchStart?.id === event.pointerId && Math.hypot(event.clientX - touchStart.x, event.clientY - touchStart.y) > 10) cancel();
  }, { signal });
  for (const name of ['pointerup', 'pointercancel', 'pointerleave'] as const) host.addEventListener(name, event => {
    if (touchStart?.id === event.pointerId) cancel();
  }, { signal });
  signal.addEventListener('abort', cancel, { once: true });
}
