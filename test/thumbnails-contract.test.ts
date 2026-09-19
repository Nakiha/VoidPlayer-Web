import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  THUMB_RECIPE_VERSION, THUMB_STREAM_SELECTOR, THUMB_MAX_EDGE, THUMB_MAX_BYTES,
  serverCacheKey, localCacheKey, thumbnailImageUrl, thumbnailStatusUrl,
  parseJpegDimensions, validateThumbnailImage, isProbablyJpeg,
} from '../src/thumbnails/contract.ts';

/** Minimal valid JPEG: SOI + APP0 + SOF0(320x240) + EOI. */
function jpeg320x240(): Uint8Array {
  return Uint8Array.from([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0xf0, 0x01, 0x40, 0x01, 0x01, 0x11, 0x00,
    0xff, 0xd9,
  ]);
}

test('thumbnail keys separate server identity from local history', () => {
  const server = serverCacheKey({ mediaId: 'a'.repeat(24), mediaVersion: 'b'.repeat(24) });
  assert.match(server, new RegExp(`^v1\\|lib\\|${'a'.repeat(24)}\\|${'b'.repeat(24)}\\|${THUMB_STREAM_SELECTOR}\\|`));
  assert.ok(server.includes(THUMB_RECIPE_VERSION));
  const other = serverCacheKey({ mediaId: 'a'.repeat(24), mediaVersion: 'c'.repeat(24) });
  assert.notEqual(server, other);
  const local = localCacheKey('clip.mp4', 100, 200);
  assert.ok(local.startsWith('v1|local|'));
  assert.notEqual(local, localCacheKey('clip.mp4', 100, 201));
  assert.equal(THUMB_MAX_EDGE, 384);
});

test('thumbnail URLs carry version and recipe', () => {
  const id = 'a'.repeat(24), version = 'b'.repeat(24);
  assert.ok(thumbnailImageUrl(id, version).includes(`v=${version}`));
  assert.ok(thumbnailImageUrl(id, version).includes('recipe='));
  assert.ok(thumbnailStatusUrl(id, version).includes('thumbnail-status'));
});

test('jpeg probe reads SOF dimensions and rejects hostile structures', () => {
  assert.deepEqual(parseJpegDimensions(jpeg320x240()), { width: 320, height: 240 });
  assert.ok(isProbablyJpeg(jpeg320x240()));
  assert.equal(parseJpegDimensions(Uint8Array.from([1, 2, 3, 4])), null);
  assert.equal(parseJpegDimensions(jpeg320x240().slice(0, 10)), null);
  // EOI before SOF.
  assert.equal(parseJpegDimensions(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9])), null);
  // Truncated length.
  const bad = jpeg320x240().slice();
  bad[23] = 0xff;
  assert.equal(parseJpegDimensions(bad), null);
});

test('thumbnail validation enforces format, dimensions and byte cap', () => {
  const bytes = jpeg320x240();
  assert.deepEqual(validateThumbnailImage(bytes, 320, 240), { width: 320, height: 240 });
  assert.ok('error' in validateThumbnailImage(bytes, 321, 240));
  assert.ok('error' in validateThumbnailImage(bytes.slice(0, 20), 320, 240));
  assert.ok('error' in validateThumbnailImage(new Uint8Array(THUMB_MAX_BYTES + 1), 320, 240));
});
