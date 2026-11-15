import { observePlaybackBenchmark } from '../../playback-diagnostics.mjs';
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { repositoryRoot } from "../../manifest.mjs";
import { playbackBenchmarksEnabled, assertBenchmarkCorrectness, verifyPlaybackPresentation } from "../../playback-presentation.mjs";
import { selectDiagrams } from '../controls.mjs';


export async function run(context) {
const { page, artifact, phase, engine, matrixRows, checkpointOnly, playbackProfile, errors, requests, rows, call, analyze, hideOverlay, setMode, stable, library } = context;

    for (const input of (checkpointOnly ? ["local-file"] : ["local-file", "library"]))
      for (const decoding of (checkpointOnly ? ["software"] : ["browser", "software"]))
        for (const row of matrixRows) {
          console.log(`${engine}: ${input}/${decoding}/${row.codec}`);
          await call("remove_review_track", { slot: "A" });
          await call("set_review_color_mode", {
            mode: decoding === "software" ? "reference" : "browser",
          });
          if (decoding === "software")
            await call("set_reference_decode", {
              decoder: "software",
              depth: 2,
            });
          const start = requests.length;
          if (input === "local-file")
            await page
              .locator("#file-A")
              .setInputFiles(
                path.join(repositoryRoot, "fixtures", row.fixtureDir ?? "video", row.fixture),
              );
          else
            await call("load_library_item", {
              id: library.entries.find((e) => e.name === row.fixture).id,
              slot: "A",
            });
          await stable();
          assert.equal(
            await page.locator(".analysis-picture-overlay").count(),
            0,
            "disabled analysis allocates no overlay",
          );
          assert.ok(
            !requests
              .slice(start)
              .some((r) => /voidplayer-analysis|local-worker/.test(r.url)),
            "disabled analysis does not load its worker or core",
          );
          assert.equal(await page.locator('#inspector-analysis-tab').count(),0,'left inspector contains only source information');
          if (row.container === 'mp4') {
            const {codecFeatures} = (await call('get_review_session')).tracks[0];
            assert.equal(codecFeatures.scope, 'initial-configuration');
            assert.equal(codecFeatures.format, {h264: 'avcC', hevc: 'hvcC', vvc: 'vvcC'}[row.codec]);
            assert.ok(codecFeatures.parameterSets.some(set => set.kind === 'SPS' && set.lumaBitDepth >= 8));
            assert.ok(codecFeatures.parameterSets.some(set => set.kind === 'PPS' && set.spsId !== undefined));
            assert.deepEqual((await call('export_review')).media[0].codecFeatures, codecFeatures);
          }
          if (decoding === 'browser' && row.codec === 'h264' && row.container === 'mp4') {
            const opened = requests.length;
            if (!await page.locator('#inspector-panel').isVisible()) await page.locator('#toggle-inspector').click();
            const details = page.locator('#inspect-coding-features');
            assert.equal(await details.evaluate(node => node.open), false);
            assert.equal(await details.locator('dd').count(), 0);
            await details.locator('summary').click();
            const {codecFeatures} = (await call('get_review_session')).tracks[0];
            const entropy = codecFeatures.parameterSets.find(set => set.kind === 'PPS').entropyCoding;
            await details.getByText(entropy, {exact: true}).waitFor({state: 'visible'});
            const changes = await details.evaluateHandle(node => {
              const observed = { count: 0, observer: new MutationObserver(records => { observed.count += records.length; }) };
              observed.observer.observe(node, {subtree: true, childList: true, characterData: true, attributes: true});
              return observed;
            });
            const lastField = await details.locator('dd').last().elementHandle();
            await verifyPlaybackPresentation(page, {minPlayingMs: 150}, {engine, caseName: 'inspector-coding-features', targetPtsUs: 0});
            await call('step_review', {direction: 1});
            await call('seek_review', {ptsUs: 0});
            assert.equal(await changes.evaluate(state => { state.observer.disconnect(); return state.count; }), 0, 'static features receive no playback mutations');
            await changes.dispose();
            assert.ok(await lastField.evaluate(node => node.isConnected && node.closest('details').open), 'frame changes retain the expanded fields');
            assert.ok(!requests.slice(opened).some(r => /voidplayer-analysis|local-worker|bitstream-analysis/.test(r.url)), 'inspecting coding features uses no deep analysis');
            await details.locator('summary').click();
            await page.locator('#toggle-inspector').click();
          }
          if (input === 'local-file' && decoding === 'browser' && row.codec === 'h264' && row.container === 'mp4') {
            await page.locator('#toggle-analysis').click();
            await selectDiagrams(page, 'nalu-size');
            await page.waitForFunction(() => {
              const state = window.voidPlayer.tools.find(t=>t.name==='get_bitstream_analysis_state').execute({slot:'A'});
              return state.state === 'ready' && state.stream?.pictures > 0;
            }, undefined, {timeout:60000});
            assert.equal((await call('get_bitstream_analysis_state', {slot:'A'})).reason, undefined, 'automatic viewport produces real output without errors');
            await page.locator('.bitstream-diagrams canvas').first().waitFor({state:'visible'});
            await selectDiagrams(page, 'references');
            await page.waitForFunction(() => window.voidPlayer.tools.find(t=>t.name==='get_bitstream_analysis_state').execute({slot:'A'}).state!=='pending', undefined, {timeout:60000});
            assert.notEqual((await call('get_bitstream_analysis_state')).state,'pending','automatic analysis reaches a terminal state before the next inspection');
            assert.equal(await page.locator('.analysis-picture-overlay').count(), 0);
            await selectDiagrams(page, 'overview');
            await page.locator('#toggle-analysis').click();
          }
          if (row.container === 'flv' || row.container === 'ts') {
            const prefixToken = await call('get_presented_frame', { slot: 'A' });
            const capability = (await call('get_analysis_capabilities'))[0].capability;
            if (capability.indexState === 'building') assert.equal(prefixToken.picture, null, 'growing FLV index cannot promise global PTS uniqueness');
            // An explicit indexed seek starts the shared metadata job. Analysis
            // payloads still use their own reader and no playback decoder.
            await call('seek_review', { ptsUs: 1000000 });
            await page.waitForFunction(() => window.voidPlayer.tools.find(t => t.name === 'get_analysis_capabilities').execute({})[0]?.capability.indexState === 'complete');
            await call('seek_review', { ptsUs: 0 }); await stable();
          }
          const token = await call("get_presented_frame", { slot: "A" });
          assert.ok(
            token.picture,
            `${engine}/${input}/${decoding}/${row.codec}: exact playback identity`,
          );
          const result = await call("request_bitstream_analysis", {
            slot: "A",
          });
          assert.equal(result.confidence, row.expected);
          if (input === 'local-file') {
            const parallel = await page.evaluate(() => crossOriginIsolated && typeof SharedArrayBuffer !== 'undefined' && navigator.hardwareConcurrency >= 2);
            assert.match(result.buildId, parallel ? /:mt-[0-9a-f]{16}$/ : /:refs-[0-9a-f]{16}$/, row.codec + ' local decoder build');
            const wasm = parallel ? 'voidplayer-analysis-mt.wasm' : 'voidplayer-analysis.wasm';
            assert.ok(requests.some(request => new URL(request.url).pathname.endsWith('/' + wasm)), 'local analysis fetched its WASM variant');
          }
          assert.deepEqual(result.picture, token.picture);
          assert.equal(result.sourcePtsUs, token.sourcePtsUs);
          assert.ok(result.blocks.length > 0);
          if (input === "library")
            assert.ok(
              !requests
                .slice(start)
                .some((r) =>
                  /voidplayer-analysis(?:-mt)?\.(js|wasm)|local-worker/.test(r.url),
                ),
              "library analysis loads no browser decoder",
            );
          else
            assert.ok(
              !requests
                .slice(start)
                .some(
                  (r) =>
                    r.method === "POST" && /bitstream-analysis/.test(r.url),
                ),
              "local files are never uploaded",
            );
          const second = await call("request_bitstream_analysis", {
            slot: "A",
          });
          assert.deepEqual(second.blocks, result.blocks);
          assert.equal(
            (await call("get_bitstream_analysis_state")).cacheHit,
            true,
          );
          if (row.container === 'mp4' && decoding === 'software') {
            const products = row.codec === 'h264' ? ['prediction-intra'] : ['prediction-intra', 'prediction-inter'];
            for (const product of products) {
              const prediction = await call('request_bitstream_analysis', {slot: 'A', product});
              const bytes = Buffer.from(prediction.payloadBase64, 'base64');
              assert.equal(prediction.product, product);
              assert.deepEqual(prediction.picture, result.picture);
              assert.equal(prediction.buildId, result.buildId);
              assert.equal(bytes.length, prediction.recordCount * (product === 'prediction-intra' ? 16 : 32));
              if (product === 'prediction-intra') assert.ok(prediction.recordCount > 0);
            }
            const blocks = await call('request_bitstream_analysis', {slot: 'A'});
            assert.deepEqual(blocks.blocks, result.blocks, 'predictions preserve the independent block cache');
          }
          if (
            input === "local-file" &&
            decoding === "browser" &&
            row.codec === "h264" && row.container === "mp4"
          ) {
            let release;
            const blocked = new Promise((r) => {
              release = r;
            });
            const pattern = "**/assets/controller-*.js";
            await page.route(pattern, async (route) => {
              await blocked;
              await route.continue();
            });
            const requested = page.waitForRequest(pattern, { timeout: 30000 });
            try {
              await analyze();
              await requested;
              await call("step_review", { direction: 1 });
              release();
              const cold = page.locator("#bitstream-overlay-A");
              await cold.waitFor({ state: "attached" });
              if (await cold.isVisible()) {
                const current = await call('get_presented_frame', {slot:'A'});
                assert.equal(await cold.getAttribute('data-picture'), JSON.stringify([
                  current.picture.sourceVersion,current.picture.stream,current.picture.configuration,current.picture.au,0,0,'frame',
                ]), 'lazy activation paints only the current picture, including automatic replacement analysis');
              }
            } finally {
              release();
              await page.unroute(pattern);
            }
            await hideOverlay();
            await call("seek_review", { ptsUs: 0 });
          }
          await analyze();
          const overlay = page.locator("#bitstream-overlay-A");
          await overlay.waitFor({ state: "visible" });
          assert.equal(await page.locator('#bitstream-tracks [data-slot="A"]').getAttribute('aria-pressed'),'true');
          assert.equal(
            await overlay.getAttribute("data-picture"),
            JSON.stringify([
              token.picture.sourceVersion,
              token.picture.stream,
              token.picture.configuration,
              token.picture.au,
              0,
              0,
              "frame",
            ]),
          );
          for (const mode of ["qp", "modes", "blocks"]) {
            await setMode(mode);
            assert.ok(await overlay.isVisible());
            if (
              input === "local-file" &&
              decoding === "browser" &&
              row.codec === "h264" && row.container === "mp4" &&
              mode === "qp"
            )
              await page.screenshot({ path: artifact("qp-overlay.png") });
          }
          const dimensions = await overlay.evaluate((c) => ({
            width: c.width,
            height: c.height,
            cssWidth: c.getBoundingClientRect().width,
          }));
          assert.ok(
            dimensions.width >= dimensions.cssWidth * 1.9,
            "DPR 2 overlay",
          );
          const box = await overlay.boundingBox();
          await page.evaluate(
            ({ x, y }) => {
              const stage = document.getElementById("stage-A");
              stage.dispatchEvent(
                new PointerEvent("pointermove", {
                  clientX: x,
                  clientY: y,
                  bubbles: true,
                }),
              );
            },
            { x: box.x + box.width / 2, y: box.y + box.height / 2 },
          );
          const tooltip = page.locator(".viewport-surface .bitstream-hit-tooltip");
          await tooltip.waitFor({ state: "visible" });
          assert.match(
            await tooltip.innerText(),
            /QP/,
            "block hit information remains visible after UI tooltip migration",
          );
          const beforePick = await call('get_presented_frame', { slot: 'A' });
          await page.evaluate(({ x, y }) => document.getElementById('stage-A').dispatchEvent(new MouseEvent('click', { clientX: x, clientY: y, bubbles: true })), { x: box.x + box.width / 2, y: box.y + box.height / 2 });
          assert.equal(await page.locator('#bitstream-block').count(),0,'block clicks never introduce pinned details');
          assert.deepEqual(await call('get_presented_frame', { slot: 'A' }), beforePick, 'selecting a block never seeks');
          await call("step_review", { direction: 1 });
          // Enabled overlays may automatically fill missing frame details; they never seek.
          assert.equal((await call('get_presented_frame',{slot:'A'})).sourcePtsUs, (await call('get_review_session')).tracks[0].frame.sourcePtsUs);
          assert.ok(await tooltip.isHidden(),'frame changes hide the hovered old block');
          if (await overlay.isVisible()) {
            const next = await call("get_presented_frame", { slot: "A" });
            assert.notEqual(next.picture.au, token.picture.au);
            assert.equal(
              await overlay.getAttribute("data-picture"),
              JSON.stringify([
                next.picture.sourceVersion,
                next.picture.stream,
                next.picture.configuration,
                next.picture.au,
                0,
                0,
                "frame",
              ]),
              "only an exact next-picture cache hit may remain visible",
            );
          }
          if (input === 'local-file' && decoding === 'browser' && row.codec === 'h264' && row.container === 'mp4') {
            const next = await call('get_presented_frame', { slot: 'A' });
            await analyze();
            try { await overlay.waitFor({ state: 'visible' }); }
            catch (error) { console.error('Next-picture overlay state:', await call('get_bitstream_analysis_state', { slot: 'A' })); throw error; }
            assert.equal(await overlay.getAttribute('data-picture'), JSON.stringify([next.picture.sourceVersion, next.picture.stream, next.picture.configuration, next.picture.au, 0, 0, 'frame']), 'next frame can be analyzed directly without toggling visibility');
          }
          await call("seek_review", { ptsUs: 0 });
          await overlay.waitFor({ state: "visible" });
          await hideOverlay();
          assert.equal(
            await page.locator(".analysis-picture-overlay").count(),
            0,
            "off releases canvas",
          );
          const range = await call("request_bitstream_range", {
            slot: "A",
            startUs: 0,
            endUs: 100000,
          });
          assert.ok(
            range.pictures >= 5,
            "half-open range publishes picture chunks",
          );
          const beforeCachedRange = requests.length;
          const cachedRange = await call('request_bitstream_range', { slot: 'A', startUs: 10000, endUs: 50000 });
          assert.ok(cachedRange.pictures >= 2, 'overlapping range enumerates its own pictures');
          if (input === 'local-file') assert.ok(!requests.slice(beforeCachedRange).some(r => /voidplayer-analysis(?:-mt)?\.(js|wasm)/.test(r.url)),
            'a completely cached local range reads metadata without loading analysis WASM');
          if (decoding === "browser" && row.codec === "h264" && row.container === "mp4") {
            await call("request_bitstream_range", {
              slot: "A",
              startUs: 0,
              endUs: 120000,
            });
            await call("seek_review", { ptsUs: 0 });
            await analyze();
            await overlay.waitFor({ state: "visible" });
            await setMode("qp");
            const beforeSustained = await page.evaluate(() => ({...document.getElementById('bitstream-overlay-A').analysisMetrics}));
            let playingWallMs = 0;
            for (let i = 0; i < 20; i++) {
              await call('seek_review', {ptsUs:0});
              const proof = await verifyPlaybackPresentation(page, { minPlayingMs:60 }, {engine,caseName:'sustained-cache',targetPtsUs:0});
              playingWallMs += proof.playingMs;
            }
            const afterSustained = await page.evaluate(() => ({...document.getElementById('bitstream-overlay-A').analysisMetrics}));
            const sustained = { playingWallMs,
              presentations:afterSustained.presentations-beforeSustained.presentations,
              hits:afterSustained.cacheHits-beforeSustained.cacheHits,
              draws:afterSustained.draws-beforeSustained.draws,
              resizes:afterSustained.resizes-beforeSustained.resizes };
            assert.ok(
              sustained.playingWallMs >= 1000 &&
                sustained.presentations >= 20 &&
                sustained.draws >= 20,
            );
            assert.ok(
              sustained.hits / sustained.presentations >= 0.98,
              "CI sustained cache-hit load",
            );
            assert.equal(
              sustained.resizes,
              0,
              "constant geometry preserves canvas storage",
            );
            await hideOverlay();
            rows.push({ kind: "sustained-cache", input, ...sustained });
          }
          await call("set_review_track_offset", {
            slot: "A",
            offsetUs: 100000,
          });
          await call("seek_review", { ptsUs: 100000 });
          assert.deepEqual(
            (await call("get_presented_frame", { slot: "A" })).picture,
            token.picture,
            "offset is not persistent picture identity",
          );
          await call("set_review_track_offset", { slot: "A", offsetUs: 0 });
          if (row.container === 'fmp4' || row.container === 'ts') {
            await call('seek_review', { ptsUs: row.container === 'ts' ? 8_700_000 : 350000 }); await stable();
            const rearToken = await call('get_presented_frame', { slot: 'A' });
            const rearResult = await call('request_bitstream_analysis', { slot: 'A' });
            assert.deepEqual(rearResult.picture, rearToken.picture, 'nonkey fragment seek preserves actual presented AU');
            assert.equal(rearResult.sourcePtsUs, rearToken.sourcePtsUs);
            await analyze(); await overlay.waitFor({ state: 'visible' });
            assert.equal(await overlay.getAttribute('data-picture'), JSON.stringify([rearToken.picture.sourceVersion, rearToken.picture.stream, 0, rearToken.picture.au, 0, 0, 'frame']));
            await hideOverlay();
            const crossing = await call('request_bitstream_range', { slot: 'A', startUs: 280000, endUs: 480000 });
            assert.ok(crossing.pictures >= 10, 'real interval crosses a nonkey fragment');
            const decoder = (await call('get_review_session')).tracks[0].decoder;
            if (row.codec === 'vvc' || decoding === 'software') assert.equal(decoder, 'ffmpeg-wasm', 'actual software packet path');
            await call('seek_review', { ptsUs: 0 });
          }
          const report = playbackBenchmarksEnabled ? await observePlaybackBenchmark({page,call,row,engine,input,decoding,playbackProfile,artifact}) : undefined;
          const playbackRow = {
            codec: row.codec,
            input,
            decoding,
            decoder: (await call("get_review_session")).tracks[0].decoder,
            token,
            metrics: result.metrics,
            range,
            playback: report,
            functionalPresentation: { status: 'waiting' },
          };
          rows.push(playbackRow);
          // Persist the row even if functional proof fails. Local runs also retain
          // the separate fixed-window sample; CI never collects that sample.
          await writeFile(artifact('matrix.json'), JSON.stringify({ engine, rows, errors }, null, 2));
          try {
            if (report) assertBenchmarkCorrectness(report);
            await call('seek_review', { ptsUs: 0 });
            playbackRow.functionalPresentation = { status: 'passed', ...await verifyPlaybackPresentation(page, {}, { engine, caseName: `${row.container}-${row.codec}-${input}-${decoding}`, targetPtsUs: 0 }) };
            await writeFile(artifact('matrix.json'), JSON.stringify({ engine, rows, errors }, null, 2));
          } catch (error) {
            playbackRow.functionalPresentation = { status: 'failed', error: error.message };
            await writeFile(artifact('matrix.json'), JSON.stringify({ engine, rows, errors }, null, 2));
            throw error;
          }
        }

    // A response for a frame superseded during the request must never become visible.
    await hideOverlay();

    // Select from the actual final fixture: unpartitioned and fixture-filtered
    // runs also cache the fMP4 280–480 ms cross-fragment interval.
    const lifecyclePtsUs = matrixRows.at(-1)?.container === 'ts' ? 4_700_000 : matrixRows.at(-1)?.container === 'fmp4' ? 800000 : 400000;

    await call("seek_review", { ptsUs: lifecyclePtsUs });

    await page.evaluate(() => { void window.voidPlayer.tools.find(t=>t.name==='request_bitstream_analysis').execute({slot:'A'}).catch(()=>{}); });

    // Establish that the old-picture demand exists before superseding it;
    // otherwise an async UI import can start a legitimate new-picture request.
    await page.waitForFunction(
      () =>
        window.voidPlayer.tools
          .find((t) => t.name === "get_bitstream_analysis_state")
          .execute({}).state === "pending",
    );

    await call("step_review", { direction: 1 });

    await page.waitForFunction(
      () =>
        window.voidPlayer.tools
          .find((t) => t.name === "get_bitstream_analysis_state")
          .execute({}).state !== "pending",
    );

    assert.ok(
      await page.locator("#bitstream-overlay-A").isHidden(),
      "late analysis never paints a superseded picture",
    );

    await hideOverlay();

    await call("seek_review", { ptsUs: 6000000 });

    const cancelled = await page.evaluate(async () => {
      const tool = (name) =>
        window.voidPlayer.tools.find((t) => t.name === name);
      const pending = tool("request_bitstream_analysis").execute({ slot: "A" });
      await Promise.resolve();
      tool("cancel_bitstream_analysis").execute({});
      try {
        await pending;
        return false;
      } catch {
        return true;
      }
    });

    assert.equal(cancelled, true, "explicit cancellation settles the request");

    await call("seek_review", { ptsUs: 0 });

    const healthy = await call("get_review_session");

    assert.equal(healthy.error, null);

    assert.ok(healthy.tracks.every((t) => !t.failure));

      const built = JSON.parse(await readFile(path.join(context.staticDir, 'build-info.json'), 'utf8'));

      const coreRequests = requests.map(request => new URL(request.url)).filter(url => url.pathname.startsWith('/vendor/') && /\.(js|wasm|json)$/.test(url.pathname));

      assert.ok(coreRequests.some(url => /voidplayer-core.*\.wasm$/.test(url.pathname)), 'playback Worker fetches a real core');

      assert.ok(coreRequests.some(url => /\/voidplayer-analysis(?:-mt)?\.wasm$/.test(url.pathname)), 'analysis Worker fetches a real core');
      for (const url of coreRequests) assert.equal(url.searchParams.get('v'), built.coreAssetDigests[url.pathname], `main/Worker core version: ${url.pathname}`);

      assert.equal(rows.filter(row => row.codec).length, checkpointOnly ? matrixRows.length : matrixRows.reduce((count, row) => count + row.inputs.length * 2, 0), 'every admitted codec/input/playback preference is checked');

      assert.deepEqual(errors, []);

      await writeFile(artifact('matrix.json'), JSON.stringify({ engine, rows, errors }, null, 2));

      await page.screenshot({ path: artifact('final.png') });

      console.log(`PASS ${engine}: isolated codec/overlay matrix, cache, range, sustained load and cancellation`);

      return;
}
