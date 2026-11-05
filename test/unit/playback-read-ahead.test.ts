import test from 'node:test';
import assert from 'node:assert/strict';
import { PlaybackReadAhead, BASE_CACHE_BYTES, MAX_PLAYBACK_CACHE_BYTES } from '../../shared/media/io/playback-read-ahead.ts';
import { RangeReader } from '../../shared/media/io/range-reader.ts';

const MIB = 1024 * 1024, BLOCK = 256 * 1024;

test('adaptation depends on observation age rather than realm clock origin', () => {
  const run = (origin: number) => {
    const policy = new PlaybackReadAhead(BLOCK); policy.begin(0,origin);
    for (let i = 1; i <= 8; i++) {
      policy.refilled(policy.batchBytes,150); policy.waited(30,origin+i*250);
      policy.consumed(i*6*MIB,origin+i*250);
    }
    return policy.snapshot();
  };
  assert.deepEqual(run(0),run(100000));
});

test('slow refill callbacks without missing-byte waits do not grow playback memory', () => {
  const policy = new PlaybackReadAhead(BLOCK);
  policy.begin(0,0);
  for (let i = 1; i <= 100; i++) {
    policy.refilled(2*MIB,1000);
    policy.consumed(i*MIB/4,i*250);
  }
  const stats = policy.snapshot();
  assert.equal(stats.cacheLimitBytes,BASE_CACHE_BYTES);
  assert.equal(stats.batchBytes,2*MIB);
  assert.equal(stats.inputWaitMs,0);
  assert.ok(stats.refillP95Ms >= 1000);
});

test('measured consumption plus repeated input starvation grows bounded watermarks and requests', () => {
  const policy = new PlaybackReadAhead(BLOCK);
  policy.begin(0,0);
  for (let i = 1; i <= 24; i++) {
    policy.refilled(policy.batchBytes,120+policy.batchBytes/(100*MIB)*1000);
    policy.waited(30,i*250);
    policy.consumed(i*10*MIB,i*250);
    assert.ok(policy.cacheBytes <= MAX_PLAYBACK_CACHE_BYTES);
    assert.ok(policy.lowWaterBytes+policy.batchBytes+MIB+BLOCK <= policy.cacheBytes);
  }
  const stats = policy.snapshot();
  assert.ok(stats.cacheLimitBytes > BASE_CACHE_BYTES);
  assert.ok(stats.lowWaterBytes > 2*MIB);
  assert.ok(stats.batchBytes > 2*MIB && stats.batchBytes <= 8*MIB);
  assert.ok(stats.consumptionBytesPerSecond >= 39*MIB);
  assert.equal(stats.starvationEvents,24);
});

test('an inadequate input rate cannot grow the cache past its hard ceiling', () => {
  const policy = new PlaybackReadAhead(BLOCK);
  policy.begin(0,0);
  for (let i = 1; i <= 100; i++) {
    policy.refilled(policy.batchBytes,5000);
    policy.waited(100,i*500);
    policy.consumed(i*20*MIB,i*500);
  }
  assert.equal(policy.cacheBytes,MAX_PLAYBACK_CACHE_BYTES);
  assert.equal(policy.batchBytes,8*MIB);
});

test('past warmup waits do not trigger delayed growth after input has recovered', () => {
  const policy = new PlaybackReadAhead(BLOCK);
  policy.begin(0,0);
  for (let i = 1; i <= 8; i++) {
    policy.refilled(2*MIB,150);
    if (i <= 5) policy.waited(30,i*250);
    policy.consumed(i*6*MIB,i*250);
  }
  const recovered = policy.snapshot();
  for (let i = 9; i <= 40; i++) {
    policy.refilled(policy.batchBytes,10);
    policy.consumed(i*6*MIB,i*250);
  }
  assert.equal(policy.snapshot().adjustments,recovered.adjustments);
});

test('stable lower demand returns an enlarged cache to baseline without reacting to a pause', () => {
  const policy = new PlaybackReadAhead(BLOCK);
  policy.begin(0,0);
  let position = 0;
  for (let i = 1; i <= 24; i++) {
    position += 10*MIB;
    policy.refilled(policy.batchBytes,160);
    policy.waited(30,i*250); policy.consumed(position,i*250);
  }
  const peak = policy.cacheBytes;
  policy.begin(position,30000);
  policy.consumed(position+BLOCK,30001);
  assert.equal(policy.cacheBytes,peak,'an idle gap resets rate sampling, not a throughput observation');
  position += BLOCK;
  for (let i = 1; i <= 200; i++) {
    position += BLOCK;
    policy.refilled(policy.batchBytes,1);
    policy.consumed(position,30001+i*250);
  }
  assert.equal(policy.cacheBytes,BASE_CACHE_BYTES);
  assert.equal(policy.batchBytes,2*MIB);
  assert.equal(policy.lowWaterBytes,2*MIB);
});

test('adaptive cache protects unread forward blocks and resets its budget on seek', async t => {
  let now = 0;
  t.mock.method(performance,'now',() => now);
  const pending = new Set<{at:number;release:()=>void}>(), requests: {start:number;end:number}[] = [];
  const size = 256*MIB;
  t.mock.method(globalThis,'fetch',async (_url: unknown, options: RequestInit) => {
    const [,a,b] = /^bytes=(\d+)-(\d+)$/.exec((options.headers as Record<string,string>).Range)!;
    const start = +a, end = +b, length = end-start+1;
    requests.push({start,end});
    await new Promise<void>((resolve,reject) => {
      const task = {at:now+100+length/(128*MIB)*1000,release:() => {
        options.signal?.removeEventListener('abort',abort); resolve();
      }};
      const abort = () => { pending.delete(task); reject(new DOMException('Cancelled','AbortError')); };
      options.signal?.addEventListener('abort',abort,{once:true}); pending.add(task);
    });
    const bytes = new Uint8Array(length);
    for (let at = 0; at < length; at += BLOCK) bytes.fill(Math.floor((start+at)/BLOCK)%251,at,at+BLOCK);
    return new Response(bytes,{status:206,headers:{'Content-Range':`bytes ${start}-${end}/${size}`,ETag:'"same"'}});
  });
  const tick = () => new Promise<void>(resolve => setImmediate(resolve));
  const release = () => {
    for (const task of [...pending]) if (task.at <= now) { pending.delete(task); task.release(); }
  };
  const read = async (reader: RangeReader, offset: number, length: number) => {
    let done = false;
    const task = reader.read(offset,length).finally(() => { done = true; });
    while (!done) {
      await tick();
      if (done) break;
      assert.ok(pending.size,'the read must be waiting on actual IO');
      now = Math.max(now,Math.min(...[...pending].map(task => task.at))); release();
    }
    return task;
  };
  const reader = new RangeReader({url:'https://test.invalid/video',size});
  try {
    await read(reader,0,1);
    reader.setPlaybackReadAhead(true);
    for (let position = 0; position < 192*MIB; position += BLOCK) {
      const bytes = await read(reader,position,BLOCK);
      assert.equal(bytes[0],Math.floor(position/BLOCK)%251);
      assert.equal(bytes.at(-1),bytes[0]);
      const stats = reader.readAheadSnapshot();
      assert.ok(stats.cachedBytes <= stats.cacheLimitBytes);
      assert.ok(stats.cacheLimitBytes <= MAX_PLAYBACK_CACHE_BYTES && stats.inFlightBytes <= 8*MIB);
      now += BLOCK/(48*MIB)*1000; release(); await tick();
    }
    assert.ok(reader.readAheadSnapshot().cacheLimitBytes > BASE_CACHE_BYTES);
    for (let i = 1; i < requests.length; i++) assert.equal(requests[i].start,requests[i-1].end+1,'unread data must not be evicted and fetched twice');
    const observed = requests.length;
    reader.readAheadSnapshot(); reader.cachedWindows(); reader.peek(191*MIB,1);
    assert.equal(requests.length,observed,'diagnostics never initiate IO');
    reader.setPlaybackReadAhead(false);
    assert.equal(reader.readAheadSnapshot().cacheLimitBytes,BASE_CACHE_BYTES);
    assert.ok(reader.readAheadSnapshot().cachedBytes <= BASE_CACHE_BYTES);
  } finally { reader.close(); await tick(); }
});

test('a large playback packet coalesces required bytes while probing remains demand-only', async t => {
  const requests: {start:number;end:number}[] = [], size = 16*MIB;
  t.mock.method(globalThis,'fetch',async (_url: unknown, options: RequestInit) => {
    const [,a,b] = /^bytes=(\d+)-(\d+)$/.exec((options.headers as Record<string,string>).Range)!;
    const start = +a, end = +b; requests.push({start,end});
    return new Response(new Uint8Array(end-start+1).fill(7),{status:206,headers:{'Content-Range':`bytes ${start}-${end}/${size}`}});
  });
  const reader = new RangeReader({url:'https://test.invalid/video',size});
  try {
    await reader.read(0,1);
    assert.deepEqual(requests,[{start:0,end:BLOCK-1}]);
    reader.setPlaybackReadAhead(true);
    assert.deepEqual(await reader.read(0,MIB),new Uint8Array(MIB).fill(7));
    assert.deepEqual(requests[1],{start:BLOCK,end:MIB-1},'already requested packet bytes use one bounded fetch');
    reader.setPlaybackReadAhead(false);
    const before = requests.length;
    await reader.readMetadata(8*MIB,16);
    assert.deepEqual(requests.slice(before),[{start:8*MIB,end:8*MIB+15}]);
  } finally { reader.close(); }
});
