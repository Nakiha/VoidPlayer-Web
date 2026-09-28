import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFfmpegIndex, serializeFfmpegIndex } from '../src/ffmpeg-index-cache.ts';

const metadata = {
  size: 1024, codec: 'mpeg2video', timeBaseNum: 1, timeBaseDen: 90000,
  width: 1280, height: 720, streamIndex: 0, indexerBuild: 'a'.repeat(40),
};

function records() {
  const bytes = new Uint8Array(80);
  const view = new DataView(bytes.buffer);
  view.setBigInt64(0, 10n, true); view.setBigInt64(8, 9n, true);
  view.setBigInt64(16, 3000n, true); view.setBigInt64(24, 0n, true);
  view.setInt32(32, 100, true); view.setUint32(36, 3, true);
  view.setBigInt64(40, 20n, true); view.setBigInt64(48, 19n, true);
  view.setBigInt64(56, 3000n, true); view.setBigInt64(64, -1n, true);
  view.setInt32(72, 50, true); view.setUint32(76, 0, true);
  return bytes;
}

test('FFmpeg index documents round-trip v2 seek metadata and enforce stream/build identity', () => {
  const document = serializeFfmpegIndex(metadata, records());
  const parsed = parseFfmpegIndex(document, metadata.size, metadata);
  assert.ok(parsed);
  assert.equal(parsed.document.count, 2);
  assert.deepEqual([...parsed.records], [...records()]);
  assert.equal(parseFfmpegIndex(document, metadata.size + 1), null);
  assert.equal(parseFfmpegIndex(document, metadata.size, { codec: 'h264' }), null);
  assert.equal(parseFfmpegIndex(document, metadata.size, { streamIndex: 1 }), null);
  assert.equal(parseFfmpegIndex(document, metadata.size, { indexerBuild: 'b'.repeat(40) }), null);
});

test('FFmpeg v2 records reject invalid flags, packet positions, sizes, anchors, and PTS ordering', () => {
  for (const mutate of [
    (view: DataView) => view.setUint32(36, 4, true),
    (view: DataView) => view.setInt32(32, -1, true),
    (view: DataView) => view.setBigInt64(24, -2n, true),
    (view: DataView) => view.setUint32(36, 2, true),
    (view: DataView) => { view.setBigInt64(8, -9223372036854775808n, true); },
    (view: DataView) => view.setBigInt64(40, 9n, true),
  ]) {
    const bytes = records(), view = new DataView(bytes.buffer);
    mutate(view);
    assert.equal(parseFfmpegIndex(serializeFfmpegIndex(metadata, bytes), metadata.size), null);
  }
});
