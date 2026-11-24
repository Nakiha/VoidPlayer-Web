import { createSourceQuerier } from '../../shared/analysis/metadata/adapters.ts';
import { DiagramStore } from '../../shared/analysis/bitstream/diagrams.ts';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { AnnexBPacketSource } from '../../shared/media/containers/annex-b-packet-source.ts';
import { probeContainer } from '../../src/media/policy/container-probe.ts';
import { selectVideoInputs } from '../../src/ui/video-input.ts';
import { openAnalysisInput } from '../../shared/analysis/bitstream/input.ts';
import { analyzePicture, analyzeStream } from '../../shared/analysis/bitstream/runner.ts';
import { JS_ANNEX_B_MEDIA_INDEX_IDENTITY } from '../../shared/media/indexing/media-index-identity.ts';
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

for (const [codec, name, sampleFps] of samples) test(`Annex-B ${codec} seeks to native pixels and analyzes the same reordered picture`, async () => {
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
    const stats = engine.analysisIndex!.packets, querier = createSourceQuerier();
    const decodeRank = order.findIndex((au, rank) => au !== rank), decodeAu = order[decodeRank];
    assert.ok(decodeRank >= 0, 'fixture has presentation reordering');
    assert.equal(stats[decodeAu].dts, null);
    assert.equal(stats[decodeAu].derivedDts, Math.round(decodeAu * 1e6 / actualFps));
    assert.equal(querier.rank(stats, 0, 'dts', stats[decodeAu].derivedDts!).ordinal, decodeAu);
    assert.equal(querier.rank(stats, 0, 'pts', stats[decodeAu].pts!).sourceDtsUs, null);
    assert.equal(querier.sampleAtNumber(stats, 0, 'dts', decodeAu), opened.times[decodeRank]);
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
    const signal = new AbortController().signal;
    const analysisReader = () => new RangeReader({ file: local });
    const identity = JS_ANNEX_B_MEDIA_INDEX_IDENTITY;
    const analysis = await openAnalysisInput(analysisReader(), signal, false, { sourceVersion: name, indexIdentity: identity });
    try {
      const position = 71, pts = opened.times[position], au = order[position], packet = analysis.packets[au];
      const presented = await engine.at(pts);
      const picture = analysis.picture(packet, name), { sourceVersion: _version, picture: _picture, layer: _layer, field: _field, ...playbackPicture } = picture;
      assert.deepEqual(presented.packetPicture, playbackPicture);
      assert.equal(packet.timing?.pts, null);
      assert.equal(packet.dts, null);
      const firstAu = analysis.packets[0];
      assert.deepEqual(await analysis.readUnit(firstAu), new Uint8Array(bytes.subarray(firstAu.offset, firstAu.offset + firstAu.size)));
      await assert.rejects(analysis.plan({ sourceVersion: name, sourcePtsUs: pts, normalizedMediaUs: pts,
        picture: { ...picture, au: picture.au + 1 } }), { code: 'ambiguous-picture-identity' });
      const { default: createCore } = await import(pathToFileURL(resolve('public/vendor/voidplayer-analysis/voidplayer-analysis.js')).href);
      const result = await analyzePicture(analysisReader(), { sourceVersion: name, sourcePtsUs: pts, normalizedMediaUs: pts,
        picture, indexIdentity: identity }, createCore, 'annexb-test', signal);
      assert.equal(result.confidence, 'exact');
      assert.deepEqual(result.picture, picture);
      assert.equal(result.sourcePtsUs, pts);
      assert.equal(result.sourceDtsUs, null);
      assert.equal(result.derivedDtsUs, Math.round(au * 1e6 / actualFps));
      assert.equal(result.containerHeader?.box, 'annexb');
      assert.equal(result.capabilities.bits, 'ready');
      assert.ok(result.blocks.some(block => (block.bits ?? 0) > 0));
      const originalReader = new RangeReader({ file: new Blob([await readFile(file)]) });
      const original = await openAnalysisInput(originalReader, signal);
      try {
        const originalPacket = original.packets[au];
        const reference = await analyzePicture(originalReader, { sourceVersion: 'mp4-oracle', sourcePtsUs: originalPacket.pts,
          normalizedMediaUs: originalPacket.pts - original.packets[0].pts }, createCore, 'annexb-test', signal, { input: original });
        assert.deepEqual(result.blocks, reference.blocks, 'raw and MP4 produce the same block geometry, modes, QP and bit counts for this AU');
        assert.deepEqual(result.references, reference.references);
      } finally { original.close(); }
      assert.equal((await engine.next(pts))?.pts, opened.times[position + 1], 'analysis leaves playback cursor in place');
    } finally { analysis.close(); }
    await engine.at(opened.times.at(-1)!);
    assert.equal(await engine.next(opened.times.at(-1)!), null, 'EOF follows the final decoded frame');
  } finally { engine.close(); }
});

test('Annex-B VVC summary stream delivers each AU with its indexed display time', async () => {
  const file = 'fixtures/video/h266_10s_1920x1080.mp4', fixture = await annexBFixture(file, 'vvc', 16);
  const { default: createCore } = await import(pathToFileURL(resolve('public/vendor/voidplayer-analysis/voidplayer-analysis.js')).href);
  const reader = new RangeReader({ file: new Blob([fixture.bytes]) });
  const sourceVersion = 'raw-summary', indexIdentity = JS_ANNEX_B_MEDIA_INDEX_IDENTITY;
  const seen = new Map<number, number>(), charts = new DiagramStore();
  const dtsOrder = Array.from({length: fixture.timestamps.length}, (_, au) => au);
  await analyzeStream(reader, { mode: 'stream', product: 'summary', sourceVersion, indexIdentity, firstPtsUs: 0,
    durationUs: 266933, window: {startUs: 0, endUs: 266933, axis: 'dts'} }, createCore, 'annexb-test', new AbortController().signal, async result => {
    assert.equal(result.confidence, 'exact');
    assert.equal(result.sourceDtsUs, null);
    assert.ok(!seen.has(result.picture.au));
    seen.set(result.picture.au, result.sourcePtsUs);
    assert.ok('product' in result && result.product === 'summary');
    charts.putSummary(result);
  }, async () => {});
  const order = fixture.timestamps.map((_, au) => au).sort((a, b) => fixture.timestamps[a] - fixture.timestamps[b]);
  assert.equal(seen.size, order.length);
  assert.deepEqual(charts.queryChart(sourceVersion, 0, 266933, 1024, 'dts').pictures.map(p => p.picture.au), dtsOrder);
  assert.deepEqual(charts.queryChart(sourceVersion, 0, 266933, 1024, 'pts').pictures.map(p => p.picture.au), order);
  assert.deepEqual(order, [...seen].sort((a, b) => a[1] - b[1]).map(([au]) => au));
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
