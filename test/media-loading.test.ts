import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { openMediaFromUrl, MediaOpenError } from '../src/media.ts';
import { MAX_FALLBACK_FILE_BYTES } from '../src/model.ts';

test('HTTP fallback reports download/decode stages and preserves the actual failure', async () => {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url!);
    res.writeHead(req.url === '/missing' ? 503 : 200);
    res.end('test-video');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const meta = { name: 'test.mp4', size: 10, lastModified: 1 };
  try {
    let attempted = 0;
    const progress: string[] = [];
    const failure = new Error('WASM init 超时');
    await assert.rejects(openMediaFromUrl(`${base}/video`, meta, async file => {
      attempted++;
      assert.equal(file.name, meta.name); assert.equal(await file.text(), 'test-video');
      throw failure;
    }, stage => progress.push(stage)), error => error === failure);
    assert.equal(attempted, 1);
    assert.deepEqual(progress, ['decode', 'download', 'decode']);
    const unreachable = async () => { throw new Error('decoder must not open'); };
    await assert.rejects(openMediaFromUrl(`${base}/missing`, meta, unreachable),
      error => error instanceof MediaOpenError && error.stage === 'input' && error.message.includes('503'));
    await assert.rejects(openMediaFromUrl(`${base}/oversized`, { ...meta, size: MAX_FALLBACK_FILE_BYTES + 1 }, unreachable),
      error => error instanceof MediaOpenError && error.stage === 'resource');
    assert.deepEqual(requests, ['/video', '/missing'], 'oversized media must be rejected before downloading');
  } finally { await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); }
});
