import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { startupFixture } from '../scripts/flv-startup-fixture.ts';
import { openFlvMedia } from '../src/flv-media.ts';
import { ReviewSession } from '../src/session.ts';

test('first decoded frame and startup-frame seeks precede a blocked tail; completed indexes upload and are reused', { timeout: 30000 }, async () => {
  const f = await startupFixture(true);
  const core = new URL('../public/vendor/voidplayer-core/', import.meta.url);
  const deps = { glueURL: new URL('voidplayer-core.js', core).href, wasmBinary: await readFile(new URL('voidplayer-core.wasm', core)), forceWasm: true };
  const input = { url: `${f.base}/api/media/${f.entry.id}?v=${f.entry.version}`, size: f.entry.size };
  const drawn: number[] = [], session = new ReviewSession((_slot, frame) => { drawn.push(frame.sourcePtsUs); });
  const deadline = async <T>(promise: Promise<T>, ms = 5000): Promise<T> => {
    let timer: ReturnType<typeof setTimeout>;
    try { return await Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error('operation waited for blocked tail')), ms); })]); }
    finally { clearTimeout(timer!); }
  };
  try {
    await deadline(session.load('A', () => openFlvMedia(input, f.entry, deps)));
    assert.equal(drawn.length, 1); assert.equal(session.getState().tracks[0].indexState, 'building');
    await deadline(session.seek(0));
    const pending = session.seek(2500000); let finished = false; void pending.then(() => { finished = true; });
    await new Promise(r => setTimeout(r, 100)); assert.equal(finished, false); assert.ok(f.counts().delayed > 0);
    f.release(); await deadline(pending, 15000);
    assert.equal(session.getState().tracks[0].indexState, 'complete');
    assert.ok(session.getState().positionUs > 2400000);
    const end = Date.now() + 5000;
    while (!f.library.frameIndexes.list().count && Date.now() < end) await new Promise(r => setTimeout(r, 10));
    assert.equal(f.library.frameIndexes.list().count, 1, 'worker uploads completed index');
    await session.removeTrack('A'); const before = f.counts().ranges;
    await deadline(session.load('A', () => openFlvMedia(input, f.entry, deps)));
    await deadline(session.seek(2500000));
    assert.equal(session.getState().tracks[0].indexSource, 'server');
    assert.ok(f.counts().ranges - before < 10, 'cache hit does not rescan the sparse tail');
    await session.seek(0);
    // Real packet decoding, sequential playback and presentation callbacks.
    await session.play();
    await deadline((async () => { while (session.getState().playing) await new Promise(r => setTimeout(r, 20)); })(), 10000);
    assert.equal(session.getState().error, null);
    assert.ok(drawn.length > 100);
  } finally { await session.dispose(); await f.close(); }
});
