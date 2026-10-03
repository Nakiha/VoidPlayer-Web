// Keep an insecure, non-localhost browser origin while routing fixture bytes
// to the owned loopback service. System proxies/DNS cannot intercept the fake
// hostname. HTTPS never matches this route and still uses real certificate trust.
export async function routeInsecureTestOrigin(page, hostname = 'voidplayer.test') {
  await page.route(url => url.protocol === 'http:' && url.hostname === hostname, async route => {
    const request = route.request(), url = new URL(request.url()), host = url.host;
    url.hostname = '127.0.0.1';
    const response = await page.request.fetch(url.href, {
      method: request.method(), headers: { ...request.headers(), host },
      data: request.postDataBuffer() ?? undefined, maxRedirects: 0,
    });
    await route.fulfill({ response });
  });
}
