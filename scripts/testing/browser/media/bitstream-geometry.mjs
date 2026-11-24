import assert from 'node:assert/strict';
import { mkdir, writeFile, copyFile, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { withBrowserFixture } from '../../browser-fixture.mjs';
import { repositoryRoot } from '../../manifest.mjs';
import { predictionStride, readPrediction } from '../../../../shared/analysis/bitstream/predictions.ts';
const engine = process.argv[2] ?? 'webkit';
const generatedOnly = process.argv.includes('--generated-only');
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
for (const [width, height] of [[128, 96], [64, 48]]) ff([
    '-f', 'lavfi', '-i', `color=gray:size=${width}x${height}:rate=5:duration=1`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-x264-params', 'bframes=0:keyint=5', path.join(directory, `hover-${width}.mp4`),
]);
const interInputs = { A: 'h266_10s_1920x1080.mp4', B: 'h265_10s_1920x1080.mp4' };
if (!generatedOnly)
    for (const name of Object.values(interInputs)) await copyFile(path.join(repositoryRoot, 'fixtures/video', name), path.join(directory, name));
const caseName = generatedOnly ? 'bitstream-geometry-generated' : 'bitstream-geometry';
await withBrowserFixture({ caseName, engine, timeoutMs: engine==='chromium'?1200000:300000, roots: [directory], pageOptions: { viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 } }, async ({ page, ready, artifact, checkpoint }) => {
    await ready();
    page.setDefaultTimeout(45000);
    await page.addStyleTag({content:'.geometry-raw-capture .video-card:has(#stage-A){clip-path:none!important}.geometry-raw-capture .video-card:not(:has(#stage-A)),.geometry-raw-capture #bitstream-overlay-A,.geometry-raw-capture #bitstream-hover-A,.geometry-raw-capture #divider,.geometry-raw-capture .analysis-card{visibility:hidden!important}'});
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
                await page.locator('#bitstream-mode [data-mode="sizes"]').click();
                const sizeFill = page.locator('#bitstream-size-fill');
                if (await sizeFill.getAttribute('aria-pressed') === 'true') await sizeFill.click();
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
                        await page.evaluate(()=>document.body.classList.add('geometry-raw-capture'));
                        await page.evaluate(()=>{window.voidPlayer.setViewport({offsetX:3.26});window.voidPlayer.setViewport({offsetX:3.25});});
                        await page.evaluate(()=>new Promise(requestAnimationFrame));
                        const shot=await page.locator('#stage-A .frame-presentation').screenshot();
                        await page.evaluate(()=>document.body.classList.remove('geometry-raw-capture'));
                        const pixels = await page.evaluate(async ({ rotation,bytes }) => {
                            const box = document.querySelector('#image-A').getBoundingClientRect();
                            const projected = (x, y) => {
                                let u = (x - 8) / 48, v = (y - 4) / 48;
                                if (rotation === 90)
                                    [u, v] = [1 - v, u];
                                else if (rotation === 270)
                                    [u, v] = [v, 1 - u];
                                return { x: box.x + u * box.width, y: box.y + v * box.height };
                            };
                            const c = document.querySelector('#stage-A .frame-presentation'), rect = c.getBoundingClientRect(), copy = new OffscreenCanvas(c.width,c.height), video = copy.getContext('2d');
                            const bitmap=await createImageBitmap(new Blob([new Uint8Array(bytes)],{type:'image/png'}));video.drawImage(bitmap,0,0);bitmap.close();
                            const overlay = document.querySelector('#bitstream-overlay-A'), o = overlay.getBoundingClientRect(), ctx = overlay.getContext('2d');
                            const read = (p) => {
                                return [...video.getImageData(Math.floor((p.x-rect.x)*c.width/rect.width),Math.floor((p.y-rect.y)*c.height/rect.height),1,1).data];
                            };
                            const alpha = p => ctx.getImageData(Math.floor((p.x - o.x) * overlay.width / o.width), Math.floor((p.y - o.y) * overlay.height / o.height), 1, 1).data[3];
                            // x=32 is a coded block edge; y=28 is inside a block. At 8x both
                            // points stay near the center, so the readback remains in the viewport.
                            const edge = projected(32, 28), hit = projected(31, 28);
                            return { aspect: box.width / box.height, white: read(hit), black: read(projected(33, 28)), edgeAlpha: alpha(edge), insideAlpha: alpha(hit), hit,
                                edge, overlayRect: { x: o.x, y: o.y, width: o.width, height: o.height }, overlayHidden: overlay.hidden, overlayParent: overlay.parentElement.id, clip: getComputedStyle(document.querySelector('#stage-A').closest('.video-card')).clipPath };
                        }, { rotation,bytes:[...shot] });
                        assert.ok(Math.abs(pixels.aspect - (rotation ? .5 : 2)) < .01, 'display aspect includes SAR and rotation');
                        assert.ok(pixels.white.slice(0, 3).every(v => v > 220), `white stripe maps to coded x=31: ${JSON.stringify(pixels)}`);
                        assert.ok(pixels.black.slice(0, 3).every(v => v < 25), `black stripe maps to coded x=33 (${mode}/${zoom}): ${JSON.stringify(pixels)}`);
                        assert.ok(pixels.edgeAlpha > 0, `coded edge mismatch ${mode}/${zoom}: ${JSON.stringify(pixels)}`);
                        assert.equal(pixels.insideAlpha, 0, 'block interior has no stray grid line');
                        assert.equal(pixels.overlayParent, 'stage-A');
                        if (mode === 'split')
                            assert.notEqual(pixels.clip, 'none', 'overlay shares the video split clip');
                        // Use the unclipped track for pointer input; split clips remain checked above.
                        if (mode === 'side-by-side') {
                            await page.locator('#stage-A').dispatchEvent('pointermove', { clientX: pixels.hit.x, clientY: pixels.hit.y });
                            const tooltip = page.locator('.bitstream-hit-tooltip:visible');
                            await tooltip.waitFor({ state: 'visible' });
                            const block = result.blocks.find(b => b.x <= 31 && b.x + b.width > 31 && b.y <= 28 && b.y + b.height > 28);
                            assert.equal(await tooltip.locator('[data-field=position]').textContent(), `${block.x}, ${block.y}`);
                            assert.equal(await tooltip.locator('[data-field=size]').textContent(), `${block.width}×${block.height}`);
                            const edge = page.locator('#bitstream-hover-A .analysis-picture-hover-edge');
                            await edge.waitFor({state:'visible'});
                            const bounds = await edge.boundingBox();
                            assert.ok(pixels.hit.x >= bounds.x && pixels.hit.x <= bounds.x + bounds.width &&
                                pixels.hit.y >= bounds.y && pixels.hit.y <= bounds.y + bounds.height, 'rotated block outline encloses the hover point');
                            await page.locator('#stage-A').dispatchEvent('pointerleave');
                            await edge.waitFor({state:'hidden'});
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
        const shot=await page.locator('#stage-A .frame-presentation').screenshot();
        const pixels = await page.evaluate(async ({rotation,bytes}) => {
            const box = document.querySelector('#image-A').getBoundingClientRect();
            const c = document.querySelector('#stage-A .frame-presentation'), r = c.getBoundingClientRect(), copy = new OffscreenCanvas(c.width,c.height), video = copy.getContext('2d');
                            const bitmap=await createImageBitmap(new Blob([new Uint8Array(bytes)],{type:'image/png'}));video.drawImage(bitmap,0,0);bitmap.close();
            const read = x => {
                let u = (x - 8) / 48, v = .5;
                if (rotation === 90)
                    [u, v] = [1 - v, u];
                else if (rotation === 270)
                    [u, v] = [v, 1 - u];
                return [...video.getImageData(Math.floor((box.x+box.width*u-r.x)*c.width/r.width),Math.floor((box.y+box.height*v-r.y)*c.height/r.height),1,1).data];
            };
            return { white: read(24), black: read(40), aspect: box.width / box.height };
        }, {rotation,bytes:[...shot]});
        assert.ok(pixels.white.slice(0, 3).every(v => v > 220), JSON.stringify(pixels));
        assert.ok(pixels.black.slice(0, 3).every(v => v < 25), JSON.stringify(pixels));
        assert.ok(Math.abs(pixels.aspect - (rotation ? .5 : 2)) < .01);
        rows.push({ input: 'local', decoding: 'software-rgba', rotation, token, pixels });
    }
    await call('remove_review_track', {slot:'A'});
    await call('remove_review_track', {slot:'B'});
    await call('set_review_color_mode', {mode:'reference'});
    await call('set_reference_decode', {decoder:'software', depth:2});
    await page.evaluate(() => window.voidPlayer.setViewport({mode:'side-by-side', arrangement:'horizontal', pixelSize:'uniform', zoom:1, offsetX:0, offsetY:0}));
    const analyses = {};
    for (const [slot, width] of [['A', 128], ['B', 64]]) {
        const name = `hover-${width}.mp4`;
        if (slot === 'A') await page.locator('#file-A').setInputFiles(path.join(directory, name));
        else await call('load_library_item', {slot, id: library.entries.find(e => e.name === name).id});
        await page.waitForFunction(slot => {
            const state = window.voidPlayer.getState();
            return !state.busy && state.tracks.some(t => t.slot === slot && t.frame && !t.failure);
        }, slot);
        analyses[slot] = await call('request_bitstream_analysis', {slot});
        assert.equal(analyses[slot].confidence, 'exact');
        if (!await page.locator('#analysis-overlay-panel').isVisible()) await page.locator('#toggle-analysis-overlay').click();
        const toggle = page.locator(`#bitstream-tracks [data-slot="${slot}"]`);
        if (await toggle.getAttribute('aria-pressed') !== 'true') await toggle.click();
        await page.locator(`#bitstream-overlay-${slot}`).waitFor({state:'visible'});
    }
    const boundaries = page.locator('#bitstream-boundaries'), stage = page.locator('#stage-A');
    if (await boundaries.getAttribute('aria-pressed') !== 'true') await boundaries.click();
    const image = slot => page.locator(`#image-${slot}`).boundingBox();
    const edge = slot => page.locator(`#bitstream-hover-${slot} .analysis-picture-hover-edge`);
    const card = page.locator('.bitstream-hit-tooltip');
    const detail = slot => card.locator(`.bitstream-hit-track[data-slot="${slot}"]`);
    const draws = () => page.locator('.analysis-picture-overlay:visible').evaluateAll(canvases => canvases.map(c => c.analysisMetrics.draws));
    const imageA = await image('A');
    const point = {clientX:imageA.x + imageA.width * 88 / 128, clientY:imageA.y + imageA.height * 53 / 96};
    const initialDraws = await draws();
    await stage.dispatchEvent('pointermove', point);
    await edge('A').waitFor({state:'visible'});
    await edge('B').waitFor({state:'visible'});
    assert.deepEqual(await draws(), initialDraws, 'hover does not repaint the block grid');
    assert.deepEqual(await card.locator('.bitstream-hit-track').evaluateAll(rows => rows.map(row => row.dataset.slot)), ['A', 'B']);
    const pickPeer = async () => {
        const a = await image('A'), b = await image('B'), peer = analyses.B;
        const x = (point.clientX - a.x - a.width / 2 + b.width / 2) * peer.width / b.width;
        const y = (point.clientY - a.y - a.height / 2 + b.height / 2) * peer.height / b.height;
        return {b, peer, block:peer.blocks.find(block => x >= block.x && x < block.x + block.width &&
            y >= block.y && y < block.y + block.height)};
    };
    async function verifyPeer() {
        const {b, peer, block} = await pickPeer();
        assert.ok(block, 'the corresponding point hits a block on the smaller track');
        const expected = { x: b.x + block.x / peer.width * b.width, y: b.y + block.y / peer.height * b.height,
            width: block.width / peer.width * b.width, height: block.height / peer.height * b.height };
        await edge('B').evaluate((element, rect) => new Promise((resolve, reject) => {
            let remaining = 45;
            const check = () => {
                const box = element.getBoundingClientRect();
                if (Object.keys(rect).every(key => Math.abs(rect[key] - box[key]) < 1)) resolve();
                else if (--remaining) requestAnimationFrame(check);
                else reject(Error(`Peer outline ${JSON.stringify(box)} expected ${JSON.stringify(rect)}`));
            };
            check();
        }), expected);
        assert.equal(await detail('B').locator('[data-field=position]').textContent(), `${block.x}, ${block.y}`);
        assert.equal(await detail('B').locator('[data-field=size]').textContent(), `${block.width}×${block.height}`);
        assert.equal(await detail('B').locator('[data-field=bits]').textContent(), `${block.bits} bit · ${block.bits / 8} B`);
        return block;
    }
    const uniform = await verifyPeer();
    await page.evaluate(() => window.voidPlayer.setViewport({pixelSize:'fill'}));
    await page.waitForFunction(() => {
        const a = document.querySelector('#image-A').getBoundingClientRect();
        const b = document.querySelector('#image-B').getBoundingClientRect();
        return Math.abs(a.width - b.width) < 1;
    });
    const fill = await verifyPeer();
    assert.notEqual(fill.x, uniform.x, 'changing pixel size updates the peer block with a stationary pointer');
    await page.evaluate(() => window.voidPlayer.setViewport({pixelSize:'uniform'}));
    await stage.dispatchEvent('pointermove', {clientX:imageA.x + imageA.width * .88, clientY:point.clientY});
    await edge('A').waitFor({state:'visible'});
    await edge('B').waitFor({state:'hidden'});
    await detail('B').waitFor({state:'detached'});
    await detail('A').waitFor({state:'visible'});
    await stage.dispatchEvent('pointermove', point);
    await edge('B').waitFor({state:'visible'});
    await boundaries.evaluate(button => button.click());
    await edge('A').waitFor({state:'hidden'});
    await edge('B').waitFor({state:'hidden'});
    await detail('A').waitFor({state:'visible'});
    await detail('B').waitFor({state:'visible'});
    await boundaries.evaluate(button => button.click());
    await edge('B').waitFor({state:'visible'});
    await stage.dispatchEvent('pointerleave');
    await edge('A').waitFor({state:'hidden'});
    await edge('B').waitFor({state:'hidden'});
    await card.waitFor({state:'hidden'});
    const hoverTrack = async slot => {
        const box = await image(slot);
        await page.locator(`#stage-${slot}`).dispatchEvent('pointermove', {clientX: box.x + box.width / 2, clientY: box.y + box.height / 2});
        await detail(slot).waitFor({state:'visible'});
    };
    await page.emulateMedia({colorScheme:'dark'});
    await hoverTrack('B');
    assert.equal(await card.count(), 1, 'linked overlays share one tooltip');
    const background = badge => badge.evaluate(element => getComputedStyle(element).backgroundColor);
    for (const [slot, width] of [['A', 128], ['B', 64]]) {
        assert.equal(await detail(slot).locator('.analysis-card-track-name').textContent(), `hover-${width}.mp4`);
        const color = await background(detail(slot).locator('.slot'));
        assert.equal(color, await background(page.locator(`#bitstream-tracks [data-slot="${slot}"] .slot`)));
        assert.equal(await edge(slot).evaluate(element => getComputedStyle(element).outlineColor), color, `track ${slot} uses its badge color`);
    }
    assert.ok(await card.evaluate(element => {
        const label = getComputedStyle(element.querySelector('[data-label=position]'));
        const value = getComputedStyle(element.querySelector('[data-field=position]'));
        return Number(value.fontWeight) > Number(label.fontWeight) && value.color !== label.color;
    }), 'block values have stronger contrast and weight than labels');
    const compact = await card.boundingBox();
    assert.ok(compact.width < 300 && compact.height < 140, `compact two-track card ${JSON.stringify(compact)}`);
    await card.screenshot({path:artifact('block-hover-dark.png')});
    const peerToggle = page.locator('#bitstream-tracks [data-slot="A"]');
    await peerToggle.evaluate(button => button.click());
    await detail('A').waitFor({state:'detached'});
    await detail('B').waitFor({state:'visible'});
    await peerToggle.evaluate(button => button.click());
    await detail('A').waitFor({state:'visible'});
    await page.locator('#stage-B').dispatchEvent('pointerleave');
    await card.waitFor({state:'hidden'});
    await page.locator('#bitstream-close').evaluate(button => button.click());
    await page.emulateMedia({colorScheme:'light'});
    await page.setViewportSize({width:275,height:700});
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await hoverTrack('A');
    assert.ok(await card.evaluate(element => {
        const card = element.getBoundingClientRect(), viewport = element.parentElement.getBoundingClientRect();
        const time = element.querySelector('time').getBoundingClientRect(), name = element.querySelector('.analysis-card-track-name').getBoundingClientRect();
        return card.left >= viewport.left + 7 && card.right <= viewport.right - 7 && card.bottom <= viewport.bottom - 7 &&
            Math.abs(time.top + time.height / 2 - name.top - name.height / 2) < 1 && element.scrollWidth <= element.clientWidth;
    }), 'narrow cards keep the time on the header line without overflowing the viewport');
    await card.screenshot({path:artifact('block-hover-narrow-light.png')});
    rows.push({input:'local-and-library', kind:'linked-hover', uniform, fill, compact});
    if (generatedOnly) {
        await writeFile(artifact('geometry.json'), JSON.stringify(rows, null, 2));
        console.log(`PASS ${engine}: cropped and rotated frames, RGBA fallback and linked hover using generated fixtures`);
        return;
    }
    await page.setViewportSize({width:1280,height:900});
    await page.emulateMedia({colorScheme:'dark'});
    for (const slot of ['A', 'B']) await call('remove_review_track', {slot});
    for (const [slot, name] of Object.entries(interInputs)) {
        checkpoint('open-prediction-fixture', {slot, name});
        if (slot === 'A') await page.locator('#file-A').setInputFiles(path.join(directory, name));
        else await call('load_library_item', {slot, id:library.entries.find(e => e.name === name).id});
        await page.waitForFunction(slot => {
            const state = window.voidPlayer.getState();
            const track = state.tracks.find(t => t.slot === slot);
            if (track?.failure) throw new Error(JSON.stringify(track.failure));
            return !state.busy && track?.frame;
        }, slot);
    }
    await call('seek_review', {ptsUs:66667});
    const inter = {};
    for (const slot of ['A', 'B']) {
        checkpoint('load-inter-prediction', {slot});
        const answer = await call('request_bitstream_analysis', {slot, product:'prediction-inter'});
        const bytes = Uint8Array.from(Buffer.from(answer.payloadBase64, 'base64')), view = new DataView(bytes.buffer);
        assert.equal(bytes.length / predictionStride('prediction-inter'), answer.recordCount);
        inter[slot] = Array.from({length:answer.recordCount}, (_, index) => readPrediction(view, 'prediction-inter', index));
        if (!await page.locator('#analysis-overlay-panel').isVisible()) await page.locator('#toggle-analysis-overlay').click();
        const toggle = page.locator(`#bitstream-tracks [data-slot="${slot}"]`);
        if (await toggle.getAttribute('aria-pressed') !== 'true') await toggle.evaluate(button => button.click());
        await page.locator(`#bitstream-overlay-${slot}`).waitFor({state:'visible'});
    }
    const drawer = page.locator('#bitstream-frame-inspector'), fold = page.locator('#bitstream-inspect-frame');
    if (await fold.getAttribute('aria-expanded') !== 'true') await fold.click();
    await drawer.waitFor({state:'visible'});
    async function downloadFrame() {
        const [download] = await Promise.all([page.waitForEvent('download', {timeout:15000}), drawer.locator('[data-export]').click()]);
        return JSON.parse(await readFile(await download.path(), 'utf8'));
    }
    assert.equal(await drawer.locator('select, input[type="checkbox"]').count(), 0, 'frame inspector uses project menus without export toggles');
    for (const slot of ['A', 'B']) {
        checkpoint('export-frame-with-inter-prediction', {slot});
        await drawer.locator('#bitstream-inspect-track').click();
        await page.locator(`#bitstream-inspect-track-menu:popover-open [data-value="${slot}"]`).click();
        if (slot === 'B') {
            const requests = '**/bitstream-analysis/requests*';
            const failPrediction = route => route.request().method() === 'POST' && route.request().postDataJSON()?.target?.product === 'prediction-inter' ?
                route.fulfill({status:429,json:{reason:{code:'resource-limit',message:'Injected prediction budget failure'}}}) : route.continue();
            await page.route(requests, failPrediction);
            try {
                const partial = await downloadFrame();
                assert.equal(partial.statistics.blockCount, partial.blocks.length);
                assert.equal(partial.predictionInter, undefined);
                assert.match(await drawer.locator('[data-export-status]').textContent(), /已导出块明细/);
            } finally { await page.unroute(requests, failPrediction); }
        }
        const exported = await downloadFrame();
        const token = await call('get_presented_frame', {slot});
        assert.equal(exported.slot, slot);
        assert.equal(exported.statistics.blockCount, exported.blocks.length);
        assert.deepEqual(exported.predictionInter, inter[slot]);
        assert.deepEqual(exported.frame.picture, token.picture);
    }
    await page.locator('#bitstream-close').evaluate(button => button.click());
    const tokens = {};
    for (const slot of ['A', 'B']) tokens[slot] = await call('get_presented_frame', {slot});
    const visible = slot => tokens[slot].geometry.visibleRect;
    const a = await image('A'), b = await image('B');
    const labelOf = record => [record?.merge && 'Merge', record?.mmvd && 'MMVD', record?.ciip && 'CIIP',
        record?.gpmPartition != null && 'GPM'].filter(Boolean);
    for (const tool of ['MMVD', 'CIIP', 'GPM', 'Merge', null]) {
        checkpoint('hover-inter-prediction', {tool});
        const record = inter.A.find(r => tool ? labelOf(r).at(-1) === tool : labelOf(r).length === 0);
        assert.ok(record, `${tool} prediction region on VVC fixture`);
        const dx = a.width * ((record.x + record.width / 2 - visible('A').x) / visible('A').width - .5);
        const dy = a.height * ((record.y + record.height / 2 - visible('A').y) / visible('A').height - .5);
        const peerX = visible('B').x + visible('B').width * (dx / b.width + .5);
        const peerY = visible('B').y + visible('B').height * (dy / b.height + .5);
        const peer = inter.B.find(r => peerX >= r.x && peerX < r.x + r.width && peerY >= r.y && peerY < r.y + r.height);
        await stage.dispatchEvent('pointermove', {clientX: a.x + a.width / 2 + dx, clientY: a.y + a.height / 2 + dy});
        await page.waitForFunction(({labelsA, labelsB}) => ['A', 'B'].every((slot, i) => {
            const row = document.querySelector(`.bitstream-hit-tooltip:not([hidden]) [data-slot="${slot}"]`);
            const tags = row && [...row.querySelectorAll('[data-field=inter-tools] span')].map(n => n.textContent);
            return tags && tags.join(',') === [labelsA, labelsB][i].join(',');
        }), {labelsA:labelOf(record), labelsB:labelOf(peer)});
        const size = await card.boundingBox();
        assert.equal(size.width, compact.width);
        assert.equal(size.height, compact.height, 'tool badges stay within the existing prediction row');
        if (tool === 'GPM') await card.screenshot({path:artifact('inter-tools.png')});
    }
    await stage.dispatchEvent('pointerleave');
    await call('seek_review', {ptsUs:0});
    await hoverTrack('A');
    assert.deepEqual(await card.locator('[data-field=inter-tools] span').allTextContents(), [], 'changing frames clears old prediction badges');
    rows.push({kind:'inter-prediction-hover-export', interVvc:inter.A.length, interHevc:inter.B.length});
    await writeFile(artifact('geometry.json'), JSON.stringify(rows, null, 2));
    console.log(`PASS ${engine}: 12 analysis combinations × 4 viewports, linked hover across pixel modes, and 3 RGBA fallback rotations`);
});
