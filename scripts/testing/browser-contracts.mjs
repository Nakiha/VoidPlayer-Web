// UI waits observe completed behavior; they do not retry actions or change
// reduced-motion preferences, animation durations, or assertion deadlines.
export async function waitForDialogClosed(page, selector = '#settings', { invoker = '#settings-open', timeout = 30000 } = {}) {
  await page.waitForFunction(({ selector, invoker }) => {
    const dialog = document.querySelector(selector), button = invoker && document.querySelector(invoker);
    return !!dialog && !dialog.open && !dialog.hasAttribute('data-closing')
      && (!invoker || !!button && button.getAttribute('aria-expanded') !== 'true' && document.activeElement === button);
  }, { selector, invoker }, { timeout });
}

export async function settleAppearance(page, { timeout = 30000 } = {}) {
  // Let style changes and ResizeObserver work reach the animation registry.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.waitForFunction(() => document.getAnimations().every(animation =>
    !Number.isFinite(animation.effect?.getComputedTiming().endTime) || animation.playState !== 'running'), null, { timeout });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
