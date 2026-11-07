/** Shared overlay scrollbar for library lists, columns and settings panes.
 *
 * The native bar is hidden (the full-bleed frosted tools/foot would cover it
 * on every platform, each in its own way). Library and settings rails are inset
 * around their fixed panels. The thumb
 * only handles dragging; all scrolling still happens on the list itself, so
 * keyboard, wheel, touch and infinite loading keep working untouched.
 */
export function installSourceScrollbar(initialList: HTMLElement, bar: HTMLElement, thumb: HTMLElement, signal: AbortSignal, options: { axis?: 'vertical' | 'horizontal'; enabled?(): boolean } = {}) {
  let list = initialList;
  const horizontal = options.axis === 'horizontal';
  const scroll = horizontal ? 'scrollLeft' : 'scrollTop';
  const extent = horizontal ? 'scrollWidth' : 'scrollHeight';
  const client = horizontal ? 'clientWidth' : 'clientHeight';
  const coordinate = (event: PointerEvent) => horizontal ? event.clientX : event.clientY;
  const minThumb = 24;
  const idleMs = 1200;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let dragging = false;
  let finishDrag: (() => void) | undefined;
  function metrics() {
    const max = Math.max(0,list[extent] - list[client]);
    const trackHeight = bar[client];
    const height = Math.min(trackHeight, Math.max(minThumb, (trackHeight * list[client]) / Math.max(1, list[extent])));
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
    if (options.enabled?.() === false || list[extent] - list[client] <= 1) { bar.hidden = true; bar.classList.remove('is-active'); return; }
    // A hidden rail has no clientHeight; reveal it before measuring its track.
    bar.hidden = false;
    const { can, max, height, range } = metrics();
    bar.hidden = !can;
    if (!can) { bar.classList.remove('is-active'); return; }
    const y = max > 0 ? (Math.max(0, Math.min(max, list[scroll])) / max) * range : 0;
    thumb.style[horizontal ? 'width' : 'height'] = `${height}px`;
    thumb.style.transform = `translate${horizontal ? 'X' : 'Y'}(${y}px)`;
    if (bar.getAttribute('role') === 'scrollbar') {
      bar.setAttribute('aria-valuemax',String(Math.round(max)));
      bar.setAttribute('aria-valuenow',String(Math.round(Math.max(0,Math.min(max,list[scroll])))));
    }
  }
  list.addEventListener('scroll', poke, { signal, passive: true });
  list.addEventListener('library-density-change',update,{signal});
  let resizeFrame = 0;
  const watcher = new ResizeObserver(() => {
    if (resizeFrame || signal.aborted) return;
    // Revealing/hiding an observed rail changes its size. Apply those writes
    // outside observer delivery to avoid WebKit's resize notification loop.
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = 0;
      if (!signal.aborted) update();
    });
  });
  watcher.observe(list);
  // Insets can resize the rail independently, e.g. when loading details expand
  // the floating library footer. Recompute thumb size and drag range with it.
  watcher.observe(bar);
  signal.addEventListener('abort', () => { finishDrag?.(); clearTimeout(idleTimer); cancelAnimationFrame(resizeFrame); watcher.disconnect(); list.removeEventListener('scroll', poke); }, { once: true });
  window.addEventListener('blur',() => finishDrag?.(),{signal});
  bar.addEventListener('pointerenter', () => { if (!bar.hidden) { bar.classList.add('is-active'); clearTimeout(idleTimer); } }, { signal });
  bar.addEventListener('pointerleave', () => { if (!dragging) scheduleHide(); }, { signal });
  bar.addEventListener('focus',poke,{signal});
  bar.addEventListener('keydown',event => {
    const previous=horizontal?'ArrowLeft':'ArrowUp', next=horizontal?'ArrowRight':'ArrowDown';
    if (![previous,next,'Home','End','PageUp','PageDown'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const direction=event.key===previous||event.key==='PageUp'?-1:1;
    list[scroll]=event.key==='Home'?0:event.key==='End'?metrics().max:list[scroll]+direction*(event.key.startsWith('Page')?list[client]*.8:40);
    poke();
  },{signal});
  bar.addEventListener('pointerdown', event => {
    if (event.button !== 0 || dragging || !horizontal && event.target !== thumb) return;
    const { max, range } = metrics();
    if (!(max > 0)) return;
    event.preventDefault(); event.stopPropagation();
    if (horizontal) bar.focus({preventScroll:true});
    if (event.target !== thumb && range > 0) {
      const box=bar.getBoundingClientRect(), origin=horizontal?box.left:box.top;
      list[scroll]=(coordinate(event)-origin-metrics().height/2)/range*max; update();
    }
    dragging = true;
    bar.classList.add('is-active');
    clearTimeout(idleTimer);
    thumb.setPointerCapture(event.pointerId);
    const startY = coordinate(event), startScroll = list[scroll];
    const move = (moveEvent: PointerEvent) => {
      if (range <= 0 || moveEvent.pointerId !== event.pointerId) return;
      list[scroll] = startScroll + ((coordinate(moveEvent) - startY) / range) * max;
    };
    const up = () => {
      dragging = false; finishDrag = undefined;
      thumb.removeEventListener('pointermove', move);
      thumb.removeEventListener('pointercancel', up);
      thumb.removeEventListener('pointerup', up);
      thumb.removeEventListener('lostpointercapture', up);
      if (thumb.hasPointerCapture(event.pointerId)) thumb.releasePointerCapture(event.pointerId);
      if (!signal.aborted) scheduleHide();
    };
    thumb.addEventListener('pointermove', move);
    thumb.addEventListener('pointercancel', up);
    thumb.addEventListener('pointerup', up);
    thumb.addEventListener('lostpointercapture', up);
    finishDrag = up;
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
