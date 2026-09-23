import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionResources } from '../src/session/resources.ts';
import { FrameQueue } from '../src/playback.ts';
import { rgbaDescription } from '../src/frame-description.ts';
import { ThumbnailUrlCache } from '../src/thumbnails/url-cache.ts';
import { thumbnailEvictions } from '../src/thumbnails/local-store.ts';
import { localCacheKey, THUMB_RECIPE_VERSION } from '../src/thumbnails/contract.ts';
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('shared queue budget reserves concurrent pulls, preserves required frames and releases stopped/late frames', async () => {
  const resources = new SessionResources(800); let made = 0, closed = 0;
  async function* frames() { for (let i = 0; i < 20; i++) { made++; yield { ptsUs: i, sourcePtsUs: i, durationUs: 1, byteSize: 400, width: 10, height: 10, kind: 'rgba8' as const, description: rgbaDescription(10, 10), close() { closed++; } }; } }
  const a = new FrameQueue(frames(), 4, undefined, resources, 400), b = new FrameQueue(frames(), 4, undefined, resources, 400);
  await tick();
  assert.equal(a.frames.length, 1); assert.equal(b.frames.length, 1); assert.equal(resources.totalBytes, 800);
  const shown = a.take(0).frame!; assert.equal(resources.totalBytes, 800, 'taken frame remains owned until closed');
  shown.close(); await tick(); assert.ok(a.frames.length >= 1, 'required next frame always makes progress');
  a.stop(); b.stop(); await Promise.all([a.done, b.done]);
  assert.equal(resources.totalBytes, 0); assert.equal(closed, made);
});
test('essential frames cancel optional jobs instead of dropping review data', () => {
  const resources = new SessionResources(100); const release = resources.reserve('derived', 70)!;
  let cancelled = false; const unsubscribe = resources.cancelOnPressure(() => { cancelled = true; release(); });
  const required = resources.reserve('readback', 150, true)!;
  assert.ok(cancelled); assert.equal(resources.snapshot().overBudgetBytes, 50);
  assert.equal(resources.reserve('derived', 1), null);
  required(); unsubscribe(); assert.equal(resources.totalBytes, 0);
});
test('visible URL leases survive LRU eviction and replacement; unused URLs are bounded', () => {
  let next = 0; const revoked: string[] = [];
  const cache = new ThumbnailUrlCache(10, 2, () => `blob:${++next}`, url => { revoked.push(url); });
  const old = cache.put('a', new Blob(['123456'])); cache.retain(old);
  cache.put('b', new Blob(['123456'])); cache.put('c', new Blob(['123456'])); cache.trim();
  assert.equal(cache.get('a'), old); assert.equal(cache.get('b'), undefined);
  const replacement = cache.put('a', new Blob(['123456'])); cache.retain(replacement); cache.trim();
  assert.ok(!revoked.includes(old)); cache.release(old); assert.ok(revoked.includes(old));
  cache.release(replacement); cache.clear(); assert.equal(new Set(revoked).size, next);
});
test('thumbnail LRU evicts by bytes and count; local identity includes recipe', () => {
  const records = [{ key: 'old', bytes: 7, accessedAt: 1 }, { key: 'new', bytes: 7, accessedAt: 3 }, { key: 'middle', bytes: 2, accessedAt: 2 }];
  assert.deepEqual(thumbnailEvictions([...records], 10, 10), ['old']);
  assert.deepEqual(thumbnailEvictions([...records], 100, 1), ['old', 'middle']);
  assert.ok(localCacheKey('a.mp4', 1, 2).includes(THUMB_RECIPE_VERSION));
});
