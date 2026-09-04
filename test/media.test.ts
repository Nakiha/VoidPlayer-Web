import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Input, BufferSource, ALL_FORMATS } from 'mediabunny';
import { inspectVideoTrack } from '../src/media.ts';

async function sample(name: string) {
  return new Input({ source: new BufferSource(await readFile(new URL(`../../resources/video/${name}`, import.meta.url))), formats: ALL_FORMATS });
}

test('known MP4 video reaches decoder capability checking with its actual profile', async () => {
  const input = await sample('ci_h264_smoke.mp4');
  try {
    const result = await inspectVideoTrack(input);
    assert.equal(result.format, 'MP4'); assert.match(result.codec, /^avc1\./);
  } finally { input.dispose(); }
});

test('FFV1 and VVC are identified as missing library codecs, not unknown browser failures', async () => {
  for (const [name, expected] of [['ffv1_yuv422p_8bit.mkv', /Matroska.*FFV1/], ['h266_10s_1920x1080.mp4', /MP4.*H\.266 \/ VVC/]] as const) {
    const input = await sample(name);
    try { await assert.rejects(inspectVideoTrack(input), expected); }
    finally { input.dispose(); }
  }
});

test('an unsupported MPEG-2 TS track is not reported as proof the file has no video', async () => {
  const input = await sample('mpeg2_10s_1280x720.ts');
  try { await assert.rejects(inspectVideoTrack(input), /已识别 MPEG Transport Stream.*轨道编码尚不支持/); }
  finally { input.dispose(); }
});

test('unrecognized containers receive a format-level diagnostic', async () => {
  const input = new Input({ source: new BufferSource(new TextEncoder().encode('invalid file')), formats: ALL_FORMATS });
  try { await assert.rejects(inspectVideoTrack(input), /无法识别文件封装/); }
  finally { input.dispose(); }
});
