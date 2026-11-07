import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMediaFromUrl } from '../../src/media/source.ts';
import { openSoftwareMedia } from '../../src/media/decoding/software-media.ts';
import { MediaOpenError } from '../../shared/media/io/media-errors.ts';

test('MP4 software admission preserves JS container/codec failures without a WASM demux retry', async () => {
  for (const stage of ['container', 'codec'] as const) {
    let workers = 0, stopped = 0;
    class RejectedPacketWorker extends EventTarget {
      postMessage(message: { id: number; type: string }) {
        assert.equal(message.type, 'init');
        queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', {
          data: { id: message.id, ok: false, stage, error: 'JS MP4 admission rejected' },
        })));
      }
      terminate() { stopped++; }
    }
    const file = new File([new Uint8Array(32)], 'unsupported.mp4');
    await assert.rejects(openSoftwareMedia({ file }, { name: file.name, size: file.size, lastModified: file.lastModified }, {
      glueURL: 'https://example.invalid/voidplayer-core.js', wasmBinary: new Uint8Array(),
      workerFactory: () => { workers++;return new RejectedPacketWorker() as unknown as Worker; },
    }, 'isobmff'), error => error instanceof MediaOpenError && error.stage === stage && error.message === 'JS MP4 admission rejected');
    assert.equal(workers, 1, 'only the JS packet adapter may inspect MP4');
    assert.equal(stopped, 1, 'failed adapter releases its worker');
  }
});

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
