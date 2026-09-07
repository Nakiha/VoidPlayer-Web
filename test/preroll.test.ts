import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { prerollMp4 } from '../scripts/flv-resolution-fixture.ts';
import { openFFmpegMedia } from '../src/ffmpeg-media.ts';

test('FFmpeg pre-roll discard packets do not become an unrenderable first frame', async () => {
  const file = new File([Uint8Array.from(await prerollMp4())], 'preroll.mp4');
  const source = await openFFmpegMedia(file, {
    glueURL: new URL('../public/vendor/voidplayer-core/voidplayer-core.js', import.meta.url).href,
    wasmBinary: await readFile(new URL('../public/vendor/voidplayer-core/voidplayer-core.wasm', import.meta.url)),
  });
  try {
    assert.ok(source.info.firstPtsUs >= 0);
    for (const time of [0, 500000, 0, 1000000, 0]) {
      const frame = await source.frameAt(time); assert.ok(frame.width > 0); assert.ok(frame.pixels!.some(x => x > 0)); frame.close();
    }
  } finally { source.dispose(); }
});
