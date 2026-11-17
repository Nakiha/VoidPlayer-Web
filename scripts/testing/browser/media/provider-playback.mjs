import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createFileProvider } from '../../../../examples/media-provider/server.mjs';
import { withBrowserFixture } from '../../browser-fixture.mjs';

const engine = process.argv[2] ?? 'webkit';
const provider = await createFileProvider('fixtures/video');
provider.listen(0,'127.0.0.1');
await once(provider,'listening');
try {
  const endpoint = 'http://127.0.0.1:' + provider.address().port;
  await withBrowserFixture({caseName:'provider-playback',engine,roots:[{id:'remote',provider:{endpoint}}]},async ({page,ready,url}) => {
    const builds = [], upstream = [];
    page.on('response',r => { if (r.url().includes('/frame-index/build') && r.status() === 202) builds.push(r.url()); });
    page.on('request',r => { if (r.url().startsWith(endpoint + '/')) upstream.push(r.url()); });
    await ready();
    await page.waitForFunction(async () => (await (await fetch('/api/library/browse?search=ci_h264_smoke')).json()).entries.length > 0);
    const listing = await (await fetch(url+'api/library/browse?search=ci_h264_smoke')).json(), entry = listing.entries[0];
    assert.equal(entry.storage,'provider');
    const call = (name,args) => page.evaluate(([name,args]) => window.voidPlayer.tools.find(t => t.name === name).execute(args),[name,args]);
    await call('load_library_item',{id:entry.id,slot:'A'});
    await page.waitForFunction(() => window.voidPlayer.getState().tracks[0]?.frame && !window.voidPlayer.getState().busy);
    await call('seek_review',{ptsUs:500000});
    const frame = await call('get_presented_frame',{slot:'A'});
    assert.ok(frame.picture && frame.normalizedMediaUs >= 400000,'seek presents a decoded frame');
    assert.ok(builds.some(url => url.includes('mp4-playback')),'player built the MP4 index on the server');
    assert.deepEqual(upstream,[],'provider is accessed exclusively by the service');
  });
} finally {
  provider.closeAllConnections();
  await new Promise(resolve => provider.close(resolve));
}
