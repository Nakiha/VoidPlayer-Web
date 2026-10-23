import { readFile } from 'node:fs/promises';
import { freemem, totalmem } from 'node:os';
import { withinBrowserPhase } from '../browser-failure-evidence.mjs';

async function resourceProbe(url) {
  const signal = AbortSignal.timeout(1500);
  const health = await fetch(new URL('/api/health', url), { signal, cache: 'no-store' })
    .then(async response => ({ status: response.status, service: (await response.json()).service }))
    .catch(error => ({ error: error.name }));
  const cgroup = {};
  if (process.platform === 'linux') for (const name of ['memory.current', 'memory.max', 'memory.events']) {
    try { cgroup[name] = (await readFile(`/sys/fs/cgroup/${name}`, { encoding: 'utf8', signal })).trim().slice(0, 512); }
    catch (error) { cgroup[name] = { unavailable: error.code ?? error.name }; }
  }
  return { health, nodeMemory: process.memoryUsage(), hostMemory: { free: freemem(), total: totalmem() }, cgroup };
}

/** Observation only: every reload runs exactly once and its original failure is rethrown. */
export function observeNavigations({ page, browser, server, url, probe = resourceProbe, snapshot = async () => null,
  output = row => console.log('js-container-navigation ' + JSON.stringify(row)) }) {
  let phase = 'matrix', sequence = 0, emitted = 0;
  const listeners = new Set(), workers = new Set();
  const urlText = value => /^(?:https?:|blob:)/.test(value) ? value.slice(0, 1000) : '[non-HTTP/blob URL omitted]';
  const flags = () => ({ browserConnected: browser.isConnected(), pageClosed: page.isClosed(), serverListening: server.listening, workerContextsOpen: workers.size });
  const record = (event, details = {}) => {
    // Diagnostics must not replace a navigation/assertion failure if output is unavailable.
    sequence++;
    const critical = event.includes('reload') || ['checkpoint', 'page-crash', 'browser-disconnected', 'server-close'].includes(event);
    if (emitted >= 288 || emitted >= 256 && !critical) return;
    try { output({ event, phase, sequence, omittedRows: sequence - ++emitted, at: Date.now(), ...flags(), ...details }); } catch {}
  };
  const listen = (target, event, handler) => {
    const remove = () => { target.off(event, handler); listeners.delete(remove); };
    target.on(event, handler); listeners.add(remove); return remove;
  };
  listen(page, 'crash', () => record('page-crash'));
  listen(page, 'close', () => record('page-close'));
  listen(browser, 'disconnected', () => record('browser-disconnected'));
  listen(server, 'close', () => record('server-close'));
  listen(page, 'framenavigated', frame => { if (frame === page.mainFrame()) record('navigation-committed', { url: urlText(frame.url()) }); });
  listen(page, 'domcontentloaded', () => record('domcontentloaded', { url: urlText(page.url()) }));
  listen(page, 'load', () => record('load', { url: urlText(page.url()) }));
  listen(page, 'worker', worker => {
    workers.add(worker); record('worker-context-created', { url: urlText(worker.url()) });
    const remove = listen(worker, 'close', () => { workers.delete(worker); record('worker-context-closed', { url: urlText(worker.url()) }); remove(); });
  });
  listen(page, 'request', request => { if (request.isNavigationRequest()) record('navigation-request', { url: urlText(request.url()) }); });
  listen(page, 'response', response => {
    if (response.request().isNavigationRequest() || response.status() >= 400)
      record('response', { url: urlText(response.url()), status: response.status() });
  });
  listen(page, 'requestfailed', request => record('request-failed', { url: urlText(request.url()), navigation: request.isNavigationRequest(), failure: request.failure() }));
  listen(page, 'pageerror', error => record('page-error', { message: error.message.slice(0, 1000), stack: error.stack?.slice(0, 2000) }));
  listen(page, 'console', message => { if (message.text().startsWith('js-container-pagehide ')) record('pagehide', { message: message.text().slice(0, 1000) }); });
  const sample = async event => {
    const results = await Promise.allSettled([
      withinBrowserPhase(() => probe(url), 1500, { engine: 'browser', caseName: 'js-containers', phase: `${event}-resource` }),
      withinBrowserPhase(snapshot, 1500, { engine: 'browser', caseName: 'js-containers', phase: `${event}-state` }),
    ]);
    record(event, { resource: results[0].status === 'fulfilled' ? results[0].value : { unavailable: results[0].reason.name },
      snapshot: results[1].status === 'fulfilled' ? results[1].value : { unavailable: results[1].reason.name } });
  };
  return {
    checkpoint(label, details) { phase = label; record('checkpoint', details); },
    async reload(label, operation) {
      phase = label;
      await sample('before-reload');
      try { const value = await operation(); await sample('after-reload'); return value; }
      catch (error) {
        record('reload-failed', { error: error.message, stack: error.stack?.slice(0, 2000) });
        await sample('after-reload-failure');
        throw error;
      }
    },
    dispose() { for (const remove of listeners) remove(); },
  };
}
