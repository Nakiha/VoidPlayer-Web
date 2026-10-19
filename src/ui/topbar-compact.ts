/** 顶栏主操作按钮按真实可用宽度折叠：只要放得下就保留带文字的大按钮，
 *  而不是按窗口宽度猜阈值——窗口够宽但顶栏仍塞不下时才逐级收起文字。 */
export function installTopbarCompact(topbar: HTMLElement, signal: AbortSignal) {
  const primary = topbar.querySelector<HTMLElement>('.topbar-primary-actions');
  const utility = topbar.querySelector<HTMLElement>('.topbar-utility-actions');
  const view = topbar.querySelector<HTMLElement>('.view-controls');
  let frame = 0;
  const sync = () => {
    frame = 0;
    if (signal.aborted) return;
    // 同一帧内先按展开测量，放不下再逐级折叠；中间状态不上屏，不会闪烁。
    topbar.classList.remove('compact-share', 'compact-open');
    if (topbar.scrollWidth <= topbar.clientWidth + 1) return;
    topbar.classList.add('compact-share');
    if (topbar.scrollWidth <= topbar.clientWidth + 1) return;
    topbar.classList.add('compact-open');
  };
  const update = () => { if (!frame) frame = requestAnimationFrame(sync); };
  const resize = new ResizeObserver(update);
  resize.observe(topbar);
  if (primary) resize.observe(primary);
  if (utility) resize.observe(utility);
  // Zoom / pixel-size / channel labels fill in after a source loads and widen
  // this group without resizing the topbar itself. Measure it directly so the
  // settings button is not pushed past the viewport.
  if (view) resize.observe(view);
  window.addEventListener('resize', update, { signal });
  window.addEventListener('load', update, { signal });
  // Late font metrics can also change label widths without a resize event.
  void document.fonts.ready.then(update, () => {});
  signal.addEventListener('abort', () => { resize.disconnect(); if (frame) cancelAnimationFrame(frame); }, { once: true });
  update();
}
