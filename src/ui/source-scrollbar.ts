/** Shared overlay scrollbar for the library list and settings panes.
 *
 * The native bar is hidden (the full-bleed frosted tools/foot would cover it
 * on every platform, each in its own way). The library thumb floats above both;
 * settings use an inset track below their fixed heading. The thumb
 * only handles dragging; all scrolling still happens on the list itself, so
 * keyboard, wheel, touch and infinite loading keep working untouched.
 */
export function installSourceScrollbar(initialList: HTMLElement, bar: HTMLElement, thumb: HTMLElement, signal: AbortSignal) {
  let list = initialList;
  const minThumb = 24;
  const idleMs = 1200;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let dragging = false;
  function metrics() {
    const max = list.scrollHeight - list.clientHeight;
    const trackHeight = bar.clientHeight;
    const height = Math.min(trackHeight, Math.max(minThumb, (trackHeight * list.clientHeight) / Math.max(1, list.scrollHeight)));
    return { can: max > 1 && trackHeight > 0, max, height, range: trackHeight - height };
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
    if (list.scrollHeight - list.clientHeight <= 1) { bar.hidden = true; bar.classList.remove('is-active'); return; }
    // A hidden rail has no clientHeight; reveal it before measuring its track.
    bar.hidden = false;
    const { can, max, height, range } = metrics();
    bar.hidden = !can;
    if (!can) { bar.classList.remove('is-active'); return; }
    const y = max > 0 ? (Math.max(0, Math.min(max, list.scrollTop)) / max) * range : 0;
    thumb.style.height = `${height}px`;
    thumb.style.transform = `translateY(${y}px)`;
  }
  list.addEventListener('scroll', poke, { signal, passive: true });
  const watcher = new ResizeObserver(update);
  watcher.observe(list);
  signal.addEventListener('abort', () => { clearTimeout(idleTimer); watcher.disconnect(); list.removeEventListener('scroll', poke); }, { once: true });
  bar.addEventListener('pointerenter', () => { if (!bar.hidden) { bar.classList.add('is-active'); clearTimeout(idleTimer); } }, { signal });
  bar.addEventListener('pointerleave', () => { if (!dragging) scheduleHide(); }, { signal });
  thumb.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    const { max, range } = metrics();
    if (!(max > 0)) return;
    event.preventDefault();
    dragging = true;
    bar.classList.add('is-active');
    clearTimeout(idleTimer);
    thumb.setPointerCapture(event.pointerId);
    const startY = event.clientY, startScroll = list.scrollTop;
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
  }, { signal });
  update();
  return { update, setTarget(next: HTMLElement) {
    if (next !== list) {
      list.removeEventListener('scroll', poke); watcher.unobserve(list);
      list = next; list.addEventListener('scroll', poke, { signal, passive: true }); watcher.observe(list);
    }
    update();
  } };
}
