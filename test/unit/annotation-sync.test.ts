import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { registerHooks } from 'node:module';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { ReviewSession } from '../../src/session.ts';
import type { AnnotationDocument } from '../../shared/review/annotation-record.ts';

// Exercise the real sync client and IndexedDB adapter without presentation DOM.
const hooks = registerHooks({ load(url, context, next) {
  if (url.endsWith('/src/ui/annotation-activity.ts')) return { format: 'module',
    source: 'export const installAnnotationActivity = () => ({ update() {} });', shortCircuit: true };
  return next(url, context);
} });
const { installAnnotationSync } = await import('../../src/ui/annotation-sync.ts');
hooks.deregister();

test('shared annotation polling backs off, caps idle delay, and wakes for edits, visibility, identity and reconnect', async t => {
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const window = new EventTarget(), document = Object.assign(new EventTarget(), { hidden: false, querySelectorAll: () => [] });
  const local = new Map<string, string>(), session = new Map<string, string>();
  const store = (values: Map<string, string>) => ({ getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
  const requests: { url: string; at: number }[] = [];
  let now = 0, actor = 'alice', failEvents = false, remoteCursor = 0;
  const fetch = async (input: string | URL | Request) => {
    const url = String(input); requests.push({ url, at: now });
    if (url === '/api/health') return Response.json({ service: 'voidplayer-media', actor: { id: actor, name: actor }, capabilities: { annotations: true } });
    if (url.startsWith('/api/annotations/events/')) return Response.json({ schema: 'voidplayer-annotation-events', version: 1, space: 'shared', events: [], cursor: remoteCursor,
      head: remoteCursor, more: false, resetRequired: false, snapshotUrl: '/api/annotations/spaces/shared' }, { status: failEvents ? 503 : 200 });
    return Response.json({ entries: [], cursor: remoteCursor, more: false, previewEpoch: 0 });
  };
  for (const [key, value] of Object.entries({ window, document, localStorage: store(local), sessionStorage: store(session),
    location: { origin: 'http://localhost', href: 'http://localhost/' }, fetch, indexedDB: new IDBFactory() })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  t.mock.method(performance, 'now', () => now);
  t.mock.method(performance, 'getEntriesByType', () => []);
  t.mock.timers.enable({ apis: ['setInterval'] });
  let change!: (id: string, document: AnnotationDocument | null) => void;
  const controller = installAnnotationSync({ subscribe: () => () => {}, subscribeMarkChanges: (callback: typeof change) => { change = callback; return () => {}; },
    getState: () => ({ tracks: [], marks: [], playing: false }), applyStoredAnnotations() {} } as unknown as ReviewSession, () => false);
  const settle = async () => { for (let i = 0; i < 60; i++) await setImmediate(); };
  t.after(async () => {
    await settle(); controller.dispose();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  });
  const advance = async (ms: number) => { now += ms; t.mock.timers.tick(ms); await settle(); };
  const reads = () => requests.filter(request => request.url.startsWith('/api/annotations/'));
  await settle(); await controller.openSpace('shared');
  requests.length = 0;
  for (const delay of [3000, 6000, 12000, 15000, 15000]) {
    const count = reads().length;
    await advance(delay - 1); assert.equal(reads().length, count, 'no request before the idle deadline');
    await advance(1); assert.equal(reads().length, count + 2, 'events and state are read once at the deadline');
  }
  assert.deepEqual(reads().filter(request => request.url.includes('/events/')).map(request => request.at), [3000, 9000, 21000, 36000, 51000]);

  change('unsent-deletion', null); await settle();
  let count = reads().length;
  await advance(1000); assert.equal(reads().length, count + 2, 'a local edit wakes the idle observer on its next tick');
  document.hidden = true; document.dispatchEvent(new Event('visibilitychange'));
  count = reads().length; await advance(30000); assert.equal(reads().length, count, 'hidden pages do not poll');
  document.hidden = false; document.dispatchEvent(new Event('visibilitychange')); await settle();
  assert.equal(reads().length, count + 2, 'visibility resumes immediately');
  count = reads().length; window.dispatchEvent(new Event('focus')); await settle();
  assert.equal(reads().length, count + 2, 'focus refreshes immediately');

  failEvents = true;
  count = reads().length; await advance(3000); assert.equal(reads().length, count + 2, 'event failure does not block state reads');
  count = reads().length; await advance(3000); assert.equal(reads().length, count + 2, 'failures retain the fast retry cadence');
  failEvents = false; remoteCursor++;
  await advance(3000);
  count = reads().length; await advance(3000); assert.equal(reads().length, count + 2, 'remote changes reset the idle delay');

  actor = 'bob';
  window.dispatchEvent(new Event('online')); await settle();
  assert.equal(requests.at(-3)?.url, '/api/health', 'reconnect confirms identity before syncing');
  count = reads().length; await advance(3000); assert.equal(reads().length, count + 2, 'identity changes resume fast polling');
  controller.dispose(); count = requests.length; await advance(30000);
  assert.equal(requests.length, count, 'disposal stops polling');
});
