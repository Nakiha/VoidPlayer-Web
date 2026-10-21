import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function withinBrowserPhase(operation, timeoutMs, context) {
  let timer;
  try {
    return await Promise.race([Promise.resolve().then(operation), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${context.engine} ${context.caseName}: ${context.phase} timed out after ${timeoutMs} ms (target PTS ${context.targetPtsUs ?? 'n/a'})`)), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

export function recordBrowserEvidence(page) {
  const consoleMessages = [], pageErrors = [], failedRequests = [], byRequest = new WeakMap();
  const range = { total: 0, pending: 0, recent: [] }, api = { total: 0, pending: 0, recent: [] };
  const retain = (list, value) => { list.push(value); if (list.length > 100) list.shift(); };
  page.on('console', message => retain(consoleMessages, { type: message.type(), text: message.text().slice(0, 4000) }));
  page.on('pageerror', error => retain(pageErrors, error.message.slice(0, 4000)));
  page.on('request', request => {
    const rangeHeader = request.headers().range;
    const row = { url: request.url(), method: request.method(), range: rangeHeader ?? null, state: 'pending' };
    const buckets = [];
    if (rangeHeader || /frame-index/.test(row.url)) buckets.push(range);
    if (new URL(row.url).pathname.startsWith('/api/')) buckets.push(api);
    for (const bucket of buckets) { bucket.total++; bucket.pending++; retain(bucket.recent, row); }
    byRequest.set(request, { row, buckets });
  });
  page.on('response', response => {
    const tracked = byRequest.get(response.request());
    if (tracked) {
      tracked.row.status = response.status(); tracked.row.contentRange = response.headers()['content-range'] ?? null;
      if (tracked.row.status >= 400) retain(failedRequests, tracked.row);
    }
  });
  const finish = (request, failed) => {
    const tracked = byRequest.get(request);
    if (!tracked || tracked.row.state !== 'pending') return;
    const { row, buckets } = tracked;
    for (const bucket of buckets) bucket.pending--;
    row.state = failed ? 'failed' : 'finished';
    if (failed) { row.error = request.failure()?.errorText; if (!failedRequests.includes(row)) retain(failedRequests, row); }
  };
  page.on('requestfinished', request => finish(request, false));
  page.on('requestfailed', request => finish(request, true));
  return () => structuredClone({ consoleMessages, pageErrors, rangeRequests: range, apiRequests: api, failedRequests });
}

// Read-only, bounded UI diagnostics. No frame capture, decoder calls, request
// bodies or local storage dump; retain the original screenshot/DOM separately.
export function browserFailureSnapshot() {
  const describe = element => element && { tag: element.tagName, id: element.id, type: element.getAttribute('type') };
  const selectors = ['#settings', '#annotation-toolbar', '#drawing-color', '#analysis-shared-axis', '.analysis-range-navigation', '.bitstream-diagrams canvas', '.transport .duration', '[data-test-probe]'];
  const probes = selectors.flatMap(selector => [...document.querySelectorAll(selector)].slice(0, 16).map(element => {
    const style = getComputedStyle(element), rect = element.getBoundingClientRect();
    return { selector, ...describe(element), dataset: { ...element.dataset }, hidden: element.hidden,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      style: { display: style.display, visibility: style.visibility, opacity: style.opacity, backgroundColor: style.backgroundColor, color: style.color },
      expanded: element.getAttribute('aria-expanded'), open: element.hasAttribute('open'), closing: element.hasAttribute('data-closing') };
  }));
  return { url: location.href, userAgent: navigator.userAgent, visibility: document.visibilityState, focused: document.hasFocus(), viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
    media: { dark: matchMedia('(prefers-color-scheme: dark)').matches, contrast: matchMedia('(prefers-contrast: more)').matches, reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches },
    theme: document.documentElement.dataset.theme, focus: describe(document.activeElement),
    dialogs: [...document.querySelectorAll('dialog[open], [popover]:popover-open')].slice(0, 20).map(describe), probes };
}

// Persist the error/context first, before best-effort browser calls: a crashed or
// unresponsive page must still leave a useful scene rather than losing evidence.
export async function saveBrowserFailure({ page, directory = '.run/playback-reports', name, context, error, evidence = () => ({}), extra = {} }) {
  await mkdir(directory, { recursive: true });
  const stem = path.join(directory, `${name}-failure`);
  const report = { schemaVersion: 2, ...context, error: { message: error.message, stack: error.stack }, ...evidence(), ...extra, capturedAt: new Date().toISOString() };
  await writeFile(`${stem}.json`, JSON.stringify(report, null, 2) + '\n');
  const capture = async (label, operation) => {
    try { return await withinBrowserPhase(operation, 3000, { ...context, phase: `capture-${label}` }); }
    catch (cause) { report[`${label}Error`] = cause.message; return null; }
  };
  if (page && !page.isClosed()) {
    await Promise.all([
      capture('state', async () => { report.state = await page.evaluate(() => window.voidPlayer?.getState() ?? null); }),
      capture('browser', async () => { report.browser = await page.evaluate(browserFailureSnapshot); }),
      capture('screenshot', () => page.screenshot({ path: `${stem}.png`, timeout: 2500 })),
      capture('dom', async () => { await writeFile(`${stem}.html`, await page.content()); }),
    ]);
  } else report.pageUnavailable = true;
  await writeFile(`${stem}.json`, JSON.stringify(report, null, 2) + '\n');
  return `${stem}.json`;
}
