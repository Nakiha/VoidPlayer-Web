import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { openAnalysisInput } from '../../src/bitstream-analysis/input.ts';
import { analyzePicture } from '../../src/bitstream-analysis/runner.ts';
import { Mp4Engine } from '../../src/mp4-engine.ts';
const signal = new AbortController().signal;
async function reader(file: string) { const data = await readFile(file); return { size: data.length, async read(o: number, n: number) { return data.subarray(o, o + n); }, close() {} }; }
async function core() { return (await import(pathToFileURL(resolve('public/vendor/voidplayer-analysis/voidplayer-analysis.js')).href)).default(); }
const target = (p: any) => ({ sourceVersion: 'fmp4-test', sourcePtsUs: p.pts, normalizedMediaUs: p.pts - 1600000 });
for (const codec of ['h264', 'hevc', 'vvc']) test(`finite fMP4 ${codec}: byte identity, independent current-frame answer and actual playback AU across nonkey fragments`, async () => {
  const file = `fixtures/fmp4-analysis/fragmented-${codec}.mp4`, sourceFile = { h264: 'h264_9s_1920x1080.mp4', hevc: 'h265_10s_1920x1080.mp4', vvc: 'h266_10s_1920x1080.mp4' }[codec]!;
  const input = await openAnalysisInput(await reader(file), signal), original = await openAnalysisInput(await reader(`fixtures/video/${sourceFile}`), signal);
  try {
    assert.equal(input.totalPackets, 600); assert.equal(input.indexIntegrity, 'complete'); assert.deepEqual(input.configurations, original.configurations);
    for (const p of input.packets) { assert.equal(p.au, input.packets.indexOf(p)); assert.deepEqual(await input.readUnit(p), await original.readUnit(original.packets[p.au])); assert.equal(p.timing!.dts, 96000 + p.au * 1000); }
    const answers = JSON.parse(await readFile('docs/fixtures/bitstream-analysis-answers.json', 'utf8'));
    const first = await analyzePicture(await reader(file), target(input.packets[0]), await core(), 'test', signal);
    for (const b of answers.find((a: any) => a.codec === codec).firstBlocks) assert.deepEqual(first.blocks.find(x => x.x === b.x && x.y === b.y), b);
    const rear = input.packets[200], r = await analyzePicture(await reader(file), target(rear), await core(), 'test', signal);
    const baseline = await analyzePicture(await reader(`fixtures/video/${sourceFile}`), { ...target(original.packets[200]), normalizedMediaUs: original.packets[200].pts - original.packets[0].pts }, await core(), 'test', signal);
    assert.deepEqual(r.blocks, baseline.blocks); assert.deepEqual(r.references, baseline.references); assert.ok(r.metrics!.startAu < 200, 'nonkey moof is not a random access point');
    const playback = new Mp4Engine({ file: new Blob([await readFile(file)]) });
    try { await playback.open(pathToFileURL(resolve('public/vendor/voidplayer-core/voidplayer-core.js')).href, new Uint8Array(await readFile('public/vendor/voidplayer-core/voidplayer-core.wasm')), true);
      for (const au of [0, 21, 200, 19, 599]) { const frame = await playback.at(input.packets[au].pts); assert.deepEqual(frame.packetPicture, { au, configuration: 0, stream: 'video' }); frame.frame?.close(); }
    } finally { playback.close(); }
  } finally { input.close(); original.close(); }
});
