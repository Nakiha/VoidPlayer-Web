/** Advance the complete health-poll interval while real localhost IO can settle.
 * A single virtual leap must not consume a pending real request's timeout. */
export async function advanceAdminPollClock(page, observe = () => {}) {
  await page.waitForLoadState('networkidle');
  for (let remaining = 10100; remaining > 0;) {
    const ms = Math.min(1000, remaining);
    observe(ms);
    await page.clock.runFor(ms);
    await page.waitForLoadState('networkidle');
    remaining -= ms;
  }
}
