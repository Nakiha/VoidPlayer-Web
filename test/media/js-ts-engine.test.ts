import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { WorkerRpc } from '../../src/worker-rpc.ts';
import type { PacketCommands } from '../../src/worker-protocol.ts';
import { tsPictureStream } from '../../src/ts-packet-index.ts';
import { visiblePixelHash } from '../helpers/visible-pixels.ts';
import { readWasmFrame } from '../../src/wasm-frame.ts';
import { tsFixture, loadTsCore } from '../helpers/media/ts-analysis.ts';
import { openJsTsAnalysisInput } from '../../src/bitstream-analysis/js-ts-input.ts';
import { analyzePicture } from '../../src/bitstream-analysis/runner.ts';

test('real packet Worker TS engine drains, seeks and shares exact identity with independent codec analysis without container WASM', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'voidplayer-js-ts-engine-'));
  const bytes = await readFile('fixtures/ts-analysis/h264-static.ts');
  const glue = pathToFileURL(resolve('public/vendor/voidplayer-core/voidplayer-core.js')).href;
  // Trap the actual loaded core API, rather than inferring routing from names.
  const wrapper = join(directory, 'packet-only.mjs');
  await writeFile(wrapper, `import load from ${JSON.stringify(glue)}; export default async function(options) { const core = await load(options); core._vp_open = () => { throw new Error('container WASM forbidden'); }; return core; }`);
  const worker = new Worker(new URL('../../src/packet-worker.ts', import.meta.url));
  const rpc = new WorkerRpc<PacketCommands>(worker as unknown as globalThis.Worker);
  const oracle = await tsFixture();
  try {
    const initialized = await rpc.call('init', { container: 'ts', input: { file: new Blob([bytes]) }, sourceVersion: 'engine-ts-v1',
      glueURL: pathToFileURL(wrapper).href, wasmBinary: new Uint8Array(await readFile('public/vendor/voidplayer-core/voidplayer-core.wasm')),
      forceWasm: false, threads: 1 }, [], 60000);
    assert.equal(initialized.decoder, 'ffmpeg-wasm', 'Node native-unavailable fallback is packet-fed');
    assert.equal(initialized.codec, 'h264'); assert.equal(initialized.times.length, 600);
    const index = await rpc.call('analysis-ts-index', {});
    assert.equal(index.sourceVersion, 'engine-ts-v1'); assert.equal(index.packets.length, 600);
    assert.equal(index.packets.filter(p => p.timing.dts === null).length, 138);
    for (const au of [0, 3, 200, 560, 599, 0]) {
      const frame = await rpc.call('at', { pts: index.packets[au].ptsUs }); assert.ok(frame);
      assert.deepEqual(frame.packetPicture, { au, configuration: 0, stream: tsPictureStream(index) });
      assert.equal(frame.pts, index.packets[au].ptsUs);
      assert.equal(oracle.play._vp_extract(oracle.ctx, oracle.ordered[au].pts), 1);
      const expected = readWasmFrame(oracle.play, () => oracle.play.HEAPU8, oracle.ctx);
      assert.equal(visiblePixelHash(frame.description, frame.pixels!), visiblePixelHash(expected.description, expected.pixels!), `AU ${au}: full visible planes`);
      frame.frame?.close();
    }
    const ids = new Set<number>();
    let frame = await rpc.call('at', { pts: index.packets[0].ptsUs });
    while (frame) {
      assert.ok(frame.packetPicture); assert.ok(!ids.has(frame.packetPicture.au)); ids.add(frame.packetPicture.au);
      const pts = frame.pts; frame.frame?.close(); frame = await rpc.call('next', { pts });
    }
    assert.equal(ids.size, 600, 'actual complete EOF output, no fabricated index frames');
    const reader = { size: bytes.length, async read(offset: number, length: number) { return bytes.subarray(offset, offset + length); }, close() {} };
    const signal = new AbortController().signal;
    // Worker serialization is metadata, not an authority token: a separate
    // analysis reader fully verifies it, while playback retains its own cursor.
    const analysis = await openJsTsAnalysisInput(reader, index.sourceVersion, signal, index);
    const packet = analysis.packets[560], picture = analysis.picture(packet, index.sourceVersion);
    const core = await loadTsCore(); core._vpd_open = () => { throw new Error('analysis container WASM forbidden'); };
    const result = await analyzePicture(reader, { sourceVersion: index.sourceVersion, sourcePtsUs: packet.pts, normalizedMediaUs: 0, picture }, core, 'engine-test', signal, { input: analysis });
    assert.equal(result.confidence, 'exact'); assert.deepEqual(result.picture, picture);
    const after = await rpc.call('at', { pts: index.packets[560].ptsUs }); assert.ok(after);
    assert.deepEqual(after.packetPicture, { au: picture.au, configuration: picture.configuration, stream: picture.stream });
    after.frame?.close();
    const presentationOrder = [...index.packets].sort((a,b)=>a.ptsUs-b.ptsUs);
    const ranked = await rpc.call('extract', {position:3}); assert.equal(ranked?.packetPicture?.au,presentationOrder[3].au); ranked?.frame?.close();
    await assert.rejects(rpc.call('extract', { position: 600 }), /out of bounds/);
    assert.equal((await rpc.call('analysis-index', {})).complete, true, 'failed input request leaves the source intact');
    await rpc.call('dispose', {});
    await assert.rejects(rpc.call('at', { pts: index.packets[0].ptsUs }), /未初始化/);
  } finally { rpc.terminate(); oracle.close(); await rm(directory, { recursive: true, force: true }); }
});

test('TS admission failures never load a decoder or silently open a container core', async () => {
  for (const [name, reason] of [['progressive-two-slices.ts', /picture layout/], ['mbaff.ts', /interlaced/]] as const) {
    const worker = new Worker(new URL('../../src/packet-worker.ts', import.meta.url));
    const rpc = new WorkerRpc<PacketCommands>(worker as unknown as globalThis.Worker);
    try {
      const bytes = await readFile(`fixtures/ts-analysis/${name}`);
      await assert.rejects(rpc.call('init', {container:'ts',sourceVersion:`negative-${name}`,input:{file:new Blob([bytes])},
        forceWasm:false,glueURL:'file:///deliberately-missing-container-core.js'}, [], 60000), reason);
      await rpc.call('dispose', {});
    } finally { rpc.terminate(); }
  }
});
