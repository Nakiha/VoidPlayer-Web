import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { recordBrowserEvidence, saveBrowserFailure, withinBrowserPhase } from '../browser-failure-evidence.mjs';
import { cleanupResources } from './lifecycle.mjs';
import { repositoryRoot } from './manifest.mjs';

// Acquisition is registered as soon as it succeeds, including late completion
// after timeout/abort. Every fixture owns its data, port, browser and contexts.
export async function withBrowserFixture({ caseName, engine = 'webkit', pageOptions = {}, timeoutMs = 300000,
  phaseTimeoutMs = 30000, cleanupTimeoutMs = 10000, signal, directory = process.env.VOIDPLAYER_TEST_ARTIFACTS ?? path.join(repositoryRoot, '.run/browser-fixtures', `${caseName}-${engine}`),
  dependencies = {}, roots = [path.join(repositoryRoot, 'fixtures/video')],
}, body) {
  if (!['chromium', 'webkit'].includes(engine)) throw new Error(`Unknown browser engine: ${engine}`);
  await mkdir(directory, { recursive: true });
  const steps = [], cleanupErrors = [];
  let failure, closing = false, phase = 'temporary-data', page, evidence, temp, browser, context, service;
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason ?? new Error(`${caseName}: cancelled`));
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const cleanup = async (name, close) => {
    await withinBrowserPhase(close, cleanupTimeoutMs, { caseName, engine, phase: `cleanup-${name}` });
  };
  const acquire = async (name, open, close) => {
    if (closing || controller.signal.aborted) throw controller.signal.reason ?? new Error('Fixture already closing');
    phase = name;
    const resource = await open();
    if (closing || controller.signal.aborted) {
      try { await cleanup(name, () => close(resource)); }
      catch (error) { console.error(`${caseName}: late ${name} cleanup failed`, error); }
      throw controller.signal.reason ?? new Error('Fixture already closing');
    }
    steps.unshift([name, () => cleanup(name, () => close(resource))]);
    return resource;
  };
  const defer = (name, close) => {
    if (closing) throw new Error('Cannot register resources on a closing fixture');
    steps.unshift([name, () => cleanup(name, close)]);
  };
  const artifact = name => path.join(directory, path.basename(name));
  const operation = async (name, run) => {
    if (closing || controller.signal.aborted) throw controller.signal.reason ?? new Error('Fixture already closing');
    const previousPhase = phase;
    phase = name;
    const result = await withinBrowserPhase(() => Promise.race([Promise.resolve().then(run), stopped]), phaseTimeoutMs, { caseName, engine, phase });
    // A completed ready/load phase must not label a later assertion failure.
    if (phase === name) phase = previousPhase;
    return result;
  };
  let timer, onAbort;
  const stopped = new Promise((_, reject) => {
    onAbort = () => reject(controller.signal.reason);
    controller.signal.addEventListener('abort', onAbort, { once: true });
    if (controller.signal.aborted) onAbort();
    timer = setTimeout(() => controller.abort(new Error(`${engine} ${caseName}: ${phase} timed out after ${timeoutMs} ms`)), timeoutMs);
  });
  const work = async () => {
    temp = await acquire('temporary-data', () => (dependencies.makeTemp ?? (() => mkdtemp(path.join(os.tmpdir(), `vp-${caseName}-`))))(), value => (dependencies.removeTemp ?? (value => rm(value, { recursive: true, force: true })))(value));
    const startService = dependencies.startService ?? (async () => {
      const [{ createMediaServer }, { MediaLibraryIndex }] = await Promise.all([import('../../server/app.ts'), import('../../server/library.ts')]);
      const library = new MediaLibraryIndex(roots, { database: path.join(temp, 'library.sqlite'), watch: false });
      const server = createMediaServer({ roots, library, staticDir: path.join(repositoryRoot, 'dist'), onLog() {} });
      let closed = false;
      const close = async () => {
        if (closed) return; closed = true;
        try { server.closeAllConnections(); if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
        finally { await library.close(); }
      };
      defer('partial-server', close);
      try {
        library.start();
        await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
        return { server, close, url: `http://127.0.0.1:${server.address().port}/` };
      } catch (error) { await cleanupResources([['partial-server', close]], { error }); }
    });
    service = await acquire('server-start', () => startService({ temp, roots, defer, signal: controller.signal }), value => value.close());
    browser = await acquire('browser-launch', async () => {
      if (dependencies.launchBrowser) return dependencies.launchBrowser(engine);
      return (await import('playwright'))[engine].launch({ headless: true });
    }, value => value.close());
    context = await acquire('browser-context', () => browser.newContext(pageOptions), value => value.close());
    page = await acquire('page-create', () => context.newPage(), value => value.close());
    evidence = recordBrowserEvidence(page);
    let extraContexts = 0;
    const fixture = { page, browser, context, server: service.server, url: service.url, temp, directory, artifact,
      newContext: async options => {
        const previousPhase = phase;
        const value = await acquire(`extra-context-${++extraContexts}`, () => browser.newContext(options), value => value.close());
        phase = previousPhase;
        return value;
      },
      signal: controller.signal, phase: operation, defer,
      ready: () => operation('ready', async () => {
        await page.goto(service.url);
        await page.waitForFunction(() => window.voidPlayer?.tools, null, { timeout: phaseTimeoutMs });
      }),
    };
    phase = 'assertions';
    return body(fixture);
  };
  let result;
  try { result = await Promise.race([work(), stopped]); }
  catch (error) {
    failure = { error };
    closing = true;
    try { await saveBrowserFailure({ page, directory, name: caseName, context: { caseName, engine, phase }, error, evidence }); }
    catch (cause) { console.error(`${caseName}: failure evidence could not be saved`, cause); }
  } finally {
    closing = true; clearTimeout(timer); controller.signal.removeEventListener('abort', onAbort); signal?.removeEventListener('abort', abort);
    try {
      await cleanupResources(steps, failure, (message, error) => { cleanupErrors.push({ message, error: error.message }); console.error(message, error); });
    } catch (error) {
      if (!failure) {
        try { await saveBrowserFailure({ page, directory, name: caseName, context: { caseName, engine, phase: 'cleanup' }, error, evidence }); }
        catch (cause) { console.error(`${caseName}: cleanup evidence could not be saved`, cause); }
      }
      throw error;
    } finally {
      if (cleanupErrors.length) await writeFile(artifact('cleanup-errors.json'), JSON.stringify({ caseName, engine, phase: 'cleanup', errors: cleanupErrors }, null, 2) + '\n').catch(error => console.error(error));
    }
  }
  return result;
}
