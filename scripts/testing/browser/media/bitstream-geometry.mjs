import assert from 'node:assert/strict';
import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { withBrowserFixture } from '../../browser-fixture.mjs';
import { repositoryRoot } from '../../manifest.mjs';
const engine = process.argv[2] ?? 'webkit';
const directory = path.join(repositoryRoot, '.run/analysis-geometry', engine);
await mkdir(directory, { recursive: true });
const ff = args => execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args]);
ff(['-f', 'lavfi', '-i', 'color=black:size=64x64:rate=5:duration=1', '-vf', 'drawbox=x=16:y=0:w=16:h=64:color=white:t=fill,setsar=2', '-c:v', 'libx264', '-x264-params', 'qp=17:aq-mode=0:mbtree=0:bframes=0:keyint=5', '-bsf:v', 'h264_metadata=crop_left=8:crop_right=8:crop_top=4:crop_bottom=12', path.join(directory, 'crop-encoded.mp4')]);
ff(['-i', path.join(directory, 'crop-encoded.mp4'), '-c', 'copy', path.join(directory, 'crop-0.mp4')]);
for (const rotation of [90, 270])
    ff(['-display_rotation', String(-rotation), '-i', path.join(directory, 'crop-0.mp4'), '-c', 'copy', path.join(directory, `crop-${rotation}.mp4`)]);
for (const rotation of [0, 90, 270])
    await copyFile(path.join(directory, `crop-${rotation}.mp4`), path.join(directory, `other-${rotation}.mp4`));
// Exercise the explicit swscale RGBA fallback separately from the analysis codec matrix.
ff(['-f', 'lavfi', '-i', 'color=black:size=64x64:rate=5:duration=1', '-vf', 'drawbox=x=16:y=0:w=16:h=64:color=white:t=fill,setsar=2,format=rgb24', '-c:v', 'libx264rgb', '-x264-params', 'qp=17:aq-mode=0:mbtree=0:bframes=0:keyint=5', '-bsf:v', 'h264_metadata=crop_left=8:crop_right=8:crop_top=4:crop_bottom=12', path.join(directory, 'rgb-encoded.mp4')]);
ff(['-i', path.join(directory, 'rgb-encoded.mp4'), '-c', 'copy', path.join(directory, 'rgb-0.mp4')]);
for (const rotation of [90, 270])
    ff(['-display_rotation', String(-rotation), '-i', path.join(directory, 'rgb-0.mp4'), '-c', 'copy', path.join(directory, `rgb-${rotation}.mp4`)]);
await withBrowserFixture({ caseName: 'bitstream-geometry', engine, roots: [directory], pageOptions: { viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 } }, async ({ page, ready, artifact }) => {
    await page.addInitScript(() => Object.defineProperty(navigator, 'gpu', { value: undefined, configurable: true }));
    await ready();
    if (await page.locator('#identity-welcome').isVisible())
        await page.locator('#identity-welcome [data-guest]').click();
    const call = (name, params = {}) => page.evaluate(async ({ name, params }) => window.voidPlayer.tools.find(t => t.name === name).execute(params), { name, params });
    const library = await call('list_library'), rows = [];
    for (const input of ['local', 'library'])
        for (const decoding of ['browser', 'software'])
            for (const rotation of [0, 90, 270]) {
                await call('remove_review_track', { slot: 'A' });
                await call('set_review_color_mode', { mode: decoding === 'software' ? 'reference' : 'browser' });
                if (decoding === 'software')
                    await call('set_reference_decode', { decoder: 'software', depth: 2 });
                const name = `crop-${rotation}.mp4`;
                if (input === 'local')
                    await page.locator('#file-A').setInputFiles(path.join(directory, name));
                else
                    await call('load_library_item', { slot: 'A', id: library.entries.find(e => e.name === name).id });
                await page.waitForFunction(() => { const s = window.voidPlayer.getState(); return !s.busy && s.tracks[0]?.frame; });
                const token = await call('get_presented_frame', { slot: 'A' });
                console.log(`${input}/${decoding}/${rotation}: frame identity`);
                await writeFile(artifact('player-log.json'), JSON.stringify(await call('get_review_logs', { limit: 200 }), null, 2));
                assert.ok(token.picture, 'real rotated/cropped playback retains exact AU identity');
                assert.equal(token.geometry.rotation, rotation);
                assert.deepEqual(token.geometry.visibleRect, { x: 8, y: 4, width: 48, height: 48 });
                const result = await call('request_bitstream_analysis', { slot: 'A' });
                assert.equal(result.confidence, 'exact');
                assert.equal(result.width, 64);
                assert.equal(result.height, 64);
                if (!await page.locator('#analysis-overlay-panel').isVisible())
                    await page.locator('#toggle-analysis-overlay').click();
                const toggle = page.locator('#bitstream-tracks [data-slot="A"]');
                if (await toggle.getAttribute('aria-pressed') !== 'true')
                    await toggle.click();
                await page.locator('#bitstream-mode [data-value="none"]').click();
                if (await page.locator('#bitstream-boundaries').getAttribute('aria-pressed') !== 'true') await page.locator('#bitstream-boundaries').click();
                await page.locator('#bitstream-overlay-A').waitFor({ state: 'visible' });
                // B gives split mode a real second track. The oracle below uses only fixture
                // coordinates and the displayed image box, never production mapping helpers.
                if (input === 'local')
                    await page.locator('#file-B').setInputFiles(path.join(directory, name));
                else
                    await call('load_library_item', { slot: 'B', id: library.entries.find(e => e.name === `other-${rotation}.mp4`).id });
                await page.waitForFunction(() => { const s = window.voidPlayer.getState(); return !s.busy && s.tracks.length === 2 && s.tracks.every(t => t.frame && !t.failure); });
                await page.locator('#bitstream-overlay-A').waitFor({ state: 'visible' });
                const checks = [];
                for (const mode of ['side-by-side', 'split'])
                    for (const zoom of [1, 8]) {
                        await page.evaluate(p => window.voidPlayer.setViewport(p), { mode, zoom, splitPos: .5, offsetX: 3.25, offsetY: -2.75 });
                        await page.evaluate(async () => { for (let i = 0; i < 5; i++)
                            await new Promise(requestAnimationFrame); });
                        await page.locator('#bitstream-overlay-A').waitFor({ state: 'visible' });
                        const pixels = await page.evaluate(({ rotation }) => {
                            const box = document.querySelector('#image-A').getBoundingClientRect();
                            const projected = (x, y) => {
                                let u = (x - 8) / 48, v = (y - 4) / 48;
                                if (rotation === 90)
                                    [u, v] = [1 - v, u];
                                else if (rotation === 270)
                                    [u, v] = [v, 1 - u];
                                return { x: box.x + u * box.width, y: box.y + v * box.height };
                            };
                            const c = document.querySelector('#stage-A .frame-presentation'), rect = c.getBoundingClientRect(), gl = c.getContext('webgl');
                            const overlay = document.querySelector('#bitstream-overlay-A'), o = overlay.getBoundingClientRect(), ctx = overlay.getContext('2d');
                            const read = (p) => {
                                const out = new Uint8Array(4);
                                gl.readPixels(Math.floor((p.x - rect.x) * c.width / rect.width), c.height - 1 - Math.floor((p.y - rect.y) * c.height / rect.height), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, out);
                                return [...out];
                            };
                            const alpha = p => ctx.getImageData(Math.floor((p.x - o.x) * overlay.width / o.width), Math.floor((p.y - o.y) * overlay.height / o.height), 1, 1).data[3];
                            // x=32 is a coded block edge; y=28 is inside a block. At 8x both
                            // points stay near the center, so the readback remains in the viewport.
                            const edge = projected(32, 28), hit = projected(31, 28);
                            return { aspect: box.width / box.height, white: read(hit), black: read(projected(33, 28)), edgeAlpha: alpha(edge), insideAlpha: alpha(hit), hit,
                                edge, overlayRect: { x: o.x, y: o.y, width: o.width, height: o.height }, overlayHidden: overlay.hidden, overlayParent: overlay.parentElement.id, glError: gl.getError(), clip: getComputedStyle(document.querySelector('#stage-A').closest('.video-card')).clipPath };
                        }, { rotation });
                        assert.ok(Math.abs(pixels.aspect - (rotation ? .5 : 2)) < .01, 'display aspect includes SAR and rotation');
                        assert.ok(pixels.white.slice(0, 3).every(v => v > 220), `white stripe maps to coded x=31: ${JSON.stringify(pixels)}`);
                        assert.ok(pixels.black.slice(0, 3).every(v => v < 25), 'black stripe maps to coded x=33');
                        assert.ok(pixels.edgeAlpha > 0, `coded edge mismatch ${mode}/${zoom}: ${JSON.stringify(pixels)}`);
                        assert.equal(pixels.insideAlpha, 0, 'block interior has no stray grid line');
                        assert.equal(pixels.glError, 0);
                        assert.equal(pixels.overlayParent, 'stage-A');
                        if (mode === 'split')
                            assert.notEqual(pixels.clip, 'none', 'overlay shares the video split clip');
                        // Use the unclipped track for pointer input; split clips remain checked above.
                        if (mode === 'side-by-side') {
                            await page.locator('#stage-A').dispatchEvent('pointermove', { clientX: pixels.hit.x, clientY: pixels.hit.y });
                            const tooltip = page.locator('.bitstream-hit-tooltip:visible');
                            await tooltip.waitFor({ state: 'visible' });
                            const block = result.blocks.find(b => b.x <= 31 && b.x + b.width > 31 && b.y <= 28 && b.y + b.height > 28);
                            await page.waitForFunction(expected => [...document.querySelectorAll('.bitstream-hit-tooltip')].some(e => !e.hidden && e.textContent.includes(expected)), `${block.x}, ${block.y} · ${block.width}×${block.height}`);
                        }
                        if (mode === 'split' && zoom === 8) {
                            const colors = [];
                            for (const splitPos of [.65, .35]) {
                                await page.evaluate(splitPos => window.voidPlayer.setViewport({ splitPos }), splitPos);
                                await page.evaluate(async () => { for (let i = 0; i < 5; i++)
                                    await new Promise(requestAnimationFrame); });
                                const png = await page.screenshot({ clip: { x: Math.floor(pixels.edge.x) - 1, y: Math.floor(pixels.edge.y) - 1, width: 3, height: 3 } });
                                colors.push(await page.evaluate(async (bytes) => {
                                    const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/png' }));
                                    const c = document.createElement('canvas');
                                    c.width = bitmap.width;
                                    c.height = bitmap.height;
                                    const ctx = c.getContext('2d');
                                    ctx.drawImage(bitmap, 0, 0);
                                    bitmap.close();
                                    const data = ctx.getImageData(0, 0, c.width, c.height).data;
                                    let cyan = 0;
                                    for (let i = 0; i < data.length; i += 4)
                                        cyan = Math.max(cyan, data[i + 2] - data[i]);
                                    return cyan;
                                }, [...png]));
                            }
                            assert.ok(colors[0] > 20 && colors[1] < 5, `actual screenshot clips A overlay at the split: ${colors}`);
                            pixels.splitScreenshotCyan = colors;
                        }
                        checks.push({ mode, zoom, ...pixels });
                    }
                await page.screenshot({ path: artifact(`${input}-${decoding}-${rotation}.png`) });
                rows.push({ input, decoding, rotation, token, blocks: result.blocks.length, checks });
                await call('remove_review_track', { slot: 'B' });
                await page.evaluate(() => window.voidPlayer.setViewport({ mode: 'side-by-side', zoom: 1, offsetX: 0, offsetY: 0 }));
            }
    for (const rotation of [0, 90, 270]) {
        await call('remove_review_track', { slot: 'A' });
        await call('set_review_color_mode', { mode: 'browser' });
        await page.locator('#file-A').setInputFiles(path.join(directory, `rgb-${rotation}.mp4`));
        await page.waitForFunction(() => { const s = window.voidPlayer.getState(); if (s.tracks[0]?.failure)
            throw Error(JSON.stringify(s.tracks[0].failure)); return !s.busy && s.tracks[0]?.frame; }, null, { timeout: 30000 });
        const token = await call('get_presented_frame', { slot: 'A' });
        assert.deepEqual(token.geometry.visibleRect, { x: 8, y: 4, width: 48, height: 48 });
        assert.equal(token.geometry.rotation, rotation);
        assert.equal(await page.locator('#canvas-A').getAttribute('data-color-contract'), 'rgba-resource', 'fixture exercises the RGBA presenter');
        const pixels = await page.evaluate(rotation => {
            const box = document.querySelector('#image-A').getBoundingClientRect();
            const c = document.querySelector('#stage-A .frame-presentation'), r = c.getBoundingClientRect(), gl = c.getContext('webgl');
            const read = x => {
                let u = (x - 8) / 48, v = .5;
                if (rotation === 90)
                    [u, v] = [1 - v, u];
                else if (rotation === 270)
                    [u, v] = [v, 1 - u];
                const out = new Uint8Array(4);
                gl.readPixels(Math.floor((box.x + box.width * u - r.x) * c.width / r.width), c.height - 1 - Math.floor((box.y + box.height * v - r.y) * c.height / r.height), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, out);
                return [...out];
            };
            return { white: read(24), black: read(40), aspect: box.width / box.height };
        }, rotation);
        assert.ok(pixels.white.slice(0, 3).every(v => v > 220), JSON.stringify(pixels));
        assert.ok(pixels.black.slice(0, 3).every(v => v < 25), JSON.stringify(pixels));
        assert.ok(Math.abs(pixels.aspect - (rotation ? .5 : 2)) < .01);
        rows.push({ input: 'local', decoding: 'software-rgba', rotation, token, pixels });
    }
    await writeFile(artifact('geometry.json'), JSON.stringify(rows, null, 2));
    console.log(`PASS ${engine}: 12 analysis combinations × 4 viewports and 3 RGBA fallback rotations`);
});
