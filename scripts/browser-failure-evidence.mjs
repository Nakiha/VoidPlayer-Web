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
  const consoleMessages = [], pageErrors = [], requests = [], byRequest = new WeakMap();
  page.on('console', message => { consoleMessages.push({ type: message.type(), text: message.text() }); if (consoleMessages.length > 100) consoleMessages.shift(); });
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('request', request => {
    const range = request.headers().range;
    if (!range && !/frame-index/.test(request.url())) return;
    const row = { url: request.url(), method: request.method(), range: range ?? null, state: 'pending' };
    requests.push(row); byRequest.set(request, row);
  });
  page.on('response', response => {
    const row = byRequest.get(response.request());
    if (row) { row.status = response.status(); row.contentRange = response.headers()['content-range'] ?? null; }
  });
  page.on('requestfinished', request => { const row = byRequest.get(request); if (row) row.state = 'finished'; });
  page.on('requestfailed', request => { const row = byRequest.get(request); if (row) { row.state = 'failed'; row.error = request.failure()?.errorText; } });
  return () => ({ consoleMessages, pageErrors, rangeRequests: {
    total: requests.length, pending: requests.filter(request => request.state === 'pending').length,
    recent: requests.slice(-100),
  } });
}

// Persist the error/context first, before best-effort browser calls: a crashed or
// unresponsive page must still leave a useful scene rather than losing evidence.
export async function saveBrowserFailure({ page, directory = '.run/playback-reports', name, context, error, evidence = () => ({}), extra = {} }) {
  await mkdir(directory, { recursive: true });
  const stem = path.join(directory, `${name}-failure`);
  const report = { ...context, error: { message: error.message, stack: error.stack }, ...evidence(), ...extra, capturedAt: new Date().toISOString() };
  await writeFile(`${stem}.json`, JSON.stringify(report, null, 2) + '\n');
  const capture = async (label, operation) => {
    try { return await withinBrowserPhase(operation, 3000, { ...context, phase: `capture-${label}` }); }
    catch (cause) { report[`${label}Error`] = cause.message; return null; }
  };
  if (page && !page.isClosed()) {
    await Promise.all([
      capture('state', async () => { report.state = await page.evaluate(() => window.voidPlayer?.getState() ?? null); }),
      capture('screenshot', () => page.screenshot({ path: `${stem}.png`, timeout: 2500 })),
      capture('dom', async () => { await writeFile(`${stem}.html`, await page.content()); }),
    ]);
  } else report.pageUnavailable = true;
  await writeFile(`${stem}.json`, JSON.stringify(report, null, 2) + '\n');
  return `${stem}.json`;
}
