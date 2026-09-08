/** Browser acceptance tests explicitly choose a visitor, just like a first-time user. */
export async function chooseTestGuest(page) {
  const health = await page.request.get(new URL('/api/health', page.url()).href).then(r => r.json());
  if (!health.capabilities?.admin || health.actor) return;
  await page.locator('#identity-welcome [data-guest]').click();
  await page.locator('#identity-welcome').waitFor({state:'hidden'});
}
