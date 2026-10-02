import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { FlvEngine } from '../src/flv-engine.ts';
import { FlvIndexClient } from '../src/flv-index-client.ts';
import { demuxFlv, FlvReader } from '../src/flv-demux.ts';

for (const finish of ['complete', 'dispose'] as const) test(`repeated native startup seeks stay independent of a blocked index and release retained frames on ${finish}`, async t => {
  let created = 0, closed = 0, submitted = 0, flushed = 0;
  class Frame {
    timestamp: number;
    format = 'I420'; codedWidth = 320; codedHeight = 192; displayWidth = 320; displayHeight = 180;
    visibleRect = { x: 0, y: 0, width: 320, height: 180 }; colorSpace = {};
    released = false;
    constructor(timestamp: number) { this.timestamp = timestamp; created++; }
    allocationSize() { return 320 * 180 * 3 / 2; }
    clone() { assert.equal(this.released, false); return new Frame(this.timestamp); }
    close() { assert.equal(this.released, false, 'every independently owned frame closes exactly once'); this.released = true; closed++; }
  }
  class Chunk { timestamp: number; constructor(init: EncodedVideoChunkInit) { this.timestamp = init.timestamp; } }
  class Decoder {
    state = 'configured'; decodeQueueSize = 0; pending: Chunk[] = [];
    callbacks: VideoDecoderInit;
    constructor(callbacks: VideoDecoderInit) { this.callbacks = callbacks; }
    static async isConfigSupported(config: VideoDecoderConfig) { return { supported: true, config }; }
    configure() {} reset() { this.pending = []; this.decodeQueueSize = 0; }
    close() { this.reset(); this.state = 'closed'; }
    output() { for (const chunk of this.pending.splice(0)) { this.decodeQueueSize--; this.callbacks.output(new Frame(chunk.timestamp) as unknown as VideoFrame); } }
    async flush() { flushed++; this.output(); }
    // A single startup packet produces output only on flush. Once streaming,
    // another packet releases it without flushing the growing decode frontier.
    decode(chunk: Chunk) { submitted++; this.pending.push(chunk); this.decodeQueueSize++; if (this.pending.length === 2) this.output(); }
  }
  for (const [name, value] of [['VideoDecoder', Decoder], ['EncodedVideoChunk', Chunk]] as const) {
    const saved = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => { if (saved) Object.defineProperty(globalThis, name, saved); else Reflect.deleteProperty(globalThis, name); });
  }
  const file = new Blob([await readFile(new URL('../fixtures/flv/standard-h264.flv', import.meta.url))]);
  const reader = new FlvReader({ file });
  const fullIndex = await demuxFlv(reader); reader.close();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  t.mock.method(FlvIndexClient.prototype, 'read', async () => { await gate; return fullIndex; });
  const engine = new FlvEngine({ file });
  const within = async <T>(work: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('startup seek waited for the blocked index')), 1000); })]); }
    finally { clearTimeout(timer); }
  };
  let indexing: Promise<unknown> | undefined;
  try {
    const info = await engine.open('', undefined, false, 1, undefined, true);
    assert.equal(info?.decoder, 'webcodecs'); assert.equal(engine.indexComplete, false);
    const origin = info!.firstPtsUs;
    (await engine.at(origin)).frame!.close();
    indexing = engine.completeIndex();
    const decodeCount = submitted, flushCount = flushed;
    for (let i = 0; i < 3; i++) {
      const frame = await within(engine.at(origin));
      assert.equal(frame.pts, origin); frame.frame!.close();
    }
    assert.equal(submitted, decodeCount, 'already decoded startup output never needs another packet');
    assert.equal(flushed, flushCount, 'seeking startup does not flush the live decoder');
    if (finish === 'complete') {
      release(); await indexing;
      assert.equal(created, closed, 'completion releases the retained startup resource');
      const next = await engine.next(origin);
      assert.equal(next!.pts, fullIndex.packets[1].pts); next!.frame!.close();
      const first = await engine.at(origin); assert.equal(first.pts, origin); first.frame!.close();
    } else {
      engine.close();
      assert.equal(created, closed, 'disposal releases startup while the index is still blocked');
    }
  } finally {
    release(); await indexing; engine.close();
  }
  assert.equal(created, closed, 'all owned frame resources were released');
});
