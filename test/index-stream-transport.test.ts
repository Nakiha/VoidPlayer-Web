import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IndexStreamTransport } from '../src/index-stream-transport.ts';

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
