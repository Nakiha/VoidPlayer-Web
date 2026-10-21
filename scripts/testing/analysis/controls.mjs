import { settleAppearance } from '../browser-contracts.mjs';

export async function selectDiagrams(page, choice) {
  if (!await page.locator('#analysis-panel').isVisible()) await page.locator('#toggle-analysis').click();
  const selected = Array.isArray(choice) ? choice : choice === 'overview' ? ['bitrate', 'size'] : [choice];
  for (const value of ['bitrate', 'size', 'nalu-size', 'nalu-types', 'references']) {
    const item = page.locator(`#analysis-diagrams [data-value="${value}"]`);
    if ((await item.getAttribute('aria-pressed') === 'true') !== selected.includes(value)) await item.click();
  }
  // Direct toggles no longer wait for a popup to close. Let the chart layout
  // and its ResizeObserver render settle before measuring pointer targets.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

export async function openRangeEditor(page) {
  // Escape restores focus before all native popover toggle/animation work has
  // settled. Reopening must begin after that transition, with one real click.
  await settleAppearance(page);
  if (!await page.locator('#analysis-range-editor').evaluate(e=>e.matches(':popover-open'))) await page.locator('#analysis-range-trigger').click();
  await page.waitForFunction(()=>document.querySelector('#analysis-range-editor').matches(':popover-open') && document.querySelector('#analysis-range-trigger').getAttribute('aria-expanded')==='true');
}

// Seed a one-second inspection window using the shared axis gesture. The old
// current-frame button is replaced by independent zoom in/out controls.
// A gated (partial-index) domain may be shorter than a second: callers can
// pass the achievable span so the gesture is still exercised (clamped) instead
// of demanding an impossible window.
export async function inspectCurrentWindow(page, span = 1_000_000) {
  await page.locator('#analysis-shared-axis').evaluate((c, targetSpan) => {
    const d=c.dataset, bounds=c.getBoundingClientRect(), viewSpan=+d.viewEnd-+d.viewStart;
    const position=window.voidPlayer.getState().positionUs;
    const fraction=Math.max(0,Math.min(1,(position-+d.domainStart)/(+d.domainEnd-+d.domainStart)));
    const event=new WheelEvent('wheel',{ctrlKey:true,deltaY:280*Math.log(targetSpan/viewSpan),clientX:bounds.left+ +d.plotLeft+fraction*(+d.plotRight-+d.plotLeft),bubbles:true,cancelable:true});
    c.dispatchEvent(event);
  }, span);
  await page.waitForFunction(expectSpan=>{const d=document.querySelector('#analysis-shared-axis').dataset;return Math.abs(+d.viewEnd-+d.viewStart-expectSpan)<=2;}, span);
}

// Backend lifecycle cases remain explicit through the same session facade.
export async function requestInspection(page, slot) {
  await page.evaluate(slot => { void window.voidPlayer.tools.find(t => t.name === 'request_bitstream_stream').execute({slot}).catch(() => {}); }, slot);
}


export async function createAnalysisControls(page) {

    const call = (name, params = {}) =>
      page.evaluate(
        async ({ name, params }) =>
          window.voidPlayer.tools.find((t) => t.name === name).execute(params),
        { name, params },
      );

    let overlaySlot='A';

    const openAnalysis=async(slot='A')=>{overlaySlot=slot;if(!await page.locator('#analysis-overlay-panel').isVisible())await page.locator('#toggle-analysis-overlay').click();const button=page.locator(`#bitstream-tracks [data-slot="${slot}"]`);if(await button.getAttribute('aria-pressed')!=='true')await button.click();};

    const analyze=openAnalysis;

    const hideOverlay=async()=>{const button=page.locator(`#bitstream-tracks [data-slot="${overlaySlot}"]`);if(await button.getAttribute('aria-pressed')==='true')await button.click();};

    const setMode = async mode => {
      await page.locator(`#bitstream-mode [data-value="${mode === 'blocks' ? 'none' : mode}"]`).click();
    };

    const stable = () =>
      page.waitForFunction(() => {
        const s = window.voidPlayer.getState();
        return (
          !s.busy &&
          s.tracks.length &&
          s.tracks.every((t) => t.frame && !t.failure)
        );
      });

    const library = await call("list_library");
return {call, openAnalysis, analyze, hideOverlay, setMode, stable, library};
}
