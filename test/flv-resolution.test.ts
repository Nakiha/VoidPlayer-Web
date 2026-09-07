import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolutionFlv } from '../scripts/flv-resolution-fixture.ts';
import { demuxFlv, FlvReader } from '../src/flv-demux.ts';
import { serializeFlvIndex, parseFlvIndex } from '../src/flv-index-cache.ts';
import { openFlvMedia } from '../src/flv-media.ts';

for (const codec of ['h264', 'hevc']) {
  test(`FLV ${codec} configuration and resolution change survives playback, reverse seek and cache serialization`, async () => {
    const bytes = await resolutionFlv(codec), file = new File([Uint8Array.from(bytes)], 'resolution.flv');
    const reader = new FlvReader({ file });
    const index = await demuxFlv(reader); reader.close();
    assert.equal(index.configurations?.length, 2); assert.equal(index.packets.length, 20);
    const cached = parseFlvIndex(serializeFlvIndex(index, file.size), file.size); assert.deepEqual(cached, index);
    const source = await openFlvMedia({ file }, file, { forceWasm: true,
      glueURL: new URL('../public/vendor/voidplayer-core/voidplayer-core.js', import.meta.url).href,
      wasmBinary: await readFile(new URL('../public/vendor/voidplayer-core/voidplayer-core.wasm', import.meta.url)),
    });
    try {
      (await source.frameAt(0)).close(); await source.ensureIndexed!();
      let count = 0;
      for await (const frame of source.framesFrom(0)) {
        assert.equal(frame.width, count < 10 ? 320 : 640); assert.equal(frame.height, count < 10 ? 180 : 360);
        assert.equal(frame.ptsUs, count * 100000);
        count++; frame.close();
      }
      assert.equal(count, 20);
      for (const [time, width] of [[400000, 320], [1400000, 640], [0, 320], [1900000, 640]]) {
        const frame = await source.frameAt(time); assert.equal(frame.width, width); frame.close();
      }
    } finally { source.dispose(); }
  });
}

test('portrait HEVC multithread WASM survives decode growth, playback and reverse seek', async () => {
  const file = new File([Uint8Array.from(await resolutionFlv('hevc', ['720x1280']))], 'portrait.flv');
  const source = await openFlvMedia({file}, file, { forceWasm: true,
    glueURL: new URL('../public/vendor/voidplayer-core/voidplayer-core-mt.js', import.meta.url).href,
    wasmBinary: await readFile(new URL('../public/vendor/voidplayer-core/voidplayer-core-mt.wasm', import.meta.url)),
  });
  try {
    (await source.frameAt(0)).close(); await source.ensureIndexed!();
    for (let round=0; round<2; round++) {
      let count=0;
      for await (const frame of source.framesFrom(0)) {
        assert.equal(frame.width,720); assert.equal(frame.height,1280);
        assert.equal(frame.ptsUs,count*100000); count++; frame.close();
      }
      assert.equal(count,10);
      (await source.frameAt(0)).close();
    }
  } finally { source.dispose(); }
});
