import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  FLV_MEDIA_INDEX_IDENTITY, JS_TS_MEDIA_INDEX_IDENTITY, JS_MATROSKA_MEDIA_INDEX_IDENTITY,
  MP4_PLAYBACK_MEDIA_INDEX_IDENTITY, mediaIndexIdentityKey, parseMediaIndexIdentity,
} from '../../shared/media/indexing/media-index-identity.ts';
import { MEDIABUNNY_VERSION } from '../../shared/media/mediabunny-version.ts';

test('parser provenance matches the installed dependency and rejects indexes from the prior parser', () => {
  const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.equal(MEDIABUNNY_VERSION, manifest.dependencies.mediabunny);
  for (const identity of [JS_TS_MEDIA_INDEX_IDENTITY, JS_MATROSKA_MEDIA_INDEX_IDENTITY, MP4_PLAYBACK_MEDIA_INDEX_IDENTITY]) {
    const params = new URLSearchParams({ stream: identity.streamKey, schema: String(identity.schemaVersion), indexer: identity.indexerBuild });
    assert.deepEqual(parseMediaIndexIdentity(identity.kind, params), identity);
    const previous = { ...identity, indexerBuild: identity.indexerBuild.replace(MEDIABUNNY_VERSION, '1.55.7') };
    assert.notEqual(mediaIndexIdentityKey(previous), mediaIndexIdentityKey(identity));
    params.set('indexer', previous.indexerBuild);
    assert.throws(() => parseMediaIndexIdentity(identity.kind, params), /不受支持/);
  }
});

test('media index identity validates format, stream, schema, and indexer build', () => {
  const oldMp4 = new URLSearchParams({ stream: 'video:0', schema: '1', indexer: `mediabunny-${MEDIABUNNY_VERSION}-mp4-playback-v1` });
  assert.throws(() => parseMediaIndexIdentity('mp4-playback', oldMp4), /不受支持/, 'indexes without demux metadata must rebuild');
  const flv = new URLSearchParams('stream=video%3A0&schema=3&indexer=flv-demux-v3');
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
