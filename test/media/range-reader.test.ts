import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { BrowserWorker as Worker } from '../helpers/browser-worker-host.ts';
import { RangeReader } from '../../shared/media/io/range-reader.ts';
import { MediaOpenError } from '../../shared/media/io/media-errors.ts';
import { createRangeBridge } from '../../src/media/io/range-bridge.ts';
import { WorkerRpc } from '../../src/media/decoding/ffmpeg-media.ts';

test('Range cache is bounded, pinned to a file version and validates response bodies', async t => {
  let requests = 0, invalid = '', cancelled = 0;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, options: RequestInit) => {
    requests++;
    const range = (options.headers as Record<string, string>).Range;
    const [, a, b] = /^bytes=(\d+)-(\d+)$/.exec(range)!, start = +a, end = +b;
    if (invalid === 'whole') return new Response(new ReadableStream({ cancel() { cancelled++; } }), { status: 200 });
    const length = end - start + 1 + (invalid === 'overflow' ? 1 : invalid === 'short' ? -1 : 0);
    return new Response(new Uint8Array(length).fill(start / 262144), { status: 206,
      headers: { 'Content-Range': `bytes ${start}-${end}/16777216`, ETag: invalid === 'version' ? '"new"' : '"old"' } });
  });
  const reader = new RangeReader({ url: 'https://test.invalid/video', size: 16 * 1024 ** 2 });
  try {
    await reader.read(0, 10); await reader.read(10, 10); assert.equal(requests, 1);
    for (let i = 1; i <= 33; i++) assert.equal((await reader.read(i * 262144, 1))[0], i);
    const before = requests; await reader.read(0, 1); assert.equal(requests, before + 1, 'evicts beyond 8 MiB');
    for (const mode of ['whole', 'version', 'overflow', 'short']) {
      invalid = mode; await assert.rejects(reader.read(15 * 1024 ** 2, 1));
    }
    assert.equal(cancelled, 1, '200 body cancelled before any read');
  } finally { reader.close(); }
});

test('Playback prefetch overlaps consumption, joins demand, stops when idle and keeps the compressed cache bounded', async t => {
  const block = 256 * 1024, size = 16 * 1024 ** 2;
  const requests: { start: number; end: number }[] = [];
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  t.mock.method(globalThis, 'fetch', async (_url: unknown, options: RequestInit) => {
    const [, a, b] = /^bytes=(\d+)-(\d+)$/.exec((options.headers as Record<string, string>).Range)!;
    const start = +a, end = +b;
    requests.push({ start, end });
    assert.ok(end < size && end - start < 2 * 1024 ** 2);
    if (requests.length === 2) await pending;
    return new Response(new Uint8Array(end - start + 1).map((_, i) => Math.floor((start + i) / block)),
      { status: 206, headers: { 'Content-Range': `bytes ${start}-${end}/${size}`, ETag: '"old"' } });
  });
  const reader = new RangeReader({ url: 'https://test.invalid/video', size });
  try {
    await reader.read(0, 1);
    assert.equal(requests.length, 1, 'opening/metadata readers remain demand-only');
    reader.setPlaybackReadAhead(true);
    await reader.read(1, 1);
    assert.equal(requests.length, 2, 'fetch next compressed window before the current block runs out');
    assert.deepEqual(requests[1], { start: block, end: block + 2 * 1024 ** 2 - 1 });
    assert.equal((await reader.read(2, 1))[0], 0, 'cached playback is not held behind prefetch');
    reader.cachedWindows(); reader.peek(0, 1);
    assert.equal(requests.length, 2, 'observers and repeated reads do not start more requests');
    const demanded = reader.read(block, 1);
    await Promise.resolve();
    assert.equal(requests.length, 2, 'the next demand joins the in-flight fetch');
    release();
    assert.equal((await demanded)[0], 1);
    await new Promise<void>(resolve => setImmediate(resolve));
    const afterConsumption = requests.length;
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(requests.length, afterConsumption, 'idle playback does not recursively fetch');
    for (let i = 2; i < size / block; i++) {
      assert.equal((await reader.read(i * block, 1))[0], i);
      assert.ok(reader.cachedWindows().reduce((n, window) => n + window.length, 0) <= 8 * 1024 ** 2);
    }
    assert.equal(requests.at(-1)!.end, size - 1, 'the final speculative window is clipped at physical EOF');
  } finally { release(); reader.close(); }
});

test('Seeking/closing aborts speculative IO and late responses cannot refill or change the reader', async t => {
  const block = 256 * 1024, size = 16 * 1024 ** 2;
  let release!: () => void, releaseClose!: () => void, aheadSignal: AbortSignal | undefined, closeSignal: AbortSignal | undefined;
  let requests = 0;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const pendingClose = new Promise<void>(resolve => { releaseClose = resolve; });
  t.mock.method(globalThis, 'fetch', async (_url: unknown, options: RequestInit) => {
    const request = ++requests;
    const [, a, b] = /^bytes=(\d+)-(\d+)$/.exec((options.headers as Record<string, string>).Range)!;
    if (request === 2) { aheadSignal = options.signal!; await pending; }
    if (request === 4) { closeSignal = options.signal!; await pendingClose; }
    // Deliberately ignore cancellation, as an already-arriving response can do.
    return new Response(new Uint8Array(+b - +a + 1), { status: 206,
      headers: { 'Content-Range': `bytes ${a}-${b}/${size}`, ETag: request === 2 ? '"late"' : '"old"' } });
  });
  const reader = new RangeReader({ url: 'https://test.invalid/video', size });
  try {
    await reader.read(0, 1);
    reader.setPlaybackReadAhead(true); await reader.read(1, 1);
    assert.equal(aheadSignal?.aborted, false);
    reader.setPlaybackReadAhead(false);
    assert.equal(aheadSignal?.aborted, true);
    await reader.read(8 * 1024 ** 2, 1);
    release();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(reader.peek(block, 1), undefined);
    assert.equal(reader.version.validator, '"old"');
    assert.equal(requests, 3, 'seek remains demand-only');
    reader.setPlaybackReadAhead(true); await reader.read(8 * 1024 ** 2, 1);
    assert.equal(closeSignal?.aborted, false);
    reader.close();
    assert.equal(closeSignal?.aborted, true);
    releaseClose();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(reader.cachedWindows(), []);
    await assert.rejects(reader.read(0, 1), /取消/);
  } finally { release(); releaseClose(); reader.close(); }
});

test('File playback uses the same bounded prefetch and joins slow filesystem reads', async t => {
  const block = 256 * 1024, file = new Blob([new Uint8Array(12 * 1024 ** 2).map((_, i) => Math.floor(i / block))]);
  const slice = file.slice.bind(file), requests: { start: number; end: number }[] = [];
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  t.mock.method(file, 'slice', (start = 0, end = file.size) => {
    requests.push({ start, end });
    const part = slice(start, end), read = part.arrayBuffer.bind(part), delayed = requests.length === 2;
    t.mock.method(part, 'arrayBuffer', async () => { if (delayed) await pending; return read(); });
    return part;
  });
  const reader = new RangeReader({ file });
  try {
    await reader.read(0, 1);
    reader.setPlaybackReadAhead(true);
    await reader.readMetadata(0, 1);
    assert.equal(requests.length, 1, 'metadata observation does not initiate playback prefetch');
    await reader.read(1, 1);
    assert.deepEqual(requests[1], { start: block, end: block + 2 * 1024 ** 2 });
    assert.equal((await reader.read(2, 1))[0], 0, 'a slow mounted-file read does not block cached frames');
    const demanded = reader.read(block, 1);
    await Promise.resolve();
    assert.equal(requests.length, 2, 'the actual file demand joins prefetch');
    release();
    assert.equal((await demanded)[0], 1);
    for (let i = 2; i < file.size / block; i++) {
      assert.equal((await reader.read(i * block, 1))[0], i);
      assert.ok(reader.cachedWindows().reduce((n, window) => n + window.length, 0) <= 8 * 1024 ** 2);
    }
    assert.equal(requests.at(-1)!.end, file.size);
  } finally { release(); reader.close(); }
});

test('Uncancellable file IO stays bounded across seek/resume and cannot populate the old playback window', async t => {
  const block = 256 * 1024, file = new Blob([new Uint8Array(12 * 1024 ** 2)]), slice = file.slice.bind(file);
  let requests = 0, release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  t.mock.method(file, 'slice', (start = 0, end = file.size) => {
    const part = slice(start, end), read = part.arrayBuffer.bind(part), delayed = ++requests === 2;
    t.mock.method(part, 'arrayBuffer', async () => { if (delayed) await pending; return read(); });
    return part;
  });
  const reader = new RangeReader({ file });
  try {
    await reader.read(0, 1);
    reader.setPlaybackReadAhead(true); await reader.read(1, 1);
    assert.equal(requests, 2);
    reader.setPlaybackReadAhead(false); reader.setPlaybackReadAhead(true);
    await reader.read(0, 1);
    assert.equal(requests, 2, 'seek/resume does not stack another uncancellable speculative read');
    await reader.read(8 * 1024 ** 2, 1);
    assert.equal(requests, 3, 'an unrelated demand does not wait for old prefetch');
    release(); await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(reader.peek(block, 1), undefined, 'late old-window bytes are discarded');
    await reader.read(8 * 1024 ** 2, 1);
    assert.equal(requests, 4, 'consumption can restart prefetch after the old IO settles');
    reader.close(); await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(reader.cachedWindows(), []);
  } finally { release(); reader.close(); }
});

for (const failure of ['short', 'unavailable']) test(`File prefetch propagates ${failure} reads without retrying`, async t => {
  const block = 256 * 1024, file = new Blob([new Uint8Array(4 * 1024 ** 2)]), slice = file.slice.bind(file);
  let requests = 0;
  t.mock.method(file, 'slice', (start = 0, end = file.size) => {
    const part = slice(start, end), read = part.arrayBuffer.bind(part), failing = ++requests === 2;
    t.mock.method(part, 'arrayBuffer', async () => {
      if (!failing) return read();
      if (failure === 'unavailable') throw new DOMException('Mounted file is unavailable', 'NotReadableError');
      return new ArrayBuffer(end - start - 1);
    });
    return part;
  });
  const reader = new RangeReader({ file });
  try {
    await reader.read(0, 1);
    reader.setPlaybackReadAhead(true); await reader.read(1, 1);
    await assert.rejects(reader.read(block, 1), error => error instanceof MediaOpenError && error.stage === 'input');
    assert.equal(requests, 2);
    assert.equal(reader.peek(block, 1), undefined);
  } finally { reader.close(); }
});

test('Speculative Range failures retain strict response/version checks and reject the eventual consumer without retrying', async t => {
  const block = 256 * 1024, size = 16 * 1024 ** 2;
  for (const invalid of ['whole', 'version', 'range', 'short', 'overflow']) {
    let requests = 0;
    const mock = t.mock.method(globalThis, 'fetch', async (_url: unknown, options: RequestInit) => {
      const request = ++requests;
      const [, a, b] = /^bytes=(\d+)-(\d+)$/.exec((options.headers as Record<string, string>).Range)!;
      if (request === 2) assert.equal((options.headers as Record<string, string>)['If-Range'], '"old"');
      if (request === 2 && invalid === 'whole') return new Response(null, { status: 200 });
      const length = +b - +a + 1 + (request === 2 ? invalid === 'short' ? -1 : invalid === 'overflow' ? 1 : 0 : 0);
      return new Response(new Uint8Array(length), { status: 206, headers: {
        'Content-Range': `bytes ${request === 2 && invalid === 'range' ? 99 : a}-${b}/${size}`,
        ETag: request === 2 && invalid === 'version' ? '"new"' : '"old"',
      } });
    });
    const reader = new RangeReader({ url: 'https://test.invalid/video', size });
    try {
      await reader.read(0, 1);
      reader.setPlaybackReadAhead(true); await reader.read(1, 1);
      await assert.rejects(reader.read(block, 1), error => error instanceof MediaOpenError && error.stage === 'input');
      assert.equal(requests, 2, invalid);
      assert.equal(reader.peek(block, 1), undefined, 'invalid bytes never enter the cache');
    } finally { reader.close(); mock.mock.restore(); }
  }
});

test('Synchronous FFmpeg AVIO requests bounded chunks through the async bridge and preserves IO errors', { timeout: 30000 }, async t => {
  const {mkdtemp,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path'),{execFileSync}=await import('node:child_process');const directory=await mkdtemp(join(tmpdir(),'vp-residual-avio-'));t.after(()=>rm(directory,{recursive:true,force:true}));const file=join(directory,'ffv1.avi');execFileSync('ffmpeg',['-y','-v','error','-i','fixtures/video/ffv1_yuv422p_8bit.mkv','-an','-c:v','copy','-f','avi',file]);
  const bytes=await readFile(file);
  const core = new URL('../../public/vendor/voidplayer-core/', import.meta.url);
  let requests = 0, fail = false;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, options: RequestInit) => {
    requests++;
    if (fail) return new Response(null, { status: 503 });
    const [, a, b] = /^bytes=(\d+)-(\d+)$/.exec((options.headers as Record<string, string>).Range)!;
    assert.ok(+b - +a < 262144);
    return new Response(bytes.subarray(+a, +b + 1), { status: 206, headers: { 'Content-Range': `bytes ${a}-${b}/${bytes.length}` } });
  });
  let referencePixels: Uint8Array | undefined;
  for (const mode of ['url', 'failure', 'file']) {
    fail = mode === 'failure';
    const worker = new Worker(new URL('../../src/media/decoding/ffmpeg-worker.ts', import.meta.url));
    const bridge = createRangeBridge(worker as unknown as globalThis.Worker, mode === 'file' ? { file: new Blob([bytes]) }
      : { url: 'https://test.invalid/video', size: bytes.length });
    const rpc = new WorkerRpc(worker as unknown as globalThis.Worker, () => bridge.close());
    try {
      const pending = rpc.call('init', { name: 'test',
        glueURL: new URL('voidplayer-core.js', core).href, wasmBinary: await readFile(new URL('voidplayer-core.wasm', core)),
        range: { size: bytes.length, shared: bridge.shared, source: mode === 'file' ? 'blob' : 'url' },
      });
      if (fail) { await assert.rejects(pending, /503/); continue; }
      const init = await pending; assert.equal(init.ioMode, mode === 'file' ? 'blob-range' : 'http-range'); assert.ok(init.ticks.length > 1);
      bridge.setPlaybackReadAhead(true);
      const frame = await rpc.call('extract', { ctx: init.ctx, index: 1 });
      assert.equal(frame.pixels.byteLength, 320 * 180 * 2); assert.ok(new Set(new Uint8Array(frame.pixels).subarray(0, 4096)).size > 2);
      if (mode === 'url') referencePixels = new Uint8Array(frame.pixels).slice();
      else assert.deepEqual(new Uint8Array(frame.pixels), referencePixels, 'File and URL bridges produce identical pixels');
    } finally { rpc.terminate(); }
  }
  assert.ok(requests >= 2);
});
