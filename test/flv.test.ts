import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { demuxFlv, FlvReader } from '../src/flv-demux.ts';
import { openFlvMedia } from '../src/flv-media.ts';

const names = ['standard-h264', 'legacy-hevc', 'private-av1', 'private-vvc', 'enhanced-hevc', 'enhanced-av1', 'enhanced-vvc'];
const core = new URL('../public/vendor/voidplayer-core/', import.meta.url);
async function fixture(name: string) {
  const bytes = await readFile(new URL(`../fixtures/flv/${name}.flv`, import.meta.url)).catch(() => { throw new Error('缺少 FLV 样片，请先运行 python3 scripts/make-flv-fixtures.py'); });
  const ref = JSON.parse(await readFile(new URL(`../fixtures/flv/${name}.json`, import.meta.url), 'utf8'));
  return { file: new File([bytes], `${name}.flv`), ref, bytes };
}
for (const name of names) {
  test(`FLV ${name}: TS index and real packet-fed WASM decoding, seek and tail`, async () => {
    const { file, ref } = await fixture(name);
    const reader = new FlvReader({ file });
    const index = await demuxFlv(reader); reader.close();
    assert.equal(index.codec, ref.codec);
    assert.deepEqual(index.order.map(i => index.packets[i].pts), ref.times);
    const source = await openFlvMedia({ file }, { name: file.name, size: file.size, lastModified: 0 }, {
      glueURL: new URL('voidplayer-core.js', core).href, wasmBinary: await readFile(new URL('voidplayer-core.wasm', core)), forceWasm: true,
    });
    try {
      assert.equal(source.info.decoder, 'ffmpeg-wasm');
      assert.equal(source.info.width, ref.width); assert.equal(source.info.height, ref.height);
      assert.equal(source.info.firstPtsUs, ref.times[0]);
      const first = await source.frameAt(0);
      const firstBytes = first.pixels!.slice(0, 8192);
      assert.ok(new Set(firstBytes).size > 2); first.close();
      const mid = Math.floor(ref.times.length / 2);
      const late = await source.frameAt(ref.times[mid] - ref.times[0]);
      assert.equal(late.sourcePtsUs, ref.times[mid]); late.close();
      const back = await source.frameAt(0);
      assert.deepEqual(back.pixels!.slice(0, 8192), firstBytes); back.close();
      const after = await source.framesAfter(0, 3);
      assert.deepEqual(after.map(f => f.sourcePtsUs), ref.times.slice(1, 4)); after.forEach(f => f.close());
      const tail = await source.frameAt(ref.times.at(-1) - ref.times[0]);
      assert.equal(tail.sourcePtsUs, ref.times.at(-1)); tail.close();
    } finally { source.dispose(); }
  });
}

test('FLV index rejects truncation, tag size mismatch and missing sequence headers', async () => {
  const { bytes } = await fixture('standard-h264');
  const noConfig = Buffer.from(bytes); noConfig[25] = 1;
  const badPrevious = Buffer.from(bytes); badPrevious.writeUInt32BE(999, 9);
  for (const invalid of [noConfig, badPrevious, bytes.subarray(0, 8), bytes.subarray(0, -2)]) {
    const reader = new FlvReader({ file: new Blob([invalid]) });
    try { await assert.rejects(demuxFlv(reader), /FLV/); } finally { reader.close(); }
  }
});

test('FLV Range reader refuses full responses before downloading their bodies', async () => {
  let requests = 0;
  const server = createServer((req, res) => { requests++; assert.equal(req.headers.range, 'bytes=0-65535'); res.writeHead(200, { 'content-length': '1000000000' }); res.write('FLV'); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const reader = new FlvReader({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, size: 1000000000 });
  try { await assert.rejects(reader.read(0, 9), /Range/); assert.equal(requests, 1); }
  finally { reader.close(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
});

test('FLV indexing reads bounded windows and preserves negative composition offsets', async () => {
  const { bytes } = await fixture('private-av1');
  let largestRead = 0;
  class ChunkOnlyBlob extends Blob {
    override arrayBuffer(): Promise<ArrayBuffer> { throw new Error('whole-file read forbidden'); }
    override slice(start?: number, end?: number, type?: string) {
      largestRead = Math.max(largestRead, (end ?? this.size) - (start ?? 0));
      return super.slice(start, end, type);
    }
  }
  const reader = new FlvReader({ file: new ChunkOnlyBlob([bytes]) });
  try {
    const index = await demuxFlv(reader);
    assert.ok(index.packets.some(p => p.pts < p.dts));
    assert.ok(largestRead <= 64 * 1024);
    assert.ok(index.packets.every(p => !('data' in p)), 'index must not retain payloads');
  } finally { reader.close(); }
});
