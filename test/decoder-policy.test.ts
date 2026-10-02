import { test } from 'node:test';
import assert from 'node:assert/strict';
import { preferredVideoConfig } from '../src/decoder-policy.ts';
// Only the SPS prefix needed for the declared reorder bound; geometry stays unknown.
function hevcDescription(reorder = 0) {
  const ue = (v: number) => { const bits = (v + 1).toString(2); return '0'.repeat(bits.length - 1) + bits; };
  const bits = '00000001' + '0'.repeat(96) + ue(0) + ue(1) + ue(4) + ue(4) + '0' + ue(0) + ue(0) + ue(0) + '0' + ue(Math.max(2, reorder)) + ue(reorder) + ue(0) + '1';
  const nal = [0x42, 1];
  for (let at = 0; at < bits.length; at += 8) {
    const value = parseInt(bits.slice(at, at + 8).padEnd(8, '0'), 2);
    if (nal.length >= 4 && nal.at(-1) === 0 && nal.at(-2) === 0 && value <= 3) nal.push(3);
    nal.push(value);
  }
  const header = new Uint8Array(23); header[0] = 1; header[21] = 3; header[22] = 1;
  return Uint8Array.from([...header, 33, 0, 1, nal.length >> 8, nal.length & 255, ...nal]);
}
test('hardware preference is attempted before automatic browser decoding', async () => {
  const attempts: string[] = [];
  const original = { codec: 'avc1.640028', codedWidth: 1920, codedHeight: 1080 };
  for (const hardware of [true, false]) {
    attempts.length = 0;
    const config = await preferredVideoConfig(original, async config => {
      attempts.push(config.hardwareAcceleration!);
      return { supported: hardware || config.hardwareAcceleration === 'no-preference', config };
    });
    assert.equal(config?.hardwareAcceleration, hardware ? 'prefer-hardware' : 'no-preference');
    assert.deepEqual(attempts, hardware ? ['prefer-hardware'] : ['prefer-hardware', 'no-preference']);
    assert.equal(config?.codec, original.codec);
  }
  assert.equal(await preferredVideoConfig(original, async config => ({ supported: false, config })), null);
  assert.deepEqual(original, { codec: 'avc1.640028', codedWidth: 1920, codedHeight: 1080 });
});

test('FLV capability rejection records both preferences without claiming hardware use', async t => {
  const { nativeFlvDecoder } = await import('../src/flv-decoder.ts');
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'VideoDecoder');
  Object.defineProperty(globalThis, 'VideoDecoder', { configurable: true, value: { isConfigSupported: async (config: VideoDecoderConfig) => ({ supported: false, config }) } });
  t.after(() => { if (saved) Object.defineProperty(globalThis, 'VideoDecoder', saved); else Reflect.deleteProperty(globalThis, 'VideoDecoder'); });
  const events: Record<string, unknown>[] = [];
  const decoder = await nativeFlvDecoder({ codec: 'hevc', description: hevcDescription(), packets: [], order: [], firstPts: 0, duration: 0, durations: [] },
    { codec: 'hvc1.2.4.L153.B0', codedWidth: 3840, codedHeight: 2160 }, event => events.push(event));
  assert.equal(decoder, null);
  assert.deepEqual(events.map(e => [e.hardwareAcceleration, e.supported, e.codedWidth]), [['prefer-hardware', false, 3840], ['no-preference', false, 3840]]);
});

test('opaque native output remains WebCodecs through receive without allocation or cloning', async t => {
  const { nativeFlvDecoder } = await import('../src/flv-decoder.ts');
  let output!: (frame: VideoFrame) => void;
  class Decoder {
    state = 'configured';
    static async isConfigSupported(config: VideoDecoderConfig) { return { supported: true, config }; }
    constructor(callbacks: VideoDecoderInit) { output = callbacks.output; }
    configure() {} close() { this.state = 'closed'; }
  }
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'VideoDecoder');
  Object.defineProperty(globalThis, 'VideoDecoder', { configurable: true, value: Decoder });
  t.after(() => { if (saved) Object.defineProperty(globalThis, 'VideoDecoder', saved); else Reflect.deleteProperty(globalThis, 'VideoDecoder'); });
  const decoder = await nativeFlvDecoder({ codec: 'hevc', description: hevcDescription(), packets: [], order: [], firstPts: 0, duration: 0, durations: [] },
    { codec: 'hvc1.2.4.L153.B0', codedWidth: 3840, codedHeight: 2160 });
  assert.equal(decoder!.kind, 'webcodecs');
  let closed = 0;
  try {
    for (const [i, transfer] of ['pq', 'pq', 'bt709'].entries()) {
      const frame = { timestamp: i * 40000, codedWidth: 3840, codedHeight: 2160, displayWidth: 3840, displayHeight: 2160,
        visibleRect: { x: 0, y: 0, width: 3840, height: 2160 }, format: null,
        colorSpace: { primaries: 'bt2020', transfer, matrix: 'bt2020-ncl', fullRange: false },
        allocationSize() { assert.fail('opaque frame must not request readable allocation'); },
        clone() { assert.fail('description must not clone a native resource'); }, close() { closed++; } } as unknown as VideoFrame;
      output(frame);
      const result = decoder!.receive(i * 40000)!;
      assert.equal(result.frame, frame); assert.equal(result.description.color.transfer, transfer);
      assert.equal(result.description.format, null); assert.equal(result.description.byteLengthEstimated, true);
      assert.equal(result.description.byteLength, 3840 * 2160 * 8);
      assert.equal(closed, i); result.frame!.close();
    }
  } finally { decoder!.close(); }
  assert.equal(closed, 3);
});

test('4K opaque batches drain with backpressure and no skipped packet after deferred input', async t => {
  const { nativeFlvDecoder } = await import('../src/flv-decoder.ts');
  const { PacketTimeline } = await import('../src/packet-timeline.ts');
  let closeCount = 0, submitted = 0;
  class Chunk { timestamp: number; constructor(init: EncodedVideoChunkInit) { this.timestamp = init.timestamp; } }
  class Decoder {
    state = 'configured'; decodeQueueSize = 0; pending: Chunk[] = [];
    callbacks: VideoDecoderInit;
    constructor(callbacks: VideoDecoderInit) { this.callbacks = callbacks; }
    static async isConfigSupported(config: VideoDecoderConfig) { return { supported: true, config }; }
    configure() {} reset() { this.pending = []; this.decodeQueueSize = 0; } close() { this.reset(); this.state = 'closed'; }
    async flush() {
      for (const chunk of this.pending.splice(0)) {
        this.decodeQueueSize--;
        this.callbacks.output({ timestamp: chunk.timestamp, format: null, codedWidth: 3840, codedHeight: 2160, displayWidth: 3840, displayHeight: 2160,
          visibleRect: { x: 0, y: 0, width: 3840, height: 2160 }, colorSpace: { primaries: 'bt2020', transfer: 'pq', matrix: 'bt2020-ncl', fullRange: false },
          allocationSize() { assert.fail('opaque'); }, close() { closeCount++; } } as unknown as VideoFrame);
      }
    }
    decode(chunk: Chunk) { submitted++; this.pending.push(chunk); this.decodeQueueSize++; if (this.pending.length === 8) void this.flush(); }
  }
  for (const [name, value] of [['VideoDecoder', Decoder], ['EncodedVideoChunk', Chunk]] as const) {
    const saved = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => { if (saved) Object.defineProperty(globalThis, name, saved); else Reflect.deleteProperty(globalThis, name); });
  }
  const packets = Array.from({ length: 80 }, (_, i) => ({ pts: i * 20000, dts: i * 20000, offset: i, size: 1, key: i === 0 }));
  const index = { codec: 'hevc' as const, description: hevcDescription(), packets, order: packets.map((_, i) => i), firstPts: 0, duration: 1600000, durations: packets.map(() => 20000) };
  const decoder = (await nativeFlvDecoder(index, { codec: 'hvc1.2.4.L153.B0' }))!;
  const timeline = new PacketTimeline(index, decoder, async () => new Uint8Array(1));
  try {
    let frame = await timeline.at(0);
    assert.equal(frame.pts, 0); frame.frame!.close();
    // Seven queued outputs mean another compressed packet must remain unaccepted.
    assert.equal(await decoder.send(new Uint8Array(1), packets[8]), false);
    assert.equal(submitted, 8);
    for (let i = 1; i < packets.length; i++) {
      frame = (await timeline.next((i - 1) * 20000))!;
      assert.equal(frame.pts, i * 20000); frame.frame!.close();
    }
    assert.equal(await timeline.next(1580000), null);
    assert.equal(submitted, 80); assert.equal(decoder.snapshot!().peakFrames, 8);
    assert.equal(closeCount, 80);
  } finally { timeline.close(); }
});

for (const [reorder, batch] of [[2, 1], [16, 17]]) test(`native HEVC retains late B pictures, tail and bounded backpressure (reorder=${reorder})`, async t => {
  const { nativeFlvDecoder } = await import('../src/flv-decoder.ts');
  const { PacketTimeline } = await import('../src/packet-timeline.ts');
  let submitted = 0, created = 0, closed = 0;
  class Chunk { timestamp: number; constructor(init: EncodedVideoChunkInit) { this.timestamp = init.timestamp; } }
  class Decoder {
    state = 'configured'; decodeQueueSize = 0; pending: Chunk[] = [];
    callbacks: VideoDecoderInit;
    constructor(callbacks: VideoDecoderInit) { this.callbacks = callbacks; }
    static async isConfigSupported(config: VideoDecoderConfig) { return { supported: true, config }; }
    configure() {} reset() { this.pending = []; this.decodeQueueSize = 0; }
    close() { this.reset(); this.state = 'closed'; }
    async flush() {
      for (const chunk of this.pending.splice(0)) {
        this.decodeQueueSize--; created++;
        let released = false;
        this.callbacks.output({ timestamp: chunk.timestamp, format: null, codedWidth: 3840, codedHeight: 2160, displayWidth: 3840, displayHeight: 2160,
          visibleRect: { x: 0, y: 0, width: 3840, height: 2160 }, colorSpace: {},
          close() { assert.equal(released, false, 'each frame closes once'); released = true; closed++; } } as unknown as VideoFrame);
      }
    }
    decode(chunk: Chunk) { submitted++; this.pending.push(chunk); this.decodeQueueSize++; if (this.pending.length === batch) void this.flush(); }
  }
  for (const [name, value] of [['VideoDecoder', Decoder], ['EncodedVideoChunk', Chunk]] as const) {
    const saved = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => { if (saved) Object.defineProperty(globalThis, name, saved); else Reflect.deleteProperty(globalThis, name); });
  }
  // Each reference picture arrives before two earlier B pictures, in separate callbacks.
  const order = [0, ...Array.from({ length: 16 }, (_, i) => [i * 3 + 3, i * 3 + 1, i * 3 + 2]).flat(), 49];
  const packets = order.map((n, i) => ({ pts: n * 20000, dts: i * 20000, offset: i, size: 1, key: i === 0 }));
  const index = { codec: 'hevc' as const, description: hevcDescription(reorder), packets, order: packets.map((_, i) => i).sort((a, b) => packets[a].pts - packets[b].pts), firstPts: 0, duration: 1000000, durations: packets.map(() => 20000) };
  const decoder = (await nativeFlvDecoder(index, { codec: 'hvc1.1.6.L93.B0' }))!;
  const timeline = new PacketTimeline(index, decoder, async () => new Uint8Array(1));
  try {
    let frame = await timeline.at(0); assert.equal(frame.pts, 0); frame.frame!.close();
    for (let i = 1; i < order.length; i++) { frame = (await timeline.next((i - 1) * 20000))!; assert.equal(frame.pts, i * 20000); frame.frame!.close(); }
    assert.equal(await timeline.next(980000), null); assert.equal(submitted, order.length);
    assert.equal(created, closed, 'EOF releases every delayed output');
    assert.equal(decoder.snapshot!().inputWindow, Math.max(8, reorder + 1));
    assert.ok(Number(decoder.snapshot!().peakFrames) <= Number(decoder.snapshot!().maxFrames));
    assert.ok(Number(decoder.snapshot!().peakBytes) <= Number(decoder.snapshot!().budgetBytes), 'retained pictures plus accepted batch fit the byte budget');
    const back = await timeline.at(0); assert.equal(back.pts, 0); back.frame!.close();
    // Reconfiguration discards only the old buffered resources and adopts the new bound.
    await decoder.reconfigure!({ codec: 'hevc', description: hevcDescription() });
    assert.equal(decoder.snapshot!().reorderFrames, 0);
    assert.equal(created, closed);
  } finally { timeline.close(); }
  assert.equal(created, closed, 'reset/reconfigure/close leave no native resources');
});

test('native HEVC declines unknown reorder bounds before accepting input', async t => {
  const { nativeFlvDecoder } = await import('../src/flv-decoder.ts');
  const events: Record<string, unknown>[] = [];
  assert.equal(await nativeFlvDecoder({ codec: 'hevc', description: new Uint8Array(), packets: [], order: [], firstPts: 0, duration: 0, durations: [] }, undefined, event => events.push(event)), null);
  assert.equal(events[0].reason, 'hevc-reorder-unknown');
});
