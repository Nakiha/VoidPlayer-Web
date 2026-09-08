/** Browser acceptance tests explicitly choose a visitor, just like a first-time user. */
export async function chooseTestGuest(page) {
  // Use Chromium/WebKit's origin, resolver and TLS trust, not Node's separate HTTP client.
  const health = await page.evaluate(async () => {
    const response = await fetch('/api/health');
    if (!response.ok) throw new Error(`Identity health failed: ${response.status}`);
    return response.json();
  });
  if (!health.capabilities?.admin || health.actor) return;
  await page.locator('#identity-welcome [data-guest]').click();
  await page.locator('#identity-welcome').waitFor({state:'hidden'});
}
