import { packetFixture } from './packet-fixture.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Mp4Engine } from '../src/mp4-engine.ts';
import { openFFmpegMedia } from '../src/ffmpeg-media.ts';
const core = new URL('../public/vendor/voidplayer-core/', import.meta.url);
const hash = (pixels: Uint8Array | Uint8ClampedArray) => createHash('sha256').update(pixels).digest('hex');

for (const name of ['h266_10s_1920x1080.mp4', 'h264_high422p_1s_320x180.mp4', 'hevc-packet-1080p.mp4']) {
  test(`MP4 packet WASM ${name}: metadata-only indexing and exact pixels across GOP seeks and EOF`, { timeout: 120000 }, async () => {
    const bytes = await packetFixture(name);
    let readBytes = 0;
    class ChunkBlob extends Blob {
      override arrayBuffer(): Promise<ArrayBuffer> { throw new Error('whole-file materialization forbidden'); }
      override slice(start = 0, end = this.size) { readBytes += Math.min(end, this.size) - start; assert.ok(end - start <= 256 * 1024); return super.slice(start, end); }
    }
    const engine = new Mp4Engine({ file: new ChunkBlob([bytes]) });
    const deps = { glueURL: new URL('voidplayer-core.js', core).href, wasmBinary: await readFile(new URL('voidplayer-core.wasm', core)) };
    const reference = await openFFmpegMedia(new File([bytes], name), deps);
    try {
      const init = await engine.open(deps.glueURL, deps.wasmBinary);
      assert.equal(init.codec, reference.info.codec); assert.equal(init.pixelFormat, reference.info.pixelFormat);
      if (name.startsWith('h266')) assert.ok(readBytes < bytes.length / 2, `initial read ${readBytes}/${bytes.length}`);
      for (const position of [0, 1, 2, Math.floor(init.times.length * .6), 0, init.times.length - 1]) {
        const actual = await engine.extract(position);
        const expected = await reference.frameAt(init.times[position]);
        try {
          assert.equal(actual.pts, init.firstPtsUs + init.times[position]);
          assert.equal(hash(new Uint8Array(actual.pixels!)), hash(expected.pixels!), `frame ${position}`);
        } finally { expected.close(); }
      }
    } finally { engine.close(); reference.dispose(); }
  });
}

test('MP4 packet worker shares the session frame contract, handles EOF and releases pending work', async () => {
  const { openPacketMedia } = await import('../src/packet-media.ts');
  const bytes = await readFile(new URL('../fixtures/video/h264_high422p_1s_320x180.mp4', import.meta.url));
  const source = await openPacketMedia('mp4', { file: new Blob([bytes]) }, { name: 'high422.mp4', size: bytes.length, lastModified: 0 }, {
    glueURL: new URL('voidplayer-core.js', core).href, wasmBinary: await readFile(new URL('voidplayer-core.wasm', core)),
  });
  try {
    const first = await source.frameAt(0); assert.equal(first.kind, 'yuv'); first.close();
    const frames = await source.framesAfter(0, 2); assert.equal(frames.length, 2); frames.forEach(f => f.close());
    assert.deepEqual(await source.framesAfter(source.info.durationUs, 2), []);
    source.dispose(); await assert.rejects(source.frameAt(0), /释放/);
  } finally { source.dispose(); }
});
