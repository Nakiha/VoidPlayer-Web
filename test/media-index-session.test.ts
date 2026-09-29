import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { FfmpegMediaIndexSession } from '../src/media-index-session.ts';

const identity = { kind: 'ffmpeg' as const, streamKey: 'video:0', schemaVersion: 2, indexerBuild: 'a'.repeat(40) };
const sink = (overrides: Record<string, (...args: any[]) => void> = {}) => ({
  manifest() {}, batch() {}, complete() {}, legacy() {}, fallback() {}, progress() {}, error() {}, ...overrides,
});

test('an FFmpeg index session owns local fallback and coverage finality', async () => {
  let fallbackCalls = 0;
  const session = new FfmpegMediaIndexSession({
    identity, firstPtsUs: 900_000, durationUs: 40_000,
    sink: sink({ fallback: () => { fallbackCalls++; } }),
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fallbackCalls, 1);
  assert.equal(session.state, 'building');
  await session.ensure(20_000);
  session.updateCoverage(80_000);
  await session.ensure(70_000);
  session.markComplete(120_000);
  assert.equal(session.state, 'complete');
  assert.equal(session.durationUs, 120_000);
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
  const worker = await readFile(new URL('../src/ffmpeg-worker.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(worker, /MediaIndexClient|IndexStreamTransport|frame-index/);
});
