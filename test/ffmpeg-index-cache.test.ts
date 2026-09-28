import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFfmpegIndex, serializeFfmpegIndex } from '../src/ffmpeg-index-cache.ts';

const metadata = { size: 1024, codec: 'mpeg2video', timeBaseNum: 1, timeBaseDen: 90000, width: 1280, height: 720 };

function records() {
  const bytes = new Uint8Array(48);
  const view = new DataView(bytes.buffer);
  view.setBigInt64(0, 10n, true); view.setBigInt64(8, 3000n, true); view.setUint32(16, 1, true);
  view.setBigInt64(24, 20n, true); view.setBigInt64(32, 3000n, true); view.setUint32(40, 0, true);
  return bytes;
}

test('FFmpeg index documents round-trip the fixed binary ABI and enforce source metadata', () => {
  const document = serializeFfmpegIndex(metadata, records());
  const parsed = parseFfmpegIndex(document, metadata.size, metadata);
  assert.ok(parsed);
  assert.equal(parsed.document.count, 2);
  assert.deepEqual([...parsed.records], [...records()]);
  assert.equal(parseFfmpegIndex(document, metadata.size + 1), null);
  assert.equal(parseFfmpegIndex(document, metadata.size, { codec: 'h264' }), null);
});

test('FFmpeg index documents reject malformed flags, reserved bits, and unsorted timestamps', () => {
  for (const mutate of [
    (view: DataView) => view.setUint32(16, 2, true),
    (view: DataView) => view.setUint32(20, 1, true),
    (view: DataView) => view.setBigInt64(24, 9n, true),
  ]) {
    const bytes = records(), view = new DataView(bytes.buffer);
    mutate(view);
    assert.equal(parseFfmpegIndex(serializeFfmpegIndex(metadata, bytes), metadata.size), null);
  }
});
