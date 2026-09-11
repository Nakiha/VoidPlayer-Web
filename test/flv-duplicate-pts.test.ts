import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { FlvReader, scanFlv } from '../src/flv-demux.ts';
import { openFlvMedia } from '../src/flv-media.ts';

test('real WASM decodes every packet through duplicate PTS and seeks back to the same pixels', async () => {
  const bytes = await readFile(new URL('../fixtures/flv/standard-h264.flv', import.meta.url));
  const reader = new FlvReader({ file: new Blob([bytes]) });
  const { index } = await scanFlv(reader); reader.close();
  const a = index.packets[index.order[30]], b = index.packets[index.order[31]];
  const ctsMs = (a.pts - b.dts) / 1000;
  assert.ok(Number.isInteger(ctsMs) && Math.abs(ctsMs) < 0x800000);
  // Change only signed composition time in a legacy AVC tag. Keep every
  // compressed picture and every DTS intact; this is a timestamp collision.
  bytes.writeUIntBE(ctsMs & 0xffffff, b.offset - 3, 3);
  const file = new File([bytes], 'duplicate-pts.flv');
  const source = await openFlvMedia({ file }, file, {
    glueURL: new URL('../public/vendor/voidplayer-core/voidplayer-core.js', import.meta.url).href,
    wasmBinary: await readFile(new URL('../public/vendor/voidplayer-core/voidplayer-core.wasm', import.meta.url)), forceWasm: true,
  });
  try {
    await source.ensureIndexed!();
    assert.equal(source.info.indexState, 'complete');
    assert.match(source.info.indexWarning!, /1 个重复 PTS/);
    const times: number[] = []; let reference: Buffer | undefined;
    for await (const frame of source.framesFrom(0)) {
      times.push(frame.sourcePtsUs);
      if (frame.sourcePtsUs === a.pts) reference = Buffer.from(frame.pixels!);
      assert.ok(frame.durationUs > 0); frame.close();
    }
    // FFmpeg may recover distinct best-effort output times from DTS. Actual
    // decoder output remains authoritative; do not force one output per packet.
    const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v', '-show_entries',
      'frame=best_effort_timestamp_time', '-of', 'json', '-i', 'pipe:0'], { input: bytes, encoding: 'utf8' }));
    const expected = [...new Set(probe.frames.map((f: { best_effort_timestamp_time: string }) => Math.round(Number(f.best_effort_timestamp_time) * 1e6)))];
    assert.deepEqual(times, expected);
    assert.ok(times.every((p, i) => i === 0 || p > times[i - 1]));
    assert.ok(reference);
    for (const time of [a.pts, a.pts + 1000, a.pts]) {
      const frame = await source.frameAt(time - source.info.firstPtsUs);
      try { assert.deepEqual(Buffer.from(frame.pixels!), reference); }
      finally { frame.close(); }
    }
  } finally { source.dispose(); }
});
