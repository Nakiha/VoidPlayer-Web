import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { installUriState } from '../../src/ui/uri-state.ts';
import { emptyUriState } from '../../shared/review/uri-state.ts';
import type { ReviewSession } from '../../src/session.ts';
import type { WorkspaceFile } from '../../shared/review/workspace-file.ts';
import { stageUpdateState, takeUpdateState } from '../../src/services/update-state.ts';

test('URI restoration preserves snapshot addresses and cannot overwrite newer navigation or user intent', async t => {
  const previous = new Map<string, PropertyDescriptor | undefined>(), window = new EventTarget();
  const attributes = new Map<string, string>();
  const element = Object.assign(new EventTarget(), { disabled: false, dataset: {} as Record<string, string>, toggleAttribute(name: string, value: boolean) { if (value) attributes.set(name, ''); else attributes.delete(name); },
    setAttribute(name: string, value: string) { attributes.set(name, value); }, removeAttribute(name: string) { attributes.delete(name); } });
  const elements = new Map(['app', 'workspace-share', 'start-panel'].map(id => [id, element]));
  const location = { href: 'http://localhost/?s=older', origin: 'http://localhost' };
  const writes: string[] = [], restores: number[] = [], gates = new Map<string, (response: Response) => void>();
  const history = { state: { retained: 'navigation-state' },
    replaceState(value: unknown, _b: string, url: string | URL) {
      assert.equal(value, history.state, 'clearing the query preserves unrelated history state');
      location.href = String(url); writes.push(location.href);
    },
    pushState(_a: unknown, _b: string, url: string | URL) { location.href = String(url); writes.push(location.href); } };
  const fetch = (url: string) => new Promise<Response>(resolve => gates.set(url, resolve));
  for (const [key, value] of Object.entries({ window, location, history, fetch, document: { hidden: false, getElementById: (id: string) => elements.get(id) ?? null } })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  t.mock.timers.enable({ apis: ['setInterval'] });
  let positionUs = 0, viewport = emptyUriState().viewport;
  let tracks: unknown[] = [];
  let stateChanged = () => {}, progressChanged = () => {};
  const session = { getState: () => ({ tracks, marks: [], busy: false, positionUs }),
    subscribe(fn: () => void) { stateChanged = fn; return () => {}; },
    subscribeProgress(fn: () => void) { progressChanged = fn; return () => {}; },
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
    await settle(); assert.deepEqual(restores, [2000000]);
    assert.equal(location.href, 'http://localhost/?s=newer', 'opening a shared snapshot preserves its compact address');
    assert.deepEqual(writes, [], 'restoration never writes browser history');
    stateChanged(); progressChanged();
    assert.deepEqual(writes, [], 'background notifications leave an unchanged snapshot alone');
    positionUs = 2500000; progressChanged();
    assert.equal(location.href, 'http://localhost/', 'playback progress invalidates the input snapshot');
    positionUs = 3000000; progressChanged(); stateChanged();
    assert.equal(writes.length, 1, 'later progress never rewrites the cleaned address');
    location.href = 'http://localhost/?s=again#review'; window.dispatchEvent(new Event('popstate')); await settle();
    gates.get('/api/uri/decode?s=again')!(Response.json({ state: { ...emptyUriState(), positionUs: 2000000 } }));
    await settle(); assert.equal(location.href, 'http://localhost/?s=again#review');
    viewport.zoom = 2;
    controller.changed();
    assert.equal(location.href, 'http://localhost/#review', 'a viewport change clears the query while retaining the fragment');
    const id = 'a'.repeat(24), version = 'b'.repeat(24);
    const beforePendingRestore = [...restores];
    const pendingRestore = controller.applyState({ ...emptyUriState(), tracks: [{ slot: 'A', id, version, offsetUs: 0, visible: true }] });
    await settle(); tracks = [{ slot: 'H', id: 'new-user-intent' }];
    gates.get(`http://localhost/api/media/${id}`)!(Response.json({ id, version, state: 'ready', name: 'a.mp4', size: 10, lastModified: 1 }));
    await pendingRestore; assert.deepEqual(restores, beforePendingRestore, 'a source change while metadata is pending supersedes the URI restore');
    assert.deepEqual(failures, []);
    controller.dispose(); tracks = []; location.href = 'http://localhost/?s=startup';
    const closedBeforeStartup = settingsClosed;
    controller = installUriState(session, options);
    await settle();
    gates.get('/api/uri/decode?s=startup')!(Response.json({ state: emptyUriState() }));
    await settle();
    assert.equal(settingsClosed, closedBeforeStartup, 'initial background URI restoration preserves a newly opened settings dialog');
    await controller.applyState({ ...emptyUriState(), positionUs: 4000000 });
    assert.equal(settingsClosed, closedBeforeStartup + 1, 'explicit state navigation still closes settings');
    assert.equal(location.href, 'http://localhost/', 'applying a different snapshot clears the stale input link');
    assert.equal(writes.length, 3);
    controller.dispose(); location.href = 'http://localhost/'; tracks = [];
    const beforeEmptyPage = writes.length;
    controller = installUriState(session, options);
    t.mock.timers.tick(1500); await settle();
    assert.equal(writes.length, beforeEmptyPage, 'an unopened homepage never expands default state into the address');
    assert.equal(location.href, 'http://localhost/');
  } finally { controller.dispose(); for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } }
});

test('local update state is scoped to one tab, target and consumption without a readable URI', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage'), data = new Map<string, string>();
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
    setItem(key: string, value: string) { data.set(key, value); }, getItem: (key: string) => data.get(key) ?? null,
    removeItem(key: string) { data.delete(key); },
  } });
  try {
    const state = emptyUriState(); state.positionUs = 1234567;
    stageUpdateState('new-build', state);
    assert.deepEqual(takeUpdateState('new-build'), state);
    assert.equal(takeUpdateState('new-build'), undefined);
    stageUpdateState('other-build', state);
    assert.equal(takeUpdateState('new-build'), undefined);
    assert.equal(data.size, 0, 'mismatched and consumed handoffs are not retained as checkpoints');
  } finally { if (previous) Object.defineProperty(globalThis, 'sessionStorage', previous); else Reflect.deleteProperty(globalThis, 'sessionStorage'); }
});

test('sharing keeps controls stable, coalesces repeated clicks and disables local tracks with a reason', async t => {
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const element = () => {
    const attributes = new Map<string, string>();
    return Object.assign(new EventTarget(), { disabled: false, dataset: {} as Record<string, string>,
      setAttribute(name: string, value: string) { attributes.set(name, value); },
      getAttribute(name: string) { return attributes.get(name); },
      removeAttribute(name: string) { attributes.delete(name); }, toggleAttribute() {} });
  };
  const elements = new Map(['app', 'workspace-share', 'start-panel'].map(id => [id, element()]));
  let finish!: (response: Response) => void, requests = 0, copies = 0, positionUs = 0;
  const writes: string[] = [], snapshots: unknown[] = [], copied: string[] = [];
  const source = { kind: 'library', id: 'a'.repeat(24), url: 'http://localhost/api/media/a/content?v=' + 'b'.repeat(24) };
  let tracks = [{ slot: 'A', id: 'track-a', source }], changed = () => {};
  const viewport = emptyUriState().viewport;
  const session = { getState: () => ({ tracks, busy: false }), subscribe(fn: () => void) { changed = fn; return () => {}; },
    subscribeProgress: () => () => {},
    exportWorkspace: () => ({ schema: 'voidplayer-workspace', version: 1, generatedAt: '', serverUrl: 'http://localhost/',
      tracks: [{ slot: 'A', mediaId: 'track-a', offsetUs: 0 }], media: [{ id: 'track-a', source }], marks: [], positionUs, viewport }) } as unknown as ReviewSession;
  for (const [key, value] of Object.entries({ window: new EventTarget(), location: { href: 'http://localhost/', origin: 'http://localhost' },
    history: { replaceState() { writes.push('replace'); }, pushState() { writes.push('push'); } },
    document: { getElementById: (id: string) => elements.get(id) ?? null },
    navigator: { clipboard: { async writeText(url: string) { copies++; copied.push(url); } } },
    fetch: (_url: string, options: RequestInit) => {
      requests++; snapshots.push(JSON.parse(String(options.body)).state);
      return new Promise<Response>(resolve => { finish = resolve; });
    } })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  t.mock.timers.enable({ apis: ['setInterval'] });
  const controller = installUriState(session, { capture: () => ({ viewport }), beforeRestore() {}, restore() {}, closeSettings: async () => {},
    identityReady: Promise.resolve(), editsReady: () => true, toasts: { show() {} } as never, act: async action => { await action(); } });
  try {
    positionUs = 1500000; viewport.zoom = 2; viewport.offsetX = 73; viewport.offsetY = -29;
    changed(); t.mock.timers.tick(1500);
    assert.deepEqual(writes, [], 'loaded playback and viewport changes never update the address');
    const first = controller.shareState!(), second = controller.shareState!();
    assert.equal(requests, 1);
    assert.deepEqual(snapshots, [controller.exportState()], 'sharing captures the current state on demand');
    positionUs = 2000000; viewport.offsetX = 90; t.mock.timers.tick(1000);
    for (const id of ['workspace-share']) {
      assert.equal(elements.get(id)!.disabled, false);
      assert.equal(elements.get(id)!.getAttribute('aria-busy'), 'true');
    }
    finish(Response.json({ url: '/?s=2.n.AAA' }));
    assert.deepEqual(await first, await second); assert.equal(copies, 1);
    assert.deepEqual(writes, [], 'sharing and later gestures leave the address unchanged');
    const later = controller.shareState!();
    assert.equal(requests, 2);
    assert.deepEqual(snapshots[1], controller.exportState(), 'a later share captures the changed scene');
    finish(Response.json({ url: '/?s=2.n.BBB' })); await later;
    assert.deepEqual(writes, [], 'new share snapshots also leave browser history unchanged');
    tracks = [{ slot: 'A', id: 'local-a', source: undefined! }]; changed();
    for (const id of ['workspace-share']) {
      assert.equal(elements.get(id)!.disabled, true);
      assert.match(elements.get(id)!.dataset.tooltip, /本地文件不能分享/);
      assert.equal(elements.get(id)!.getAttribute('aria-busy'), undefined);
    }
    tracks = [{ slot: 'A', id: 'track-a', source }]; changed();
    assert.equal(elements.get('workspace-share')!.disabled, false);
  } finally {
    controller.dispose();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
