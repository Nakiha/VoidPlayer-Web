import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MediaIndexClient } from '../src/media-index-client.ts';
import { FFMPEG_INDEX_RECORD_BYTES } from '../src/ffmpeg-index-cache.ts';

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
  const events = (after: number, includeScan = false) => {
    const lines = [
      ...(includeScan ? [
        { type: 'manifest', protocol: 1, epoch: 7, kind: 'ffmpeg', state: 'building', batchBytes },
        { type: 'progress', phase: 'scan', packets: 1024, scannedBytes: 8192, totalBytes: 200_000 },
      ] : []),
      {
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
  const scanProgress: { packets: number; scannedBytes: number; totalBytes: number }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const requestUrl = new URL(String(input));
    const after = requestUrl.searchParams.get('after') ?? '';
    cursors.push(after);
    if (cursors.length === 1) return ndjsonResponse(events(-1, true).slice(0, 5), true);
    return ndjsonResponse(events(Number(after)));
  }) as typeof fetch;

  const client = new MediaIndexClient('http://localhost/api/media/' + ID + '?v=1', 'ffmpeg', 200_000, 5000, false, { kind: 'ffmpeg', streamKey: 'video:0', schemaVersion: 2, indexerBuild: 'a'.repeat(40) }, progress => scanProgress.push(progress));
  try {
    assert.deepEqual(await client.read(), expected);
    assert.deepEqual(cursors, ['-1', '0']);
    assert.deepEqual(scanProgress, [{ packets: 1024, scannedBytes: 8192, totalBytes: 200_000 }]);
    assert.deepEqual({ serverIndexRequests: client.diagnostics().serverIndexRequests, reconnects: client.diagnostics().reconnects },
      { serverIndexRequests: 2, reconnects: 1 });
    assert.ok(client.diagnostics().firstIndexBatchMs !== undefined);
    assert.ok(client.diagnostics().indexCompleteMs !== undefined);
  } finally {
    client.close();
    globalThis.fetch = originalFetch;
  }
});

test('FFmpeg record batches are incrementally validated and delivered before stream completion', async () => {
  const originalFetch = globalThis.fetch;
  const identity = { kind: 'ffmpeg' as const, streamKey: 'video:0', schemaVersion: 2, indexerBuild: 'a'.repeat(40) };
  const metadata = { schema: 2, kind: 'ffmpeg-container', size: 4096, codec: 'mpeg2video', timeBaseNum: 1, timeBaseDen: 90_000,
    width: 1920, height: 1080, recordBytes: FFMPEG_INDEX_RECORD_BYTES, streamIndex: 0, indexerBuild: identity.indexerBuild,
    firstPts: '90000', originVerified: true };
  const records = new Uint8Array(FFMPEG_INDEX_RECORD_BYTES * 2);
  const view = new DataView(records.buffer);
  for (let i = 0; i < 2; i++) {
    const offset = i * FFMPEG_INDEX_RECORD_BYTES;
    view.setBigInt64(offset, BigInt(90_000 + i * 3_000), true);
    view.setBigInt64(offset + 8, BigInt(87_000 + i * 3_000), true);
    view.setBigInt64(offset + 16, 3_000n, true);
    view.setBigInt64(offset + 24, BigInt(i * 188), true);
    view.setInt32(offset + 32, 188, true);
    view.setUint32(offset + 36, i === 0 ? 3 : 1, true);
  }
  const buildId = '11111111-1111-4111-8111-111111111111';
  const lines = [
    { type: 'manifest', protocol: 2, epoch: 2, kind: 'ffmpeg', encoding: 'ffmpeg-records-base64', state: 'streaming', buildId,
      identity, metadata, recordBytes: FFMPEG_INDEX_RECORD_BYTES, lastSeq: -1 },
    { type: 'progress', phase: 'scan', packets: 0, scannedBytes: 1200, totalBytes: 4096 },
    { type: 'batch', buildId, seq: 0, count: 2, safePresentationUs: 33_333, data: Buffer.from(records).toString('base64') },
    { type: 'manifest', protocol: 2, epoch: 2, kind: 'ffmpeg', encoding: 'ffmpeg-records-base64', state: 'complete', buildId,
      identity, metadata: { ...metadata, count: 2 }, recordBytes: FFMPEG_INDEX_RECORD_BYTES, lastSeq: 0 },
    { type: 'complete', buildId, lastSeq: 0, frames: 2, stablePresentationUs: 33_333 },
  ].map(event => JSON.stringify(event));
  globalThis.fetch = (async () => ndjsonResponse(lines)) as typeof fetch;
  const manifests: any[] = [], batches: any[] = [], completed: any[] = [];
  const client = new MediaIndexClient('http://localhost/api/media/' + ID + '?v=1', 'ffmpeg', 200_000, 5000, true,
    identity, undefined, manifest => manifests.push(manifest), batch => batches.push(batch), (manifest, frames) => completed.push({ manifest, frames }));
  try {
    const result = await client.read() as any;
    assert.equal(result.streamed, true);
    assert.equal(result.count, 2);
    assert.equal(manifests[0].buildId, buildId);
    assert.equal(batches.length, 1);
    assert.deepEqual(Array.from(batches[0].records), Array.from(records));
    assert.equal(batches[0].safePresentationUs, 33_333);
    assert.equal(completed[0].frames, 2);
    assert.deepEqual(client.diagnostics().indexIdentity, identity);
    assert.equal(client.diagnostics().indexBuildId, buildId);
    assert.equal(client.diagnostics().serverIndexRequests, 1);
    assert.ok(client.diagnostics().firstIndexBatchMs !== undefined);
    assert.ok(client.diagnostics().indexCompleteMs! >= client.diagnostics().firstIndexBatchMs!);
  } finally {
    client.close();
    globalThis.fetch = originalFetch;
  }
});

test('FFmpeg record streams resume the same build after the last accepted batch', async () => {
  const originalFetch = globalThis.fetch;
  const identity = { kind: 'ffmpeg' as const, streamKey: 'video:0', schemaVersion: 2, indexerBuild: 'a'.repeat(40) };
  const metadata = { schema: 2, kind: 'ffmpeg-container', size: 4096, codec: 'mpeg2video', timeBaseNum: 1, timeBaseDen: 90_000,
    width: 1920, height: 1080, recordBytes: FFMPEG_INDEX_RECORD_BYTES, streamIndex: 0, indexerBuild: identity.indexerBuild,
    firstPts: '90000', originVerified: true };
  const buildId = '22222222-2222-4222-8222-222222222222';
  const batch = (pts: number) => {
    const bytes = new Uint8Array(FFMPEG_INDEX_RECORD_BYTES);
    const view = new DataView(bytes.buffer);
    view.setBigInt64(0, BigInt(pts), true);
    view.setBigInt64(8, BigInt(pts - 3_000), true);
    view.setBigInt64(16, 3_000n, true);
    view.setBigInt64(24, BigInt(pts), true);
    view.setInt32(32, 188, true);
    view.setUint32(36, 3, true);
    return Buffer.from(bytes).toString('base64');
  };
  const requestUrls: URL[] = [];
  globalThis.fetch = (async input => {
    const url = new URL(String(input));
    requestUrls.push(url);
    const after = Number(url.searchParams.get('after'));
    if (requestUrls.length === 1) return ndjsonResponse([
      JSON.stringify({ type: 'manifest', protocol: 2, epoch: 4, kind: 'ffmpeg', encoding: 'ffmpeg-records-base64',
        state: 'streaming', buildId, identity, metadata, recordBytes: FFMPEG_INDEX_RECORD_BYTES, lastSeq: 0 }),
      JSON.stringify({ type: 'batch', buildId, seq: 0, count: 1, safePresentationUs: 0, data: batch(90_000) }),
    ], true);
    assert.equal(after, 0);
    assert.equal(url.searchParams.get('buildId'), buildId);
    return ndjsonResponse([
      JSON.stringify({ type: 'manifest', protocol: 2, epoch: 4, kind: 'ffmpeg', encoding: 'ffmpeg-records-base64',
        state: 'complete', buildId, identity, metadata: { ...metadata, count: 2 }, recordBytes: FFMPEG_INDEX_RECORD_BYTES, lastSeq: 1 }),
      JSON.stringify({ type: 'batch', buildId, seq: 1, count: 1, safePresentationUs: 33_333, data: batch(93_000) }),
      JSON.stringify({ type: 'complete', buildId, lastSeq: 1, frames: 2, stablePresentationUs: 33_333 }),
    ]);
  }) as typeof fetch;
  const batches: number[] = [];
  const client = new MediaIndexClient('http://localhost/api/media/' + ID + '?v=1', 'ffmpeg', 200_000, 5000, true,
    identity, undefined, undefined, record => batches.push(record.seq));
  try {
    const result = await client.read() as any;
    assert.equal(result.streamed, true);
    assert.equal(result.count, 2);
    assert.deepEqual(batches, [0, 1]);
    assert.deepEqual(requestUrls.map(url => url.searchParams.get('after')), ['-1', '0']);
    assert.equal(client.diagnostics().serverIndexRequests, 2);
    assert.equal(client.diagnostics().reconnects, 1);
    assert.equal(client.diagnostics().indexBuildId, buildId);
  } finally {
    client.close();
    globalThis.fetch = originalFetch;
  }
});
