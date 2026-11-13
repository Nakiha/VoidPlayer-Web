import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IndexStreamTransport } from '../../src/media/indexing/index-stream-transport.ts';
import { MediaIndexClient } from '../../src/media/indexing/media-index-client.ts';
import { MP4_PLAYBACK_MEDIA_INDEX_IDENTITY } from '../../shared/media/indexing/media-index-identity.ts';
import { loadLibraryMp4Playback } from '../../src/media/indexing/mp4-playback-client.ts';

const encoder = new TextEncoder();

function streamResponse(events: unknown[]): Response {
  const lines = events.map(event => encoder.encode(JSON.stringify(event) + '\n'));
  let index = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < lines.length) controller.enqueue(lines[index++]!);
      else controller.close();
    },
  }), { headers: { 'content-type': 'application/x-ndjson' } });
}

test('generic index transport resumes a consumer-owned cursor without interpreting event payloads', async () => {
  const originalFetch = globalThis.fetch;
  const requests: URL[] = [];
  const buildId = '44444444-4444-4444-8444-444444444444';
  globalThis.fetch = (async input => {
    const url = new URL(String(input));
    requests.push(url);
    if (requests.length === 1) return streamResponse([{ type: 'opaque', seq: 0, buildId, payload: { keep: 'container-owned' } }]);
    return streamResponse([{ type: 'opaque', seq: 1, buildId, payload: { keep: 'container-owned' } }, { type: 'done' }]);
  }) as typeof fetch;
  const abort = new AbortController();
  const transport = new IndexStreamTransport({ idleTimeoutMs: 1000, maxBytes: 4096, signal: abort.signal });
  const cursor = { after: -1, buildId: undefined as string | undefined };
  const received: number[] = [];
  try {
    const result = await transport.read('http://localhost/api/media/index', {
      cursor: () => ({ ...cursor }),
      onEvent(event: any) {
        if (event.type === 'done') return 'complete';
        received.push(event.seq);
        cursor.after = event.seq;
        cursor.buildId = event.buildId;
        return 'continue';
      },
    });
    assert.deepEqual(result, { status: 'complete' });
    assert.deepEqual(received, [0, 1]);
    assert.deepEqual(requests.map(url => [url.searchParams.get('after'), url.searchParams.get('buildId')]), [
      ['-1', null], ['0', buildId],
    ]);
    assert.deepEqual(transport.diagnostics(), { serverIndexRequests: 2, reconnects: 1 });
  } finally {
    abort.abort();
    globalThis.fetch = originalFetch;
  }
});

test('HTTP index failures preserve server reasons and status through the MP4 opener', async () => {
  const originalFetch = globalThis.fetch;
  const message = 'MP4 播放索引版本不受支持。';
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: message, code: 'index-version-unsupported' }), {
    status: 400, headers: { 'content-type': 'application/json' },
  })) as typeof fetch;
  try {
    const url = `http://localhost/api/media/${'a'.repeat(24)}/content?v=${'b'.repeat(24)}`;
    const client = new MediaIndexClient(url, 'mp4-playback', 4096, 1000, true, MP4_PLAYBACK_MEDIA_INDEX_IDENTITY);
    try {
      assert.equal(await client.read(), null);
      assert.deepEqual(client.failureReason, { status: 400, message, code: 'index-version-unsupported' });
    } finally { client.close(); }
    await assert.rejects(loadLibraryMp4Playback({ url, size: 100, library: { id: 'a'.repeat(24), version: 'b'.repeat(24), origin: 'http://localhost' } }, new AbortController().signal),
      error => error instanceof Error && error.message === `${message}（HTTP 400）`);
    for (const body of ['<html>Not Found</html>', 'x'.repeat(9000)]) {
      globalThis.fetch = (async () => new Response(body, { status: 404 })) as typeof fetch;
      const transport = new IndexStreamTransport({ idleTimeoutMs: 1000, maxBytes: 4096, signal: new AbortController().signal });
      const result = await transport.read(url, { cursor: () => ({ after: -1 }), onEvent: () => 'continue' });
      assert.equal(result.status, 'failed');
      assert.ok('failure' in result && result.failure?.status === 404 && result.failure.message.includes('HTTP 404'));
    }
  } finally { globalThis.fetch = originalFetch; }
});
