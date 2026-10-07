import assert from 'node:assert/strict';

// Exercise the production scroller styles with a scrollable ancestor. The app
// normally locks that ancestor, which conceals escaped edge gestures as a hard
// stop. Headless wheel input checks routing, not the OS spring animation.
export async function checkScrollBoundary(page, selector) {
  const settle = () => page.evaluate(() => new Promise(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }));
  const scrollSettled = () => page.locator('[data-scroll-boundary-list]').evaluate(element => new Promise((resolve, reject) => {
    let previous = element.scrollTop, changed = performance.now();
    const deadline = changed + 3000;
    const sample = () => {
      const now = performance.now(), position = element.scrollTop;
      if (position !== previous) { previous = position; changed = now; }
      if (now - changed >= 200) resolve();
      else if (now >= deadline) reject(new Error('Scroll boundary probe did not settle'));
      else requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }));
  await page.locator(selector).evaluate(element => {
    const outer = document.createElement('div');
    outer.id = 'scroll-boundary-probe';
    outer.style.cssText = 'position:fixed;left:24px;top:24px;width:300px;height:260px;overflow:auto;z-index:2147483647;background:var(--surface-panel);';
    const before = document.createElement('div'), after = document.createElement('div');
    before.style.height = '120px'; after.style.height = '500px';
    // Preserve direct-parent selectors such as .settings-content > [role=tabpanel].
    const scope = element.parentElement.cloneNode(false), list = element.cloneNode(true);
    scope.removeAttribute('id');
    scope.style.cssText = 'position:relative;display:block;width:100%;height:220px;min-height:0;overflow:visible;margin:0;padding:0;';
    list.style.cssText = 'position:relative;display:block;flex:none;width:100%;height:220px;min-height:0;max-height:none;margin:0;';
    list.dataset.scrollBoundaryList = '';
    scope.append(list); outer.append(before, scope, after);
    (element.closest('dialog[open]') ?? document.body).append(outer);
    outer.scrollTop = 120;
  });
  const outer = page.locator('#scroll-boundary-probe');
  const list = outer.locator('[data-scroll-boundary-list]');
  try {
    await settle();
    const max = await list.evaluate(el => el.scrollHeight - el.clientHeight);
    assert.ok(max > 1, `${selector}: probe content is scrollable`);
    const box = await list.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (const edge of ['top', 'bottom']) {
      await list.evaluate((el, edge) => { el.scrollTop = edge === 'top' ? 0 : el.scrollHeight; }, edge);
      await settle();
      await page.mouse.wheel(0, edge === 'top' ? -180 : 180);
      await scrollSettled();
      assert.equal(await outer.evaluate(el => el.scrollTop), 120, `${selector}: ${edge} edge gesture stays in the list`);
    }
    await list.evaluate(el => { el.scrollTop = 0; });
    await settle();
    await page.mouse.wheel(0, 100);
    await page.waitForFunction(() => document.querySelector('[data-scroll-boundary-list]').scrollTop > 0);
    // WebKit on Linux reports the first fractional smooth-scroll step before
    // the wheel delta has finished. Compare the reverse gesture with its final
    // position, otherwise a successful reversal can still exceed that first step.
    await scrollSettled();
    const position = await list.evaluate(el => el.scrollTop);
    await page.mouse.wheel(0, -60);
    await page.waitForFunction(position => document.querySelector('[data-scroll-boundary-list]').scrollTop < position, position);
    await scrollSettled();
    assert.equal(await outer.evaluate(el => el.scrollTop), 120, `${selector}: ordinary scrolling stays in the list`);
  } finally {
    await outer.evaluate(el => el.remove());
  }
}
