import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { installUriState } from '../../src/ui/uri-state.ts';
import { emptyUriState } from '../../shared/review/uri-state.ts';
import type { ReviewSession } from '../../src/session.ts';
import type { WorkspaceFile } from '../../shared/review/workspace-file.ts';

test('URI decoding cannot overwrite a newer navigation, and a pending explicit address is never replaced by startup defaults', async t => {
  const previous = new Map<string, PropertyDescriptor | undefined>(), window = new EventTarget();
  const attributes = new Map<string, string>();
  const element = Object.assign(new EventTarget(), { disabled: false, toggleAttribute(name: string, value: boolean) { if (value) attributes.set(name, ''); else attributes.delete(name); },
    setAttribute(name: string, value: string) { attributes.set(name, value); }, removeAttribute(name: string) { attributes.delete(name); } });
  const elements = new Map(['app', 'state-copy-readable', 'workspace-share', 'saved-workspace-share', 'start-panel'].map(id => [id, element]));
  const location = { href: 'http://localhost/?s=older', origin: 'http://localhost' };
  const writes: string[] = [], restores: number[] = [], gates = new Map<string, (response: Response) => void>();
  const history = { replaceState(_a: unknown, _b: string, url: string | URL) { location.href = String(url); writes.push(location.href); },
    pushState(_a: unknown, _b: string, url: string | URL) { location.href = String(url); writes.push(location.href); } };
  const fetch = (url: string) => new Promise<Response>(resolve => gates.set(url, resolve));
  for (const [key, value] of Object.entries({ window, location, history, fetch, document: { hidden: false, getElementById: (id: string) => elements.get(id) ?? null } })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  t.mock.timers.enable({ apis: ['setInterval'] });
  let positionUs = 0, viewport = emptyUriState().viewport;
  let tracks: unknown[] = [];
  const session = { getState: () => ({ tracks, marks: [], busy: false, positionUs }), subscribe: () => () => {},
    exportWorkspace: () => ({ schema: 'voidplayer-workspace', version: 1, generatedAt: '', serverUrl: 'http://localhost/', tracks: [], media: [], marks: [], positionUs, viewport }),
    async restoreWorkspace(document: WorkspaceFile) { restores.push(document.positionUs); positionUs = document.positionUs; } } as unknown as ReviewSession;
  const failures: unknown[] = []; let settingsClosed = 0;
  const options: Parameters<typeof installUriState>[1] = { capture: () => ({ viewport }), restore: document => { viewport = document.viewport; },
    beforeRestore() {}, closeSettings: async () => { settingsClosed++; }, identityReady: Promise.resolve(), editsReady: () => true,
    act: async action => { try { await action(); } catch (error) { failures.push(error); } }, toasts: { show() {} } as never };
  let controller = installUriState(session, options);
  const settle = async () => { for (let i = 0; i < 20; i++) await setImmediate(); };
  try {
    await settle(); t.mock.timers.tick(1000); await settle(); assert.deepEqual(writes, []);
    location.href = 'http://localhost/?s=newer'; window.dispatchEvent(new Event('popstate')); await settle();
    gates.get('/api/uri/decode?s=newer')!(Response.json({ state: { ...emptyUriState(), positionUs: 2000000 } }));
    await settle(); assert.deepEqual(restores, [2000000]);
    gates.get('/api/uri/decode?s=older')!(Response.json({ state: { ...emptyUriState(), positionUs: 1000000 } }));
    await settle(); assert.deepEqual(restores, [2000000]); assert.equal(new URL(location.href).searchParams.get('t'), '2');
    const id = 'a'.repeat(24), version = 'b'.repeat(24);
    const pendingRestore = controller.applyState({ ...emptyUriState(), tracks: [{ slot: 'A', id, version, offsetUs: 0, visible: true }] });
    await settle(); tracks = [{ slot: 'H', id: 'new-user-intent' }];
    gates.get(`http://localhost/api/media/${id}`)!(Response.json({ id, version, state: 'ready', name: 'a.mp4', size: 10, lastModified: 1 }));
    await pendingRestore; assert.deepEqual(restores, [2000000], 'a source change while metadata is pending supersedes the URI restore');
    assert.deepEqual(failures, []);
    controller.dispose(); tracks = []; location.href = 'http://localhost/?abi=1';
    const closedBeforeStartup = settingsClosed;
    controller = installUriState(session, options);
    await settle();
    assert.equal(settingsClosed, closedBeforeStartup, 'initial background URI restoration preserves a newly opened settings dialog');
    await controller.applyState({ ...emptyUriState(), positionUs: 4000000 });
    assert.equal(settingsClosed, closedBeforeStartup + 1, 'explicit state navigation still closes settings');
  } finally { controller.dispose(); for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } }
});
