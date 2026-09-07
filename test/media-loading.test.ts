import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMediaFromUrl } from '../src/media.ts';

test('HTTP fallback passes URL and metadata without downloading or imposing a whole-file memory cap', async () => {
  const meta = { name: 'test.mp4', size: 10 * 1024 ** 3, lastModified: 1 };
  const progress: string[] = [];
  const failure = new Error('WASM init 超时');
  let attempted = 0;
  await assert.rejects(openMediaFromUrl('http://127.0.0.1:1/video', meta, async (url, details) => {
    attempted++;
    assert.equal(url, 'http://127.0.0.1:1/video'); assert.deepEqual(details, meta);
    throw failure;
  }, stage => progress.push(stage)), error => error === failure);
  assert.equal(attempted, 1);
  assert.deepEqual(progress, ['decode', 'decode']);
});
