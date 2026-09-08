import { test } from 'node:test';
import assert from 'node:assert/strict';
import { preferredVideoConfig } from '../src/decoder-policy.ts';
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
  const decoder = await nativeFlvDecoder({ codec: 'hevc', description: new Uint8Array(), packets: [], order: [], firstPts: 0, duration: 0, durations: [] },
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
  const decoder = await nativeFlvDecoder({ codec: 'hevc', description: new Uint8Array(), packets: [], order: [], firstPts: 0, duration: 0, durations: [] },
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
