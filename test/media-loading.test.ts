import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMediaFromUrl } from '../src/media.ts';

test('HTTP fallback probes bounded bytes then passes URL and metadata without a whole-file memory cap', async () => {
  const meta = { name: 'test.mp4', size: 10 * 1024 ** 3, lastModified: 1 };
  const progress: string[] = [];
  const failure = new Error('WASM init 超时');
  let attempted = 0;
  const saved = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    assert.equal(new Headers(init?.headers).get('range'), 'bytes=0-4095');
    return new Response(new Uint8Array(4096), { status: 206, headers: { 'content-range': `bytes 0-4095/${meta.size}` } });
  };
  try {
  await assert.rejects(openMediaFromUrl('http://127.0.0.1:1/video', meta, async (url, details) => {
    attempted++;
    assert.equal(url, 'http://127.0.0.1:1/video'); assert.deepEqual(details, meta);
    throw failure;
  }, stage => progress.push(stage)), error => error === failure);
  assert.equal(attempted, 1);
  assert.deepEqual(progress, ['decode', 'decode']);
  } finally { globalThis.fetch = saved; }
});
