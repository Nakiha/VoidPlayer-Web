import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { setImmediate } from 'node:timers/promises';
import { currentActor, identityHealth } from '../../src/identity.ts';
import type { Actor } from '../../src/identity.ts';
import type { WorkspaceRecord } from '../../src/saved-workspaces.ts';
import type { WorkspaceFile } from '../../src/workspace-file.ts';
import { Viewport } from '../../src/viewport.ts';

// Vite's SVG imports are presentation-only; exercise the real controller and
// network client without adding a browser or DOM package to unit tests.
const hooks = registerHooks({ load(url, context, next) {
  if (url.endsWith('/src/ui/icons.ts')) return { format: 'module', source: 'export const icon = () => "";', shortCircuit: true };
  return next(url, context);
} });
const { installSavedWorkspaces } = await import('../../src/ui/saved-workspaces.ts');
hooks.deregister();

class Element extends EventTarget {
  hidden = false; disabled = false; value = ''; textContent = ''; className = '';
  dataset: Record<string, string> = {};
  children: Element[] = [];
  onclick?: () => void;
  onkeydown?: (event: KeyboardEvent) => void;
  toggleAttribute(name: string, value: boolean) { if (name === 'disabled') this.disabled = value; }
  setAttribute() {}
  querySelectorAll() { return []; }
  append(...children: Element[]) { this.children.push(...children); }
  replaceChildren(...children: Element[]) { this.children = children; }
  focus() {}
  blur() {}
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function workspace(name: string): WorkspaceFile {
  return { schema: 'voidplayer-workspace', version: 1, name, generatedAt: '2026-10-02T00:00:00Z', serverUrl: 'http://example.test/', positionUs: 0,
    tracks: [{ slot: 'A', mediaId: 'sample', offsetUs: 0 }], marks: [], viewport: new Viewport().snapshot(),
    media: [{ id: 'sample', name: 'sample.mp4', size: 100, lastModified: 10, codec: 'h264', decoder: 'webcodecs', width: 100, height: 100, durationUs: 1000, firstPtsUs: 0,
      source: { kind: 'library', id: 'sample', url: 'http://example.test/api/media/sample' } }] };
}
function record(name = 'A', revision = 1, space: string | null = null): WorkspaceRecord {
  return { id: name, name, revision, space, document: workspace(name), owner: 'alice', updatedBy: 'alice', ownerName: 'Alice',
    createdAt: '2026-10-02T00:00:00Z', updatedAt: '2026-10-02T00:00:00Z', bytes: 100, tracks: 1, marks: 0 };
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
type Call = { url: string; method: string; headers: Headers; body?: { name: string; document: WorkspaceFile } };
async function harness(t: TestContext, shared = false) {
  const elements = new Map<string, Element>();
  const element = (id: string) => { let result = elements.get(id); if (!result) { result = new Element(); elements.set(id, result); } return result; };
  const el = (id: string) => element(`saved-workspace-${id}`);
  el('message').hidden = true; el('conflict').hidden = true;
  element('settings-pane-workspace').hidden = true;
  const doc = Object.assign(new EventTarget(), { hidden: false, getElementById: element, querySelector: () => element('pages'), createElement: () => new Element() });
  const win = Object.assign(new EventTarget(), { setInterval });
  const location = { href: 'http://example.test/', origin: 'http://example.test' };
  const history = { replaceState(_state: unknown, _title: string, url: URL | string) { location.href = String(url); } };
  let actor: Actor = { id: 'alice', name: 'Alice' };
  const calls: Call[] = [], errors: Error[] = [];
  let intercept: ((call: Call) => Promise<Response> | Response | undefined) | undefined;
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input), method = init?.method ?? 'GET';
    if (url === '/api/health') return json({ service: 'voidplayer-media', actor, capabilities: { workspaces: true } });
    const call: Call = { url, method, headers: new Headers(init?.headers), body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const response = intercept?.(call); if (response) return response;
    if (url.startsWith('/api/workspaces?')) return json({ entries: [], next: null });
    if (url.endsWith('/metadata')) return json({ id: '1'.repeat(24), version: '2'.repeat(24), name: 'sample.mp4', size: 100, lastModified: 10, state: 'ready' });
    if (method === 'GET') return json(record('A', 1, shared ? 'space-A' : null));
    return json({ ...record(call.body?.name ?? 'A', method === 'PUT' ? 2 : 1), document: call.body?.document });
  };
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ document: doc, window: win, location, history, fetch, localStorage: { setItem() {} } })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const lifetime = new AbortController();
  t.after(() => { lifetime.abort(); for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } });
  await identityHealth();
  let document = workspace('A'), openError: Error | undefined;
  const controller = installSavedWorkspaces({ signal: lifetime.signal, snapshot: () => structuredClone(document), canSave: () => true,
    open: async value => { document = value; controller.detach(value.name); if (openError) throw openError; return true; }, copyLink: async () => {}, report: error => errors.push(error) });
  await controller.open('A');
  assert.equal(controller.binding()?.id, 'A');
  calls.length = 0;
  const idle = async () => { for (let i = 0; i < 30 && el('save').disabled; i++) await setImmediate(); assert.equal(el('save').disabled, false, 'controller settled'); };
  const block = (match: (call: Call) => boolean) => {
    const started = deferred<Call>(), response = deferred<Response>();
    intercept = call => { if (match(call)) { started.resolve(call); return response.promise; } };
    return { started: started.promise, resolve: response.resolve };
  };
  const detach = () => { document = workspace('B'); controller.detach('B'); history.replaceState(null, '', 'http://example.test/?import=B'); };
  const assertDetached = () => {
    assert.equal(controller.binding(), undefined); assert.equal(controller.name(), 'B');
    assert.equal(location.href, 'http://example.test/?import=B'); assert.equal(el('conflict').hidden, true);
    assert.equal(el('message').hidden, true); assert.deepEqual(errors, []);
  };
  return { controller, el, calls, errors, location, idle, block, detach, assertDetached,
    save: () => el('save').onclick!(), rename: (name: string) => { el('name').value = name; el('name').dispatchEvent(new Event('change')); },
    setActor: async (id: string) => { actor = { id, name: id }; await identityHealth(); assert.equal(currentActor()?.id, id); },
    clearIntercept: () => { intercept = undefined; }, failOpen: (error: Error) => { openError = error; }, lifetime };
}

for (const status of [200, 404, 409, 500]) test(`late save ${status} after detach leaves the new workspace unbound and unmodified`, async t => {
  const h = await harness(t);
  const pending = h.block(call => call.method === 'PUT');
  h.save(); const request = await pending.started;
  assert.equal(request.url, '/api/workspaces/A'); assert.equal(request.headers.get('if-match'), '"1"');
  h.detach(); pending.resolve(status === 200 ? json(record('A', 2)) : json({ error: 'old save failed' }, status));
  await h.idle(); h.assertDetached();
  h.clearIntercept(); h.save(); await h.idle();
  const next = h.calls.find(call => call.method === 'POST');
  assert.equal(next?.url, '/api/workspaces'); assert.equal(next?.headers.get('if-match'), null);
  assert.equal(next?.body?.name, 'B'); assert.equal(next?.body?.document.name, 'B');
});

test('switching actors away and back invalidates an in-flight save even with the same final actor', async t => {
  const h = await harness(t), pending = h.block(call => call.method === 'PUT');
  h.save(); await pending.started; await h.setActor('bob'); await h.setActor('alice');
  pending.resolve(json(record('A', 2))); await h.idle();
  assert.equal(h.controller.binding(), undefined); assert.deepEqual(h.errors, []);
});

for (const status of [200, 404]) test(`shared preparation ${status} after detach cannot send or report an old save`, async t => {
  const h = await harness(t, true), pending = h.block(call => call.url.endsWith('/metadata'));
  h.save(); await pending.started; h.detach();
  pending.resolve(status === 200 ? json({ id: '1'.repeat(24), version: '2'.repeat(24), name: 'sample.mp4', size: 100, lastModified: 10, state: 'ready' }) : json({ error: 'old media missing' }, status));
  await h.idle(); h.assertDetached();
  assert.deepEqual(h.calls.filter(call => call.method !== 'GET'), []);
});

for (const status of [200, 404, 409, 500]) test(`late rename read ${status} after detach cannot save or report a previous workspace`, async t => {
  const h = await harness(t), pending = h.block(call => call.method === 'GET' && call.url === '/api/workspaces/A');
  h.rename('Renamed A'); await pending.started; h.detach();
  pending.resolve(status === 200 ? json(record('A')) : json({ error: 'old rename failed' }, status));
  await h.idle(); h.assertDetached(); assert.deepEqual(h.calls.filter(call => call.method !== 'GET'), []);
});

test('current saves advance the revision and subsequent saves use it', async t => {
  const h = await harness(t);
  h.save(); await h.idle(); assert.equal(h.controller.binding()?.revision, 2);
  h.save(); await h.idle();
  assert.deepEqual(h.calls.filter(call => call.method === 'PUT').map(call => call.headers.get('if-match')), ['"1"', '"2"']);
});

for (const status of [404, 409]) test(`current save ${status} still displays the conflict and reports the error`, async t => {
  const h = await harness(t), pending = h.block(call => call.method === 'PUT');
  h.save(); await pending.started; pending.resolve(json({ error: 'current save failed' }, status)); await h.idle();
  assert.equal(h.controller.binding()?.revision, 1); assert.equal(h.el('conflict').hidden, false);
  assert.equal(h.el('reload').dataset.unavailable, String(status === 404)); assert.equal(h.errors.length, 1);
});

for (const status of [200, 404, 409, 500]) test(`late save ${status} after an actor switch cannot alter the next actor's workspace`, async t => {
  const h = await harness(t), pending = h.block(call => call.method === 'PUT');
  h.save(); await pending.started; await h.setActor('bob');
  pending.resolve(status === 200 ? json(record('A', 2)) : json({ error: 'previous actor failed' }, status)); await h.idle();
  assert.equal(h.controller.binding(), undefined); assert.equal(h.el('message').hidden, true);
  assert.equal(h.el('conflict').hidden, true); assert.deepEqual(h.errors, []);
});

for (const status of [200, 500]) test(`late post-save list ${status} cannot replace the imported workspace's list or status`, async t => {
  const h = await harness(t), pending = h.block(call => call.url.startsWith('/api/workspaces?'));
  h.save(); await pending.started; h.detach();
  const marker = new Element(); h.el('list').replaceChildren(marker);
  pending.resolve(status === 200 ? json({ entries: [], next: 'old-page' }) : json({ error: 'old refresh failed' }, status));
  await h.idle(); h.assertDetached(); assert.equal(h.el('list').children[0], marker);
  assert.equal(h.el('next').disabled, true);
});

test('shared saves preserve their original name, target and revision through preparation', async t => {
  const h = await harness(t, true), pending = h.block(call => call.url.endsWith('/metadata'));
  h.save(); await pending.started; h.el('name').value = 'A different input value';
  pending.resolve(json({ id: '1'.repeat(24), version: '2'.repeat(24), name: 'sample.mp4', size: 100, lastModified: 10, state: 'ready' })); await h.idle();
  const request = h.calls.find(call => call.method === 'PUT');
  assert.equal(request?.url, '/api/workspaces/A'); assert.equal(request?.headers.get('if-match'), '"1"');
  assert.equal(request?.body?.name, 'A'); assert.equal(request?.body?.document.name, 'A');
  assert.match(request!.body!.document.media[0].source!.url, /\?v=222222222222222222222222$/);
});

test('renaming captures the requested title before reading the server snapshot', async t => {
  const h = await harness(t), pending = h.block(call => call.method === 'GET' && call.url === '/api/workspaces/A');
  h.rename('Requested name'); await pending.started; h.el('name').value = 'Later input';
  const stored = record('A'); stored.document.positionUs = 900;
  pending.resolve(json(stored)); await h.idle();
  const request = h.calls.find(call => call.method === 'PUT');
  assert.equal(request?.body?.name, 'Requested name'); assert.equal(request?.body?.document.name, 'Requested name');
  assert.equal(request?.body?.document.positionUs, 900); assert.equal(request?.headers.get('if-match'), '"1"');
});

test('renaming still rejects a newer server revision without saving', async t => {
  const h = await harness(t), pending = h.block(call => call.method === 'GET' && call.url === '/api/workspaces/A');
  h.rename('Renamed A'); await pending.started; pending.resolve(json(record('A', 2))); await h.idle();
  assert.equal(h.el('conflict').hidden, false); assert.equal(h.errors.length, 1);
  assert.deepEqual(h.calls.filter(call => call.method !== 'GET'), []);
});

for (const status of [200, 404, 409, 500]) test(`late share ${status} rejects without changing the imported workspace's UI`, async t => {
  const h = await harness(t), pending = h.block(call => call.url === '/api/workspaces/share');
  const completion = h.controller.share(workspace('A'), 'A', h.controller.binding()).then(() => undefined, error => error);
  await pending.started; h.detach();
  pending.resolve(status === 200 ? json(record('A', 2, 'space-A')) : json({ error: 'old share failed' }, status));
  assert.ok(await completion instanceof Error); await h.idle(); h.assertDetached();
});

test('a share queued behind an old save captures its context before waiting', async t => {
  const h = await harness(t), pending = h.block(call => call.method === 'PUT');
  h.save(); await pending.started;
  const completion = h.controller.share(workspace('A'), 'A', h.controller.binding()).then(() => undefined, error => error);
  h.detach(); pending.resolve(json(record('A', 2)));
  assert.ok(await completion instanceof Error); await h.idle(); h.assertDetached();
  assert.equal(h.calls.some(call => call.url === '/api/workspaces/share'), false);
});

test('a share rejects if the workspace changes during its final list refresh', async t => {
  const h = await harness(t), pending = h.block(call => call.url.startsWith('/api/workspaces?'));
  const completion = h.controller.share(workspace('A'), 'A', h.controller.binding()).then(() => undefined, error => error);
  await pending.started; h.detach(); pending.resolve(json({ entries: [], next: null }));
  assert.ok(await completion instanceof Error); await h.idle(); h.assertDetached();
});

test('a current share still returns and binds the saved revision', async t => {
  const h = await harness(t), saved = await h.controller.share(workspace('A'), 'A', h.controller.binding());
  assert.equal(saved.id, 'A'); assert.equal(h.controller.binding(), saved); assert.deepEqual(h.errors, []);
});

test('opening reports failures after its own intentional detach', async t => {
  const h = await harness(t, true), error = new Error('shared annotation space unavailable');
  h.failOpen(error);
  await h.controller.open('A');
  assert.equal(h.controller.binding(), undefined);
  assert.deepEqual(h.errors, [error]);
  assert.equal(h.el('message').hidden, false);
  assert.equal(h.el('message').textContent, error.message);
});
