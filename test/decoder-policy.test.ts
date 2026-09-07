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
