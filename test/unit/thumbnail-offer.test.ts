import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rgbaDescription } from '../../shared/media/frame-description.ts';
import type { DecodedFrame } from '../../src/media/contract.ts';
import { offerFirstFrameCandidate, settleOffer } from '../../src/thumbnails/offer.ts';
import type { FirstFrameContext } from '../../src/thumbnails/offer.ts';
import { thumbnailState } from '../../src/thumbnails/state.ts';
import { THUMB_FRAME_BUDGET_BYTES } from '../../shared/thumbnails/contract.ts';

function context(overrides: Partial<FirstFrameContext> = {}): FirstFrameContext {
  return {
    cacheKey: `test|${Math.random().toString(36).slice(2)}`,
    kind: 'local', sourceGen: 1, sourcePtsUs: 1000, isFileFirst: true, byteSize: 400,
    ...overrides,
  };
}

function rgbaFrame(size = 16): DecodedFrame {
  const pixels = new Uint8ClampedArray(size);
  return {
    ptsUs: 0, sourcePtsUs: 1000, durationUs: 40000,
    description: rgbaDescription(2, 2), kind: 'rgba8', width: 2, height: 2,
    byteSize: size, pixels, close() {},
  };
}

function sampleFrame(): { frame: DecodedFrame; closes: () => number } {
  let closed = 0, clones = 0;
  const sample = {
    rotation: 0,
    clone() { clones++; return { rotation: 0, close() { closed++; } }; },
    close() {},
  };
  const frame = {
    ptsUs: 0, sourcePtsUs: 2000, durationUs: 40000,
    description: rgbaDescription(2, 2), kind: 'video-sample' as const, width: 2, height: 2,
    byteSize: 400, sample, close() {},
  } as unknown as DecodedFrame;
  return { frame, closes: () => closed };
}

test('non-first positions never produce a candidate and never seek', () => {
  thumbnailState.reset();
  const result = offerFirstFrameCandidate(context({ isFileFirst: false }), rgbaFrame());
  assert.equal(result, 'not-first-frame');
  assert.equal(thumbnailState.inFlight.size, 0);
});

test('dedupe: completed and in-flight keys are not re-accepted', () => {
  thumbnailState.reset();
  const key = 'dedupe|1';
  thumbnailState.completed.add(key);
  assert.equal(offerFirstFrameCandidate(context({ cacheKey: key }), rgbaFrame()), 'already-cached');
  thumbnailState.completed.clear();
  thumbnailState.inFlight.add(key);
  assert.equal(offerFirstFrameCandidate(context({ cacheKey: key }), rgbaFrame()), 'in-flight');
});

test('unsupported resources stay missing without holding anything', () => {
  thumbnailState.reset();
  // video-sample without a sample cannot be cloned.
  const bare = { ...rgbaFrame(), kind: 'video-sample' as const, pixels: undefined, sample: undefined };
  assert.equal(offerFirstFrameCandidate(context(), bare), 'unsupported');
  const hdr = { ...rgbaFrame(), description: {
    ...rgbaFrame().description,
    color: { primaries: null, transfer: 'pq', matrix: null, fullRange: true },
    sourceColor: { primaries: null, transfer: 'pq', matrix: null, fullRange: true },
  } };
  assert.equal(offerFirstFrameCandidate(context(), hdr), 'unsupported');
  assert.equal(thumbnailState.holdingFull, false);
  assert.equal(thumbnailState.inFlight.size, 0);
});

test('budgets bound held bytes and the single hold slot', () => {
  thumbnailState.reset();
  assert.equal(offerFirstFrameCandidate(context({ byteSize: THUMB_FRAME_BUDGET_BYTES + 1 }), rgbaFrame()), 'budget-exceeded');
  thumbnailState.holdingFull = true;
  assert.equal(offerFirstFrameCandidate(context(), rgbaFrame()), 'budget-exceeded');
});

test('stale tracks are rejected', () => {
  thumbnailState.reset();
  assert.equal(offerFirstFrameCandidate(context({ isLive: () => false }), rgbaFrame()), 'stale');
});

test('accepted video-sample clones without touching the original', () => {
  thumbnailState.reset();
  let originalClosed = false;
  const { frame, closes } = sampleFrame();
  (frame as { close: () => void }).close = () => { originalClosed = true; };
  const offered = offerFirstFrameCandidate(context({ epoch: 7 }), frame);
  assert.equal(typeof offered, 'object');
  assert.equal((offered as { result: string }).result, 'accepted');
  assert.equal(originalClosed, false);
  // Epoch is frozen at accept.
  assert.equal(thumbnailState.cachedEpoch((offered as { context: FirstFrameContext }).context.cacheKey), 7);
  const owned = (offered as import('../../src/thumbnails/offer.ts').AcceptedOffer).owned;
  (offered as import('../../src/thumbnails/offer.ts').AcceptedOffer).release();
  assert.equal(closes(), 1);
  assert.equal(originalClosed, false);
  settleOffer((offered as { context: FirstFrameContext }).context.cacheKey, true);
  assert.ok(thumbnailState.completed.has((offered as { context: FirstFrameContext }).context.cacheKey));
});

test('accepted pixel frames copy once and stay independent', () => {
  thumbnailState.reset();
  const frame = rgbaFrame(16);
  const offered = offerFirstFrameCandidate(context(), frame);
  assert.equal((offered as { result: string }).result, 'accepted');
  const owned = (offered as import('../../src/thumbnails/offer.ts').AcceptedOffer).owned;
  assert.notEqual(owned.pixels!.buffer, frame.pixels!.buffer);
  frame.pixels!.fill(9);
  assert.equal(owned.pixels![0], 0);
  (offered as import('../../src/thumbnails/offer.ts').AcceptedOffer).release();
  settleOffer((offered as { context: FirstFrameContext }).context.cacheKey, false);
  assert.equal(thumbnailState.holdingFull, false);
  assert.ok(!thumbnailState.completed.has((offered as { context: FirstFrameContext }).context.cacheKey));
});


test('settling A cannot release B, and the hold expires without queue progress', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  thumbnailState.reset();
  const a = offerFirstFrameCandidate(context({ cacheKey: 'a' }), rgbaFrame());
  assert.equal(typeof a, 'object'); if (typeof a !== 'object') return;
  a.release(); // A now waits on encoding/storage/upload.
  const sample = sampleFrame();
  const b = offerFirstFrameCandidate(context({ cacheKey: 'b' }), sample.frame);
  assert.equal(typeof b, 'object'); if (typeof b !== 'object') return;
  settleOffer('a', true);
  assert.equal(thumbnailState.holdingFull, true);
  assert.equal(offerFirstFrameCandidate(context(), rgbaFrame()), 'budget-exceeded');
  let terminated = 0;
  b.onExpire = () => terminated++;
  t.mock.timers.tick(500);
  assert.equal(terminated, 1);
  assert.equal(b.expired, true);
  assert.equal(thumbnailState.holdingFull, false);
  const c = offerFirstFrameCandidate(context({ cacheKey: 'c' }), rgbaFrame());
  assert.equal(typeof c, 'object'); if (typeof c !== 'object') return;
  b.release(); settleOffer('b', false);
  assert.equal(sample.closes(), 1);
  assert.equal(thumbnailState.holdingFull, true);
  c.release(); settleOffer('c', false);
});

// Drive the real optional task from its accepted-frame boundary. This worker
// models browser event properties and real structured-clone transfer ownership.
class ThumbnailTestWorker {
  static instances: ThumbnailTestWorker[] = [];
  static failPost = false;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminated = 0;
  transferred?: { pixels: Uint8ClampedArray };
  constructor() { ThumbnailTestWorker.instances.push(this); }
  postMessage(message: { pixels: Uint8ClampedArray }, transfer: ArrayBuffer[]) {
    if (ThumbnailTestWorker.failPost) throw new Error('thumbnail clone failure');
    this.transferred = structuredClone(message, { transfer });
  }
  terminate() { this.terminated++; }
}

async function drainThumbnailTask() {
  await new Promise<void>(resolve => setImmediate(resolve));
}

for (const failure of ['messageerror', 'error', 'postMessage', 'expiry', 'success'] as const) {
  test(`optional pixel thumbnail ${failure} settles, detaches and releases only its owned frame`, async t => {
    const { runThumbnailTask } = await import('../../src/thumbnails/tasks.ts');
    thumbnailState.reset();
    ThumbnailTestWorker.instances = [];
    ThumbnailTestWorker.failPost = failure === 'postMessage';
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
    Object.defineProperty(globalThis, 'Worker', { value: ThumbnailTestWorker, configurable: true });
    t.after(() => {
      if (descriptor) Object.defineProperty(globalThis, 'Worker', descriptor);
      else Reflect.deleteProperty(globalThis, 'Worker');
    });
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const original = rgbaFrame();
    let originalCloses = 0;
    original.close = () => { originalCloses++; };
    const accepted = offerFirstFrameCandidate(context(), original);
    assert.equal(typeof accepted, 'object'); if (typeof accepted !== 'object') return;
    let ownedCloses = 0;
    const close = accepted.owned.close.bind(accepted.owned);
    accepted.owned.close = () => { ownedCloses++; close(); };
    try {
      runThumbnailTask(accepted);
      t.mock.timers.tick(0);
      const worker = ThumbnailTestWorker.instances[0];
      assert.ok(worker, 'the real task started its dedicated worker');
      const lateMessage = worker.onmessage;
      const lateError = worker.onerror;
      if (failure === 'messageerror') worker.onmessageerror?.();
      else if (failure === 'error') worker.onerror?.();
      else if (failure === 'expiry') t.mock.timers.tick(500);
      else if (failure === 'success') worker.onmessage?.({ data: { width: 2, height: 2, bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer } });
      await drainThumbnailTask();
      assert.equal(worker.terminated, 1);
      assert.equal(accepted.onExpire, undefined);
      for (const handler of ['onmessage', 'onerror', 'onmessageerror'] as const) assert.equal(worker[handler], null);
      assert.equal(thumbnailState.inFlight.size, 0);
      assert.equal(thumbnailState.holdingFull, false);
      assert.equal(thumbnailState.rendered, failure === 'success' ? 1 : 0);
      assert.equal(thumbnailState.completed.size, failure === 'success' ? 1 : 0);
      assert.equal(ownedCloses, 1);
      assert.equal(originalCloses, 0);
      assert.equal(original.pixels!.byteLength, 16);
      assert.equal(accepted.owned.pixels, undefined);
      if (failure !== 'postMessage') assert.equal(worker.transferred!.pixels.byteLength, 16);
      lateMessage?.({ data: { width: 2, height: 2, bytes: new Uint8Array([1, 2]).buffer } });
      lateError?.();
      await drainThumbnailTask();
      assert.equal(worker.terminated, 1);
      assert.equal(thumbnailState.rendered, failure === 'success' ? 1 : 0);
      assert.equal(ownedCloses, 1);
      if (failure !== 'expiry') {
        t.mock.timers.tick(500);
        assert.equal(thumbnailState.skipped['budget:hold-timeout'], undefined);
      }
      // A failed optional job must neither poison the next candidate nor use
      // its callbacks to release the next job's independent hold slot.
      ThumbnailTestWorker.failPost = false;
      const next = offerFirstFrameCandidate(context(), rgbaFrame());
      assert.equal(typeof next, 'object'); if (typeof next !== 'object') return;
      runThumbnailTask(next);
      t.mock.timers.tick(0);
      const nextWorker = ThumbnailTestWorker.instances[1];
      assert.ok(nextWorker);
      lateError?.();
      assert.equal(thumbnailState.holdingFull, true);
      nextWorker.onmessage?.({ data: null });
      await drainThumbnailTask();
      assert.equal(nextWorker.terminated, 1);
      assert.equal(thumbnailState.holdingFull, false);
      assert.equal(thumbnailState.inFlight.size, 0);
    } finally {
      accepted.onExpire?.(); accepted.release(); settleOffer(accepted.context.cacheKey, false);
      t.mock.timers.tick(500); await drainThumbnailTask();
    }
  });
}

test('pixel thumbnail task persists transferred JPEG bytes after worker termination without reading a Blob',async t=>{
  const {IDBFactory}=await import('fake-indexeddb');
  const {runThumbnailTask}=await import('../../src/thumbnails/tasks.ts');
  const {getLocalThumbnail,closeThumbnailDatabase}=await import('../../src/thumbnails/local-store.ts');
  const descriptors=new Map(['Worker','indexedDB'].map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]));
  closeThumbnailDatabase();thumbnailState.reset();ThumbnailTestWorker.instances=[];ThumbnailTestWorker.failPost=false;
  Object.defineProperty(globalThis,'Worker',{configurable:true,value:ThumbnailTestWorker});
  Object.defineProperty(globalThis,'indexedDB',{configurable:true,value:new IDBFactory()});
  t.after(()=>{closeThumbnailDatabase();for(const [name,descriptor] of descriptors){if(descriptor)Object.defineProperty(globalThis,name,descriptor);else Reflect.deleteProperty(globalThis,name);}});
  let reads=0;
  const read=t.mock.method(Blob.prototype,'arrayBuffer',async()=>{reads++;throw new Error('byte-backed task must not load an internal Blob URL');});
  const accepted=offerFirstFrameCandidate(context({cacheKey:'worker-byte-storage'}),rgbaFrame());assert.equal(typeof accepted,'object');if(typeof accepted!=='object')return;
  try{
    runThumbnailTask(accepted);await new Promise<void>(resolve=>setTimeout(resolve,0));
    const worker=ThumbnailTestWorker.instances[0];assert.ok(worker);
    const jpeg=Uint8Array.of(0xff,0xd8,0xff,0xd9),expected=jpeg.slice();
    worker.onmessage?.({data:{width:2,height:2,bytes:jpeg.buffer}});
    assert.equal(worker.terminated,1,'worker is already disposed before persistence completes');
    const deadline=Date.now()+2000;while(thumbnailState.inFlight.size&&Date.now()<deadline)await drainThumbnailTask();
    assert.equal(thumbnailState.inFlight.size,0);assert.equal(thumbnailState.holdingFull,false);
    assert.equal(reads,0,'the whole task and persistence path use the returned ArrayBuffer directly');
    assert.ok(thumbnailState.completed.has('worker-byte-storage'));
    read.mock.restore();jpeg.fill(0);closeThumbnailDatabase();
    const stored=await getLocalThumbnail('worker-byte-storage');assert.ok(stored,'actual IndexedDB bytes survive closing and reopening the connection');
    assert.deepEqual(new Uint8Array(await stored.blob.arrayBuffer()),expected);assert.equal(stored.width,2);assert.equal(stored.height,2);
  }finally{accepted.onExpire?.();accepted.release();settleOffer(accepted.context.cacheKey,false);}
});
