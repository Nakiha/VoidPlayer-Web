import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { openGopFlv } from '../scripts/open-gop-fixture.ts';
import { FlvEngine } from '../src/flv-engine.ts';
import { flvMediaTiming } from '../src/flv-demux.ts';
import { parseFlvIndex, serializeFlvIndex } from '../src/flv-index-cache.ts';
import { openFlvMedia } from '../src/flv-media.ts';

const bytes = await openGopFlv();
test('open-GOP completion and cached indexes preserve the startup clock and signed preroll', async () => {
  const engine = new FlvEngine({ file: new Blob([new Uint8Array(bytes)]) });
  try {
    const startup = await engine.prepare();
    const origin = startup.index.packets[0].pts;
    const complete = await engine.completeIndex();
    assert.equal(complete.firstPtsUs, origin);
    assert.ok(complete.times[0] < 0, 'real leading pictures precede the starting key packet');
    assert.ok(complete.durationUs > 2000000);
    const cached = parseFlvIndex(serializeFlvIndex(engine.index, bytes.length), bytes.length);
    assert.deepEqual(flvMediaTiming(cached), flvMediaTiming(engine.index));
    assert.ok(cached.packets.some(p => p.pts < origin));
    assert.equal(startup.index.packets.length, 1);
  } finally { engine.close(); }
});

test('real WASM open-GOP startup, complete playback and repeated seeks share frame identity', async () => {
  const file = new File([new Uint8Array(bytes)], 'open-gop.flv');
  const source = await openFlvMedia({ file }, file, {
    glueURL: new URL('../public/vendor/voidplayer-core/voidplayer-core.js', import.meta.url).href,
    wasmBinary: await readFile(new URL('../public/vendor/voidplayer-core/voidplayer-core.wasm', import.meta.url)), forceWasm: true,
  });
  try {
    const first = await source.frameAt(0), origin = first.sourcePtsUs;
    const pixels = Buffer.from(first.pixels!); assert.equal(first.ptsUs, 0); first.close();
    await source.ensureIndexed!();
    assert.equal(source.info.indexState, 'complete');
    assert.equal(source.info.firstPtsUs, origin);
    const times: number[] = [];
    for await (const frame of source.framesFrom(0)) { times.push(frame.ptsUs); frame.close(); }
    const reference = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v', '-show_entries', 'frame=pts_time', '-of', 'json', '-i', 'pipe:0'], { input: bytes, encoding: 'utf8' })).frames
      .map((f: { pts_time: string }) => Math.round(Number(f.pts_time) * 1000000) - origin).filter((pts: number) => pts >= 0);
    assert.deepEqual(times, reference, 'every display frame matches independent FFmpeg output');
    assert.equal(times[0], 0);
    assert.ok(times.every((p, i) => i === 0 || p > times[i - 1]));
    for (const time of [1500000, 0, 2700000, 0]) {
      const frame = await source.frameAt(time);
      try { if (time === 0) { assert.equal(frame.sourcePtsUs, origin); assert.deepEqual(Buffer.from(frame.pixels!), pixels); } }
      finally { frame.close(); }
    }
  } finally { source.dispose(); }
});
