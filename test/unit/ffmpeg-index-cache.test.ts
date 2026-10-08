import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFfmpegIndex, serializeFfmpegIndex } from '../../src/ffmpeg-index-cache.ts';

const metadata = {
  size: 1024, codec: 'mpeg2video', timeBaseNum: 1, timeBaseDen: 90000,
  width: 1280, height: 720, streamIndex: 0, indexerBuild: 'a'.repeat(40),
};

function records() {
  const bytes = new Uint8Array(96);
  const view = new DataView(bytes.buffer);
  view.setBigInt64(0, 10n, true); view.setBigInt64(8, 9n, true);
  view.setBigInt64(16, 3000n, true); view.setBigInt64(24, 0n, true);
  view.setInt32(32, 100, true); view.setUint32(36, 3, true);
  view.setBigInt64(48, 20n, true); view.setBigInt64(56, 19n, true);
  view.setBigInt64(64, 3000n, true); view.setBigInt64(72, -1n, true);
  view.setInt32(80, 50, true); view.setUint32(84, 0, true);
  view.setBigUint64(40, 0n, true); view.setBigUint64(88, 1n, true);
  return bytes;
}

test('FFmpeg index documents round-trip v3 seek metadata and enforce stream/build identity', () => {
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

test('FFmpeg v3 records reject invalid flags, packet positions, sizes, anchors, and PTS ordering', () => {
  for (const mutate of [
    (view: DataView) => view.setUint32(36, 4, true),
    (view: DataView) => view.setInt32(32, -1, true),
    (view: DataView) => view.setBigInt64(24, -2n, true),
    (view: DataView) => view.setUint32(36, 2, true),
    (view: DataView) => { view.setBigInt64(8, -9223372036854775808n, true); },
    (view: DataView) => view.setBigInt64(48, 9n, true),
  ]) {
    const bytes = records(), view = new DataView(bytes.buffer);
    mutate(view);
    assert.equal(parseFfmpegIndex(serializeFfmpegIndex(metadata, bytes), metadata.size), null);
  }
});

test('FFmpeg v3 keeps untimed packet sizes and rejects duplicate original ordinals and old ABI', () => {
  const bytes = records(), view = new DataView(bytes.buffer);
  view.setBigInt64(48, -9223372036854775808n, true);
  view.setBigInt64(56, -9223372036854775808n, true);
  const document = serializeFfmpegIndex(metadata, bytes);
  assert.ok(parseFfmpegIndex(document, metadata.size));
  assert.equal(parseFfmpegIndex({ ...document, schema: 2, recordBytes: 40 }, metadata.size), null);
  view.setBigUint64(88, 0n, true);
  assert.equal(parseFfmpegIndex(serializeFfmpegIndex(metadata, bytes), metadata.size), null);
});

test('damaged FFmpeg prefixes round-trip their terminal decode boundary and reject forged coverage', () => {
  const recovery = { indexIntegrity: 'prefix' as const, indexTruncatedAt: 900, indexEndDts: '19' };
  const document = serializeFfmpegIndex({ ...metadata, ...recovery }, records());
  assert.ok(parseFfmpegIndex(document, metadata.size));
  for (const patch of [
    { indexIntegrity: 'recovered' }, { indexIntegrity: 'complete' }, { indexTruncatedAt: -1 },
    { indexTruncatedAt: metadata.size }, { indexEndDts: undefined }, { indexEndDts: '18' },
    { indexEndDts: '-9223372036854775808' }, { indexEndDts: '9223372036854775808' },
  ]) assert.equal(parseFfmpegIndex({ ...document, ...patch }, metadata.size), null);
  const broken = records(); new DataView(broken.buffer).setBigInt64(56, -9223372036854775808n, true);
  assert.equal(parseFfmpegIndex(serializeFfmpegIndex({ ...metadata, ...recovery }, broken), metadata.size), null);
});
