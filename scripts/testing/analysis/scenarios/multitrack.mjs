import assert from "node:assert/strict";
import path from "node:path";
import { selectDiagrams, inspectCurrentWindow } from '../controls.mjs';


export async function run(context) {
const { page, artifact, call, stable, library } = context;

      // Multi-track deep charts retain independent identities, filters and card ownership.
      await call('load_library_item', { slot: 'B', id: library.entries.find(e => e.name === 'stream.mp4').id });

      await stable();
 await call('request_bitstream_stream', { slot:'B' });

      await call('set_review_track_offset', { slot:'B', offsetUs:100_000 });

      await call('seek_review', { ptsUs:500_000 });

      await selectDiagrams(page, ['size','nalu-size','nalu-types','references']);

      await inspectCurrentWindow(page);

      await page.waitForFunction(() => {
        const charts=[...document.querySelectorAll('.bitstream-diagrams canvas')], shared=document.querySelector('#analysis-shared-axis').dataset;
        return charts.length===6 && +shared.viewStart<500_000 && +shared.viewEnd>500_000 && charts.every(c=>c.dataset.aggregated==='false' && c.dataset.axisStart===shared.viewStart && c.dataset.axisEnd===shared.viewEnd);
      });

      assert.equal(await page.locator('.bitstream-nalu-group').count(),2);

      assert.equal(await page.locator('#analysis-layout').isVisible(),true);

      assert.match(await page.locator('#analysis-layout').innerText(),/码流/);

      const target=page.locator('.bitstream-diagrams[data-slot="B"][data-diagram="references"] canvas');

      const geometry=await target.evaluate(c=>({r:c.getBoundingClientRect().toJSON(),left:+c.dataset.plotLeft,right:+c.dataset.plotRight,start:+c.dataset.axisStart,end:+c.dataset.axisEnd}));

      await target.scrollIntoViewIfNeeded();

      const r=await target.boundingBox();

      const x=r.x+geometry.left+(500_000-geometry.start)/(geometry.end-geometry.start)*(geometry.right-geometry.left);

      await page.mouse.move(x,r.y+r.height/2);

      await page.locator('.analysis-linked-card').waitFor({state:'visible'});

      const ownAus=await page.locator('.bitstream-diagrams canvas').evaluateAll(cs=>cs.map(c=>({slot:c.dataset.slot,mode:c.dataset.diagram,au:+c.dataset.hoverAu,cursor:+c.dataset.hoverCursorTime})));

      assert.ok(ownAus.every(c=>Math.abs(c.cursor-500_000)<2000),JSON.stringify(ownAus));

      for (const slot of ['A','B']) assert.equal(new Set(ownAus.filter(c=>c.slot===slot).map(c=>c.au)).size,1,'all diagrams of one track highlight the same AU');

      assert.notEqual(ownAus.find(c=>c.slot==='A').au,ownAus.find(c=>c.slot==='B').au,'offset tracks resolve their own AU');

      const rows=page.locator('.analysis-linked-card .analysis-track-details');

      assert.equal(await rows.count(),2);

      const referenceAppearance=card=>{
        const table=card.querySelector('[data-kind="references"]');
        return {
          layout:getComputedStyle(table.querySelector('tbody')).display,
          l0:getComputedStyle(table.querySelector('[data-list="0"] th')).color,
          l1:getComputedStyle(table.querySelector('[data-list="1"] th')).color,
          weight:getComputedStyle(table.querySelector('[data-list="0"] td')).fontWeight,
          layer:getComputedStyle(table.querySelector('.analysis-card-depth')).backgroundColor,
        };
      };

      const combinedAppearance=await rows.first().evaluate(referenceAppearance);

      assert.equal(combinedAppearance.layout,'grid','embedded reference details retain the compact shared layout');

      assert.notEqual(combinedAppearance.l0,combinedAppearance.l1,'reference list colors remain distinct in the combined card');

      assert.equal(combinedAppearance.weight,'600');

      assert.equal(await page.locator('.analysis-linked-card > .fl-time').count(),0,'combined card has no shared pointer timestamp');

      for (const slot of ['A','B']) {
        const owned=page.locator(`.analysis-linked-card .analysis-track-details[data-slot="${slot}"]`);
        const time=owned.locator('.analysis-card-track-time');
        assert.match(await time.innerText(),/^\d{2}:\d{2}\.\d{3} · PTS$/,'each track heading carries its matched frame timestamp');
        const hitTime=+(await time.getAttribute('data-hit-time'));
        const trackTime=+(await page.locator(`.bitstream-diagrams[data-slot="${slot}"][data-diagram="references"] canvas`).getAttribute('data-hover-time'));
        assert.equal(hitTime,trackTime,'heading time follows the track match, not the pointer');
        assert.equal(await owned.locator('.analysis-card-section').count(),3);
        assert.match(await owned.locator('[data-diagram="nalu-size"] .analysis-card-frame').innerText(),new RegExp('#'+(ownAus.find(c=>c.slot===slot).au+1)+'(?:\\D|$)'));
        assert.equal(await owned.locator('thead').count(),0,'one row heading identifies all scalar sections');
      }

      await page.screenshot({path:artifact('multitrack-combined.png')});

      await page.keyboard.press('Escape');

      await page.locator('#analysis-diagrams [data-value="size"]').click();

      assert.equal(await page.locator('#analysis-layout').isVisible(),false,'deep charts never expose a merge control');

      await target.press('ArrowRight');

      for (const slot of ['A','B']) assert.match(await page.locator(`.analysis-linked-card .analysis-track-details[data-slot="${slot}"] .analysis-card-track-time`).innerText(),/^\d{2}:\d{2}\.\d{3} · PTS$/,'deep-only panels resolve timestamps without the overview query');

      const legendA=page.locator('.bitstream-diagrams[data-slot="A"][data-diagram="nalu-size"] [data-nalu-type="1"]');

      if (await legendA.count()) {
        await legendA.click();
        assert.equal(await page.locator('.bitstream-diagrams[data-slot="B"][data-diagram="nalu-size"] [data-nalu-type="1"]').getAttribute('aria-pressed'),'true','NAL filters do not leak between tracks');
      }

      // Four independent views fit at maximum height in a tall viewport.
      // Adding both type plots requires scrolling, which hides offscreen cards.
      const cardViewport = page.viewportSize();

      await page.setViewportSize({ ...cardViewport, height: Math.max(800, cardViewport.height) });

      await page.getByRole('separator', { name: '调整码流分析高度', exact: true }).press('End');

      await selectDiagrams(page, ['nalu-size', 'references']);

      await page.waitForFunction(() => { const charts=document.querySelector('.analysis-charts'); return charts.scrollHeight<=charts.clientHeight+1; });

      await page.locator('#settings-open').click();
 await page.locator('#settings-tab-appearance').click();

      await page.locator('#chart-hover-style').click();
 await page.locator('#chart-hover-style-menu [data-value="separate"]').click();
 await page.locator('#settings-close').click();

      // Hidden can precede the queued close event, whose handler returns focus
      // to the invoker. Wait for that handler before focusing the chart, or its
      // later blur can clear the keyboard hover cards we are about to inspect.
      await page.waitForFunction(() => {
        const settings = document.querySelector('#settings');
        return !settings.open && !settings.hasAttribute('data-closing') && document.querySelector('#settings-open').getAttribute('aria-expanded') === 'false';
      });

      await target.focus();

      await target.press('ArrowRight');

      await page.waitForFunction(()=>document.querySelectorAll('.analysis-view-card:not([hidden])').length===4);

      assert.equal(await page.locator('.analysis-view-card:visible').count(),4,'one NALU and one reference card per selected track');

      assert.equal(await page.locator('.analysis-view-card:visible[data-slot="A"]').count(),2);

      assert.equal(await page.locator('.analysis-view-card:visible[data-slot="B"]').count(),2);

      assert.deepEqual(await page.locator('.analysis-view-card:visible[data-slot="B"][data-diagram="references"]').evaluate(referenceAppearance),combinedAppearance,'independent and combined reference bodies share styling');

      const cardBounds=await page.locator('.analysis-view-card:visible').evaluateAll(cards=>cards.map(card=>{
        const owner=card.dataset.diagram==='nalu'
          ? document.querySelector(`.bitstream-nalu-group[data-slot="${card.dataset.slot}"]`) ?? document.querySelector(`.bitstream-diagrams[data-slot="${card.dataset.slot}"][data-diagram="nalu-size"]`)
          : document.querySelector(`.bitstream-diagrams[data-slot="${card.dataset.slot}"][data-diagram="references"]`);
        return {card:card.getBoundingClientRect().toJSON(),owner:owner.getBoundingClientRect().toJSON(),full:card.scrollHeight<=card.clientHeight+1};
      }));

      assert.ok(cardBounds.every(({card,full})=>full && card.top>=8 && card.bottom<=page.viewportSize().height-7),'complete cards stay inside the viewport');

      const ordered=cardBounds.sort((a,b)=>a.owner.top-b.owner.top);

      assert.ok(ordered.slice(1).every(({card},i)=>card.top>=ordered[i].card.bottom+7),'neighbouring panels move to avoid each other');

      for (const diagram of ['nalu','references']) {
        const widths=await page.locator(`.analysis-view-card:visible[data-diagram="${diagram}"]`).evaluateAll(es=>es.map(e=>e.getBoundingClientRect().width));
        assert.ok(Math.abs(widths[0]-widths[1])<1,'same diagram cards have equal widths across tracks');
      }

      const frameRows=await page.locator('.analysis-view-card:visible[data-diagram="nalu"] .analysis-card-frame td').evaluateAll(es=>es.map(e=>{const text=document.createRange();text.selectNodeContents(e);return {height:e.getBoundingClientRect().height,line:parseFloat(getComputedStyle(e).lineHeight),fits:e.scrollWidth<=e.clientWidth+1,lines:text.getClientRects().length};}));

      assert.ok(frameRows.every(row=>row.fits && row.lines===1 && row.height<row.line*1.5),'frame metadata uses the full row and does not wrap despite spare space');

      await page.screenshot({path:artifact('multitrack-separate.png')});

      await page.keyboard.press('Escape');

      await page.locator('#analysis-status-items button[data-slot="B"]').first().click();

      assert.equal(await page.locator('.bitstream-diagrams canvas').count(),2,'track visibility controls every selected deep diagram');

      await call('remove_review_track',{slot:'B'});

      await page.setViewportSize(cardViewport);
}
