import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import { scanFlv } from '../../shared/media/containers/flv-demux.ts';
import { wrapFlv } from '../helpers/frame-pair-fixture.ts';
import { openPacketMedia } from '../../src/media/decoding/packet-media.ts';
import type { MediaSource, DecodedFrame } from '../../src/media/source.ts';
import type { PacketInput } from '../../shared/media/containers/flv-demux.ts';
import { ReviewSession } from '../../src/session.ts';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(label)), 5000); })]); }
  finally { clearTimeout(timer!); }
}

// Same 120-packet, nonzero-origin fixture as discovery's player isolation case.
// The committed raw oracle contains the two alternating decoded source pictures.
const samples = JSON.parse(await readFile(new URL('../helpers/quality-http-samples.json', import.meta.url), 'utf8'));
const sample = samples.samples.find((s: { codec: string; depth: number; tagged: boolean }) => s.codec === 'h264' && s.depth === 8 && s.tagged);
const original = Buffer.from(sample.flv, 'base64');
const index = (await scanFlv({ size: original.length, read: async (at, n) => original.subarray(at, at + n) })).index;
const pictures = index.packets.map(p => original.subarray(p.offset, p.offset + p.size));
const bytes = wrapFlv('h264', index.description, Array.from({ length: 120 }, (_, i) => pictures[i % pictures.length]));
const raw = Buffer.from(sample.native, 'base64'), frameBytes = 32 * 32 * 3 / 2;
assert.equal(createHash('sha256').update(original).digest('hex'), sample.flvSha256);
assert.equal(createHash('sha256').update(raw).digest('hex'), sample.nativeSha256);
assert.equal(raw.length, 2 * frameBytes);

function checkPicture(frame: DecodedFrame, ordinal: number) {
  try {
    assert.equal(frame.ptsUs, ordinal * 1000000);
    assert.equal(frame.sourcePtsUs, 2000000 + ordinal * 1000000);
    assert.deepEqual(Buffer.from(frame.pixels!), raw.subarray((ordinal % 2) * frameBytes, (ordinal % 2 + 1) * frameBytes));
  } finally { frame.close(); }
}

// Hold only the facade's zero-delay background start after frameAt(0), never
// Worker scheduling, deadlines, decode or index work. Restore even on failure.
function holdBackgroundStart() {
  const set = globalThis.setTimeout, clear = globalThis.clearTimeout;
  const held = new Map<ReturnType<typeof setTimeout>, () => void>();
  let id = -100;
  globalThis.setTimeout = ((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    if (ms !== 0) return set(callback, ms, ...args);
    const key = id-- as unknown as ReturnType<typeof setTimeout>;
    held.set(key, () => callback(...args)); return key;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((key: ReturnType<typeof setTimeout>) => { if (!held.delete(key)) clear(key); }) as typeof clearTimeout;
  return { get count() { return held.size; }, restore() { globalThis.setTimeout = set; globalThis.clearTimeout = clear; held.clear(); } };
}

async function harness(variant: 'st' | 'mt', input: PacketInput = { file: new Blob([bytes]) }) {
  const nextRequested = deferred(), completionRequested = deferred(), completionReply = deferred(), nextReply = deferred();
  const trace: string[] = [], held: { id: number; ok: boolean }[] = [];
  let worker!: Worker, holdCompletion = true, holdNext = false, completionId: number | undefined;
  const nextIds = new Set<number>();
  const suffix = variant === 'mt' ? '-mt' : '';
  const source = await openPacketMedia('flv', input, { name: 'player-A.flv', size: bytes.length, lastModified: 1 }, {
    forceWasm: true, nativeColorMode: 'browser',
    glueURL: new URL(`../../public/vendor/voidplayer-core/voidplayer-core${suffix}.js`, import.meta.url).href,
    wasmBinary: await readFile(new URL(`../../public/vendor/voidplayer-core/voidplayer-core${suffix}.wasm`, import.meta.url)),
    workerFactory: () => {
      worker = new Worker(new URL('../../src/media/decoding/packet-worker.ts', import.meta.url));
      const post = worker.postMessage.bind(worker), emit = worker.emit.bind(worker);
      worker.postMessage = (message, ...args) => {
        trace.push(message.type);
        if (message.type === 'complete-index') { completionId = message.id; completionRequested.resolve(); }
        if (message.type === 'next') { nextIds.add(message.id); nextRequested.resolve(); }
        return post(message, ...args);
      };
      worker.emit = (event: string | symbol, ...args: unknown[]) => {
        const message = args[0] as { id: number; ok: boolean } | undefined;
        if (event === 'message' && message && 'ok' in message) {
          if (message.id === completionId && holdCompletion) { held.push(message); completionReply.resolve(); return true; }
          if (nextIds.has(message.id) && holdNext) { held.push(message); nextReply.resolve(); return true; }
        }
        return emit(event, ...args);
      };
      // The actual Node Worker is adapted by WorkerRpc, as in production Node tests.
      return worker as unknown as globalThis.Worker;
    },
  });
  return { source, trace, worker, nextRequested, completionRequested, completionReply, nextReply,
    holdNext() { holdNext = true; },
    releaseReplies() {
      holdCompletion = false; holdNext = false;
      for (const message of held.splice(0)) worker.emit('message', message);
    },
    async close() {
      const exited = once(worker, 'exit'); source.dispose();
      await bounded(exited, 'physical packet Worker did not exit'); held.length = 0;
    },
  };
}

for (const variant of ['st', 'mt'] as const) {
  test(`FLV ${variant}: next before background timer starts growth without awaiting the full-index reply`, { timeout: 30000 }, async () => {
    const h = await harness(variant), timer = holdBackgroundStart();
    const iterator = h.source.framesFollowing!(0);
    try {
      checkPicture(await h.source.frameAt(0), 0);
      assert.equal(h.source.info.indexState, 'building'); assert.equal(timer.count, 1);
      const next = iterator.next();
      // A full-index await before next would deadlock this gate. The real Worker
      // still receives and executes complete-index; only its final reply is held.
      await bounded(h.nextRequested.promise, 'next synchronously waited for full index completion');
      const frame = await bounded(next, 'strict successor did not resume at the live frontier');
      assert.equal(frame.done, false, 'finite startup prefix must not permanently finish this iterator');
      checkPicture(frame.value!, 1);
      await bounded(h.completionReply.promise, 'index did not finish behind the held acknowledgement');
      assert.equal(h.source.info.indexState, 'building');
      assert.ok(h.trace.indexOf('complete-index') < h.trace.indexOf('next'));
      h.releaseReplies(); await h.source.ensureIndexed!();
      assert.equal(h.source.info.indexState, 'complete');
      const following = await iterator.next(); assert.equal(following.done, false); checkPicture(following.value!, 2);
      assert.equal(h.trace.filter(type => type === 'complete-index').length, 1, 'completion is memoized');
    } finally { timer.restore(); await h.close(); await iterator.return(undefined); }
  });

  test(`FLV ${variant}: index-first continuation preserves the same decoded pictures`, { timeout: 30000 }, async () => {
    const h = await harness(variant); h.releaseReplies();
    const iterator = h.source.framesFollowing!(0);
    try {
      await h.source.ensureIndexed!(); checkPicture(await h.source.frameAt(0), 0);
      for (const ordinal of [1, 2]) { const frame = await iterator.next(); assert.equal(frame.done, false); checkPicture(frame.value!, ordinal); }
      assert.equal(h.trace.filter(type => type === 'complete-index').length, 1);
    } finally { await h.close(); await iterator.return(undefined); }
  });
}

test('replacing a source cancels its pending startup continuation and physically exits its Worker', { timeout: 30000 }, async () => {
  const old = await harness('st'), replacement = await harness('st');
  const session = new ReviewSession(() => {}), timer = holdBackgroundStart();
  const iterator = old.source.framesFollowing!(0);
  try {
    await session.load('A', async () => old.source); old.holdNext();
    const pending = iterator.next(), rejected = assert.rejects(pending, /释放|exit/);
    await bounded(old.nextReply.promise, 'old continuation never reached the reply gate');
    const snapshot = structuredClone(old.source.info), exited = once(old.worker, 'exit');
    replacement.releaseReplies();
    await session.load('A', async () => replacement.source);
    await bounded(exited, 'replaced Worker remained alive'); await rejected;
    old.releaseReplies();
    assert.deepEqual(old.source.info, snapshot, 'late old index/next replies do not mutate disposed source');
    assert.equal(session.getState().tracks[0].id, replacement.source.info.id);
    await replacement.source.ensureIndexed!();
    checkPicture((await replacement.source.framesAfter(0, 1))[0], 1);
    assert.equal(session.getState().error, null);
  } finally { timer.restore(); await session.dispose(); old.source.dispose(); replacement.source.dispose(); await iterator.return(undefined); }
});

test('a real failed server index rejects startup continuation instead of yielding EOF', { timeout: 30000 }, async () => {
  const failIndex = deferred(), indexRequested = deferred();
  let requests = 0;
  const server = createServer(async (req, res) => {
    if (req.url?.includes('/frame-index')) {
      requests++; indexRequested.resolve(); await failIndex.promise;
      res.writeHead(400); res.end('deliberate terminal index failure'); return;
    }
    const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '');
    if (!match) { res.writeHead(400); res.end(); return; }
    const start = Number(match[1]), end = Math.min(Number(match[2]), bytes.length - 1);
    res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${bytes.length}`, 'Content-Length': end - start + 1 }); res.end(bytes.subarray(start, end + 1));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  let h: Awaited<ReturnType<typeof harness>> | undefined;
  let timer: ReturnType<typeof holdBackgroundStart> | undefined;
  let iterator: AsyncGenerator<DecodedFrame> | undefined;
  try {
    h = await harness('st', { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/api/media/${'a'.repeat(24)}?v=${'b'.repeat(24)}`, size: bytes.length });
    timer = holdBackgroundStart(); h.releaseReplies(); checkPicture(await h.source.frameAt(0), 0);
    await bounded(indexRequested.promise, 'real server index was not requested');
    iterator = h.source.framesFollowing!(0);
    const pending = iterator.next(), rejected = assert.rejects(pending, /服务端 FLV 索引未能完成/);
    await bounded(h.nextRequested.promise, 'continuation did not start while index was pending');
    failIndex.resolve(); await bounded(rejected, 'failed index was swallowed as EOF');
    assert.equal(h.source.info.indexState, 'error'); assert.equal(requests, 1);
    await assert.rejects(h.source.frameAt(1000000), /服务端 FLV 索引未能完成/);
  } finally {
    failIndex.resolve(); timer?.restore(); if (h) await h.close(); await iterator?.return(undefined);
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
