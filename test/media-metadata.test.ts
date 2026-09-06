import { test } from 'node:test';
import assert from 'node:assert/strict';
import { colorLabel, ffmpegColorInfo, rangeLabel } from '../src/media-metadata.ts';

test('FFmpeg range enums distinguish limited TV, full PC and unspecified metadata', () => {
  assert.equal(rangeLabel(ffmpegColorInfo({colorRange:1}).fullRange), '有限范围 (TV)');
  assert.equal(rangeLabel(ffmpegColorInfo({colorRange:2}).fullRange), '全范围 (PC)');
  for (const colorRange of [undefined,0,3]) assert.equal(rangeLabel(ffmpegColorInfo({colorRange}).fullRange), '未标记');
});
test('independent color fields preserve BT.2020 matrix variants and HDR transfer functions', () => {
  const hdr = ffmpegColorInfo({colorPrimaries:9,colorTransfer:16,colorSpace:9,colorRange:1});
  assert.deepEqual(hdr,{primaries:'bt2020',transfer:'pq',matrix:'bt2020-ncl',fullRange:false});
  assert.equal(colorLabel(hdr.transfer),'PQ (ST 2084)');
  assert.equal(colorLabel(ffmpegColorInfo({colorTransfer:18}).transfer),'HLG (ARIB B67)');
  assert.equal(ffmpegColorInfo({colorSpace:10}).matrix,'bt2020-cl');
  assert.equal(ffmpegColorInfo({colorSpace:0}).matrix,'rgb');
  assert.deepEqual(ffmpegColorInfo({colorPrimaries:2,colorTransfer:2,colorSpace:2}),{primaries:null,transfer:null,matrix:null,fullRange:null});
  assert.equal(colorLabel(ffmpegColorInfo({colorSpace:99}).matrix),'未识别 (99)');
});
