import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MediaIndexClient } from '../src/media-index-client.ts';

const ID = 'a'.repeat(24);
const encoder = new TextEncoder();

function ndjsonResponse(lines: string[], disconnect = false): Response {
  const bytes = encoder.encode(lines.join('\n') + '\n');
  let offset = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset < bytes.length) {
        const end = Math.min(bytes.length, offset + 37);
        controller.enqueue(bytes.subarray(offset, end));
        offset = end;
      } else if (disconnect) controller.error(new Error('simulated connection reset'));
      else controller.close();
    },
  }), { headers: { 'content-type': 'application/x-ndjson; charset=utf-8' } });
}

test('NDJSON index transfer resumes after the last received sequence', async () => {
  const originalFetch = globalThis.fetch;
  const expected = { codec: 'mpeg2video', token: 'x'.repeat(70_000) };
  const document = { epoch: 7, index: expected };
  const bytes = encoder.encode(JSON.stringify(document));
  const batchBytes = 64 * 1024;
  const lastSeq = Math.ceil(bytes.length / batchBytes) - 1;
  const events = (after: number) => {
    const lines = [{
      type: 'manifest', protocol: 1, epoch: 7, kind: 'ffmpeg', state: 'complete', encoding: 'json-utf8-base64',
      totalBytes: bytes.length, batchBytes, lastSeq,
    }, ...Array.from({ length: lastSeq - after }, (_, i) => after + i + 1).flatMap(seq => {
      const chunk = bytes.subarray(seq * batchBytes, Math.min(bytes.length, (seq + 1) * batchBytes));
      return [
        { type: 'batch', seq, data: Buffer.from(chunk).toString('base64') },
        { type: 'progress', phase: 'transfer', seq, bytesSent: Math.min(bytes.length, (seq + 1) * batchBytes) },
      ];
    }), { type: 'complete', lastSeq, totalBytes: bytes.length }];
    return lines.map(line => JSON.stringify(line));
  };
  const cursors: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const requestUrl = new URL(String(input));
    const after = requestUrl.searchParams.get('after') ?? '';
    cursors.push(after);
    if (cursors.length === 1) return ndjsonResponse(events(-1).slice(0, 2), true);
    return ndjsonResponse(events(Number(after)));
  }) as typeof fetch;

  const client = new MediaIndexClient('http://localhost/api/media/' + ID + '?v=1', 'ffmpeg', 200_000, 5000, false, { kind: 'ffmpeg', streamKey: 'video:0', schemaVersion: 2, indexerBuild: 'a'.repeat(40) });
  try {
    assert.deepEqual(await client.read(), expected);
    assert.deepEqual(cursors, ['-1', '0']);
  } finally {
    client.close();
    globalThis.fetch = originalFetch;
  }
});
