import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FLV_MEDIA_INDEX_IDENTITY, mediaIndexIdentityKey, parseMediaIndexIdentity,
} from '../../src/media-index-identity.ts';

test('media index identity validates format, stream, schema, and indexer build', () => {
  const flv = new URLSearchParams('stream=video%3A0&schema=2&indexer=flv-demux-v2');
  assert.deepEqual(parseMediaIndexIdentity('flv', flv), FLV_MEDIA_INDEX_IDENTITY);

  const ffmpeg = new URLSearchParams('stream=video%3A2&schema=3&indexer=' + 'a'.repeat(40));
  const identity = parseMediaIndexIdentity('ffmpeg', ffmpeg);
  assert.equal(identity.streamKey, 'video:2');
  assert.equal(identity.indexerBuild, 'a'.repeat(40));
  assert.notEqual(mediaIndexIdentityKey(identity), mediaIndexIdentityKey({
    ...identity, streamKey: 'video:1',
  }));

  assert.throws(() => parseMediaIndexIdentity('ffmpeg', new URLSearchParams(
    'stream=video%3A2&schema=1&indexer=' + 'a'.repeat(40),
  )), /不受支持/);
  assert.throws(() => parseMediaIndexIdentity('flv', new URLSearchParams(
    'stream=video%3A0&schema=2&indexer=changed',
  )), /不受支持/);
});
