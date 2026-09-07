import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeTsVideo, explainMediaFailure } from '../src/media-diagnostics.ts';
import { MediaOpenError } from '../src/media-errors.ts';
import { sampleByteSize } from '../src/media.ts';

function section(body: number[]) {
  const length = body.length + 1;
  body[1] = 0xb0 | (length >> 8); body[2] = length & 255;
  let crc = 0xffffffff;
  for (const b of body) { crc ^= b << 24; for (let i = 0; i < 8; i++) crc = (crc << 1) ^ (crc & 0x80000000 ? 0x04c11db7 : 0); }
  return [...body, crc >>> 24, (crc >>> 16) & 255, (crc >>> 8) & 255, crc & 255];
}
function packet(pid: number, payload: number[], start = true, cc = 0) {
  const data = new Uint8Array(188).fill(255);
  data.set([0x47, (pid >> 8) | (start ? 0x40 : 0), pid & 255, 0x10 | cc]);
  data.set(payload, 4); return data;
}
function fixture(types: number[], stride = 188, split = false) {
  const pat = section([0, 0, 0, 0, 1, 0xc1, 0, 0, 0, 1, 0xe1, 0]);
  const pmt = section([2, 0, 0, 0, 1, 0xc1, 0, 0, 0xe1, 1, 0xf0, 0,
    ...types.flatMap((type, i) => [type, 0xe1, i + 1, 0xf0, 0])]);
  const packets = [packet(0, [0, ...pat])];
  if (split) {
    const first = packet(256, [0, ...pmt.slice(0, 7)]);
    first[3] = 0x30; first[4] = 175; first[5] = 0; first.fill(255, 6, 180);
    first.set([0, ...pmt.slice(0, 7)], 180);
    packets.push(first, packet(256, pmt.slice(7), false, 1));
  } else packets.push(packet(256, [0, ...pmt]), packet(8191, []));
  const result = new Uint8Array(packets.length * stride);
  packets.forEach((p, i) => result.set(p, i * stride + (stride === 192 ? 4 : 0)));
  return result;
}

test('PSI identifies AVS3/HEVC correctly across TS, M2TS and FEC packet layouts', () => {
  for (const stride of [188, 192, 204]) {
    assert.deepEqual(probeTsVideo(fixture([0xd4, 0x24, 0x06], stride)), ['AVS3', 'H.265 / HEVC']);
    assert.deepEqual(probeTsVideo(fixture([0xd4], stride, true)), ['AVS3']);
  }
});
test('corrupt CRC, lost PSI continuity, unknown private PES and arbitrary bytes make no codec claims', () => {
  const crc = fixture([0xd4]); crc[188 + 18] ^= 1;
  assert.deepEqual(probeTsVideo(crc), []);
  const gap = fixture([0xd4], 188, true); gap[376 + 3] = 0x13;
  assert.deepEqual(probeTsVideo(gap), []);
  assert.deepEqual(probeTsVideo(fixture([0x06])), []);
  assert.deepEqual(probeTsVideo(new Uint8Array(1000)), []);
});
test('failed opens retain declared codecs without overriding resource/network failures', async () => {
  const input = { file: new Blob([fixture([0xd4])]) };
  const generic = new MediaOpenError('container', 'generic');
  const explained = await explainMediaFailure(input, generic, generic);
  assert.ok(explained instanceof MediaOpenError); assert.match(explained.message, /AVS3/);
  const network = new MediaOpenError('input', 'network');
  assert.equal(await explainMediaFailure(input, generic, network), network);
  const coreUnavailable = new Error('Unable to load WASM core');
  assert.equal(await explainMediaFailure(input, generic, coreUnavailable), coreUnavailable);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(explainMediaFailure(input, generic, generic, controller.signal), { name: 'AbortError' });
});
test('native frame accounting uses pixel allocation and safely estimates opaque surfaces', () => {
  assert.equal(sampleByteSize({ displayWidth: 7680, displayHeight: 4320, allocationSize: () => 49766400 }), 49766400);
  assert.equal(sampleByteSize({ displayWidth: 7680, displayHeight: 4320, allocationSize: () => { throw new Error('opaque'); } }), 132710400);
});
