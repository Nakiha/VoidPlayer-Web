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
