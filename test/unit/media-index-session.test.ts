import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { FfmpegMediaIndexSession } from '../../src/media/indexing/media-index-session.ts';

const identity = { kind: 'ffmpeg' as const, streamKey: 'video:0', schemaVersion: 3, indexerBuild: 'a'.repeat(40) };
const sink = (overrides: Record<string, (...args: any[]) => void> = {}) => ({
  manifest() {}, batch() {}, complete() {}, legacy() {}, progress() {}, error() {}, ...overrides,
});

test('an unavailable server index fails pending seeks without discarding ready frames', async () => {
  const errors: string[] = [];
  const session = new FfmpegMediaIndexSession({
    identity, firstPtsUs: 900_000, durationUs: 40_000,
    sink: sink({ error: (message: string) => { errors.push(message); } }),
  });
  await assert.rejects(session.ensure(80_000), /服务端 FFmpeg 播放索引/);
  assert.equal(session.state, 'error');
  await session.ensure(20_000);
  assert.equal(errors.length, 1);
  session.dispose();
});

test('disposing an FFmpeg index session aborts its HTTP subscriber', async () => {
  const originalFetch = globalThis.fetch;
  let requestSignal: AbortSignal | undefined;
  globalThis.fetch = (async (_input, init) => {
    requestSignal = init?.signal as AbortSignal;
    return await new Promise<Response>((_resolve, reject) => {
      requestSignal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    });
  }) as typeof fetch;
  const session = new FfmpegMediaIndexSession({
    url: 'http://localhost/api/media/' + 'a'.repeat(24) + '?v=1', identity, firstPtsUs: 0, durationUs: 40_000, sink: sink(),
  });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(requestSignal, 'the main-thread transport should start its request');
    session.dispose();
    assert.equal(requestSignal.aborted, true);
  } finally {
    session.dispose();
    globalThis.fetch = originalFetch;
  }
});

test('the FFmpeg decoder worker has no index transport or client dependency', async () => {
  const worker = await readFile(new URL('../../src/media/decoding/ffmpeg-worker.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(worker, /MediaIndexClient|IndexStreamTransport|frame-index/);
});
