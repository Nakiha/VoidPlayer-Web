/** One width budget owns all optional labels. Measure their expanded layout
 * before applying a final state; the output must never become the next input. */
export function installTopbarCompact(topbar: HTMLElement, signal: AbortSignal) {
  const primary = topbar.querySelector<HTMLElement>('.topbar-primary-actions');
  const utility = topbar.querySelector<HTMLElement>('.topbar-utility-actions');
  const view = topbar.querySelector<HTMLElement>('.view-controls');
  const steps = [
    ['compact-brand', '#brand-about'], ['compact-share', '#workspace-share'],
    ['compact-open', '#open'], ['compact-pixel', '#pixel-size'],
    ['compact-channel', '#channel-select'],
    ['compact-zoom', '#zoom-select-control'],
  ] as const;
  let frame = 0, microtask = false, lastInput = '';
  const sync = () => {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    if (signal.aborted) return;
    const style = getComputedStyle(topbar);
    const controls = [...topbar.querySelectorAll<HTMLElement>('button, input')];
    const input = JSON.stringify([topbar.clientWidth, topbar.textContent, style.font, style.columnGap,
      style.paddingInlineStart, style.paddingInlineEnd, style.getPropertyValue('--button-size'),
      ['--control-padding-inline', '--control-gap', '--text-sm', '--zoom-control-width', '--icon-size', '--toolbar-drag-width']
        .map(name => style.getPropertyValue(name)),
      controls.map(control => [control.hasAttribute('disabled'), control.hidden, getComputedStyle(control).font])]);
    if (input === lastInput) return;
    lastInput = input;
    const compact = new Set<string>();
    topbar.classList.add('topbar-measuring');
    try {
      const children = [...topbar.children].filter(child => getComputedStyle(child).display !== 'none');
      const number = (value: string) => Number.parseFloat(value) || 0;
      let required = number(style.paddingLeft) + number(style.paddingRight) + number(style.getPropertyValue('--toolbar-drag-width'))
        + Math.max(0, children.length - 1) * number(style.columnGap);
      for (const child of children) {
        if (child.classList.contains('toolbar-spacer')) continue;
        const childStyle = getComputedStyle(child);
        required += child.getBoundingClientRect().width + number(childStyle.marginLeft) + number(childStyle.marginRight);
      }
      for (const [name, selector] of steps) {
        // Restoring text needs a little clearance. A one-pixel resize around
        // the collapse point must not alternate the label on every drag frame.
        const clearance = topbar.classList.contains(name) ? 8 : 0;
        if (Math.ceil(required) + clearance <= topbar.clientWidth - 1) break;
        const control = topbar.querySelector<HTMLElement>(selector);
        if (!control || control.dataset.disabled === 'true' ||
            control.querySelector('input:not([hidden])')) continue;
        const rect = control.getBoundingClientRect();
        const saving = name === 'compact-brand'
          ? rect.width + number(getComputedStyle(control).marginLeft) + number(getComputedStyle(control).marginRight) + number(style.columnGap)
          : rect.width - rect.height;
        if (saving <= 0) continue;
        compact.add(name); required -= saving;
      }
    } finally { topbar.classList.remove('topbar-measuring'); }
    for (const [name] of steps) topbar.classList.toggle(name, compact.has(name));
  };
  const update = () => { if (!signal.aborted && !frame) frame = requestAnimationFrame(sync); };
  // Labels and disabled state can change during a session render. Reconcile
  // before paint instead of waiting for ResizeObserver's next animation frame.
  const zoomControl = topbar.querySelector('#zoom-select-control');
  const content = new MutationObserver(records => {
    // The zoom control has a fixed width. Its numeric label changes throughout a pinch.
    if (records.every(record => record.type !== 'attributes' && zoomControl?.contains(record.target))) return;
    if (microtask) return; microtask = true;
    queueMicrotask(() => { microtask = false; sync(); });
  });
  content.observe(topbar, { subtree: true, childList: true, characterData: true, attributes: true,
    attributeFilter: ['disabled', 'data-disabled', 'hidden'] });
  // Chrome can change the title bar's CSS width after animation-frame callbacks.
  // Reconcile the outer width before paint. Changes to the action groups can
  // also be caused by compaction itself, so keep them on the deferred path.
  const barResize = new ResizeObserver(sync);
  barResize.observe(topbar);
  const actionsResize = new ResizeObserver(update);
  if (primary) actionsResize.observe(primary);
  if (utility) actionsResize.observe(utility);
  if (view) actionsResize.observe(view);
  // Toggling the overlay can also change the drag reserve without resizing the bar.
  matchMedia('(display-mode: window-controls-overlay)').addEventListener('change', sync, { signal });
  window.addEventListener('resize', update, { signal });
  window.addEventListener('load', update, { signal });
  // Late font metrics can also change label widths without a resize event.
  const fontsChanged = () => { lastInput = ''; update(); };
  void document.fonts.ready.then(fontsChanged, () => {});
  document.fonts.addEventListener('loadingdone', fontsChanged, { signal });
  signal.addEventListener('abort', () => {
    barResize.disconnect();
    actionsResize.disconnect();
    content.disconnect();
    if (frame) cancelAnimationFrame(frame);
  }, { once: true });
  update();
}
