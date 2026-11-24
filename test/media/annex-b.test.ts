import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { AnnexBPacketSource } from '../../shared/media/containers/annex-b-packet-source.ts';
import { probeContainer } from '../../src/media/policy/container-probe.ts';
import { selectVideoInputs } from '../../src/ui/video-input.ts';
import { parseAnnexBPacketIndex } from '../../shared/media/indexing/annex-b-index.ts';
import { RangeReader } from '../../shared/media/io/range-reader.ts';
import { JsContainerEngine } from '../../src/media/decoding/js-container-engine.ts';
import { annexBFixture, withLeadingSei } from '../helpers/media/annex-b-fixture.ts';
import { nativeFrames, nativeVisibleFrameBytes, nativeVisibleHash } from '../helpers/media/native-pixels.ts';
import { visiblePixelHash } from '../helpers/visible-pixels.ts';

const samples = [
  ['h264', 'h264_9s_1920x1080.mp4', 60],
  ['hevc', 'dolby_hlg_1080p30.mp4', 30],
  ['vvc', 'h266_10s_1920x1080.mp4', 60000 / 1001],
] as const;

for (const [codec, name, sampleFps] of samples) test(`Annex-B ${codec} indexes B pictures and seeks to the native visible frame`, async () => {
  const file = `fixtures/video/${name}`, fixture = await annexBFixture(file, codec);
  const count = fixture.timestamps.length;
  assert.ok(count > 72);
  const bytes = withLeadingSei(fixture.bytes, codec);
  const local = new File([bytes], 'extensionless');
  assert.equal(await probeContainer({ file: local }), 'annexb', 'leading prefix SEI may exceed the initial header');
  assert.deepEqual(await selectVideoInputs([{ file: local }], error => assert.fail(error.message)), [{ file: local }]);
  const engine = new JsContainerEngine({ file: local }, name, {}, 'annexb');
  const core = resolve('public/vendor/voidplayer-core');
  try {
    const opened = await engine.open(pathToFileURL(resolve(core, 'voidplayer-core.js')).href,
      new Uint8Array(await readFile(resolve(core, 'voidplayer-core.wasm'))), false);
    assert.equal(opened.codec, codec);
    const fps = codec === 'hevc' && opened.annexBFrameRate?.source === 'bitstream'
      ? Math.round((count - 1) / (Math.max(...fixture.timestamps) - Math.min(...fixture.timestamps))) : sampleFps;
    const actualFps = opened.annexBFrameRate!.fps;
    assert.ok(Math.abs(actualFps - fps) < 0.001, `expected nominal cadence near ${fps}, got ${actualFps}`);
    assert.equal(opened.durationUs, Math.round(count * 1e6 / actualFps));
    const index = engine.packetIndex!;
    assert.equal(index.kind, 'js-annexb-packets');
    assert.equal(index.packets.length, count);
    const expected = fixture.timestamps.map((_, au) => au).sort((a, b) => fixture.timestamps[a] - fixture.timestamps[b]);
    const order = [...index.packets].sort((a, b) => a.ptsUs - b.ptsUs).map(p => p.au);
    assert.deepEqual(order, expected, 'display order agrees with independent MP4 composition timestamps');
    assert.ok(index.packets.every(p => p.timing.pts === null && p.timing.dts === null));
    const bad = structuredClone(index);
    bad.packets[1].locator = 0;
    assert.equal(parseAnnexBPacketIndex(bad, name, bytes.length), undefined);

    const positions = [0, 1, 71, count - 1, 22];
    const first = await engine.at(0);
    const frames = nativeFrames(file, positions, first.description.sourcePixelFormat!, nativeVisibleFrameBytes(first.description));
    for (const i of positions) {
      const frame = await engine.at(opened.times[i]);
      assert.equal(frame.pts, opened.times[i]);
      assert.equal(visiblePixelHash(frame.description, frame.pixels!), nativeVisibleHash(frame.description, frames.get(i)!), `rank ${i}`);
    }
    await engine.at(opened.times.at(-1)!);
    assert.equal(await engine.next(opened.times.at(-1)!), null, 'EOF follows the final decoded frame');
  } finally { engine.close(); }
});

test('Annex-B open rejects parameter sets without a picture and propagates source cancellation', async () => {
  const bytes = Uint8Array.of(0, 0, 0, 1, 0x67, 0);
  const controller = new AbortController();
  const source = new AnnexBPacketSource(new RangeReader({ file: new Blob([bytes]) }), 'malformed', controller.signal);
  try {
    await assert.rejects(source.open(), { stage: 'container' });
    controller.abort();
    await assert.rejects(source.open(), { name: 'AbortError' });
  } finally { source.close(); }
});
