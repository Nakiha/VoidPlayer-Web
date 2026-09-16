/** Hand-rolled overlay scrollbar for the library list.
 *
 * The native bar is hidden (the full-bleed frosted tools/foot would cover it
 * on every platform, each in its own way). This thumb floats above both and
 * only handles dragging; all scrolling still happens on the list itself, so
 * keyboard, wheel, touch and infinite loading keep working untouched.
 */
export function installSourceScrollbar(list: HTMLElement, bar: HTMLElement, thumb: HTMLElement, signal: AbortSignal) {
  const minThumb = 24;
  const idleMs = 1200;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let dragging = false;
  function metrics() {
    const max = list.scrollHeight - list.clientHeight;
    const height = Math.max(minThumb, (list.clientHeight * list.clientHeight) / Math.max(1, list.scrollHeight));
    return { can: max > 1, max, height };
  }
  function scheduleHide() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { if (!dragging) bar.classList.remove('is-active'); }, idleMs);
  }
  function poke() {
    const wasHidden = bar.hidden;
    update();
    if (bar.hidden) return;
    // Unhiding and fading in on the same frame skips the transition; let the
    // display change land first so opacity animates from 0.
    if (wasHidden) requestAnimationFrame(() => bar.classList.add('is-active'));
    else bar.classList.add('is-active');
    scheduleHide();
  }
  function update() {
    const { can, max, height } = metrics();
    bar.hidden = !can;
    if (!can) { bar.classList.remove('is-active'); return; }
    const y = max > 0 ? (list.scrollTop / max) * (list.clientHeight - height) : 0;
    thumb.style.height = `${height}px`;
    thumb.style.transform = `translateY(${y}px)`;
  }
  list.addEventListener('scroll', poke, { signal, passive: true });
  const watcher = new ResizeObserver(update);
  watcher.observe(list);
  signal.addEventListener('abort', () => { clearTimeout(idleTimer); watcher.disconnect(); }, { once: true });
  bar.addEventListener('pointerenter', () => { if (!bar.hidden) { bar.classList.add('is-active'); clearTimeout(idleTimer); } });
  bar.addEventListener('pointerleave', () => { if (!dragging) scheduleHide(); });
  thumb.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    const { max, height } = metrics();
    if (!(max > 0)) return;
    event.preventDefault();
    dragging = true;
    bar.classList.add('is-active');
    clearTimeout(idleTimer);
    thumb.setPointerCapture(event.pointerId);
    const startY = event.clientY, startScroll = list.scrollTop;
    const range = list.clientHeight - height;
    const move = (moveEvent: PointerEvent) => {
      if (range <= 0) return;
      list.scrollTop = startScroll + ((moveEvent.clientY - startY) / range) * max;
    };
    const up = () => {
      dragging = false;
      thumb.removeEventListener('pointermove', move);
      thumb.removeEventListener('pointercancel', up);
      thumb.removeEventListener('pointerup', up);
      scheduleHide();
    };
    thumb.addEventListener('pointermove', move);
    thumb.addEventListener('pointercancel', up);
    thumb.addEventListener('pointerup', up);
  });
  update();
  return { update };
}
