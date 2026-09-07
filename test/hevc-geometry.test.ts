import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hevcGeometry, parseHevcSpsGeometry, verifyHevcFrame } from '../src/hevc-geometry.ts';
import { flvDecoderConfig, FlvReader, demuxFlv } from '../src/flv-demux.ts';
import { resolutionFlv } from '../scripts/flv-resolution-fixture.ts';

function sps(chroma = 1, right = 8) {
  const bits: number[] = [];
  const n = (v: number, count: number) => { for (let i = count-1; i >= 0; i--) bits.push((v >>> i) & 1); };
  const ue = (v: number) => { const size = Math.floor(Math.log2(v+1)); n(0, size); n(v+1, size+1); };
  n(0,4); n(0,3); n(1,1); for (let i=0;i<12;i++) n(0,8);
  ue(0); ue(chroma); if(chroma===3)n(0,1); ue(736); ue(1280);
  n(1,1); ue(0); ue(right); ue(0); ue(0);
  ue(0);ue(0);ue(4);n(0,1);ue(2);ue(0);ue(0);
  for(let i=0;i<6;i++)ue(0);
  n(0,1);n(0,2);n(0,1);ue(0);n(0,1);n(0,2);n(1,1);n(1,1);n(1,8);n(1,1);
  while(bits.length%8)bits.push(0);
  const bytes: number[]=[0x42,1]; let zeros=0;
  for(let i=0;i<bits.length;i+=8){let byte=0;for(let j=0;j<8;j++)byte=byte*2+bits[i+j];if(zeros===2&&byte<=3){bytes.push(3);zeros=0;}bytes.push(byte);zeros=byte===0?zeros+1:0;}
  return Uint8Array.from(bytes);
}
test('HEVC crop units depend on chroma format: 736 minus 8 chroma samples is 720, not 728', () => {
  assert.equal(parseHevcSpsGeometry(sps()).width, 720);
  assert.equal(parseHevcSpsGeometry(sps(2)).width, 720);
  assert.equal(parseHevcSpsGeometry(sps(3)).width, 728);
  assert.throws(()=>parseHevcSpsGeometry(sps().subarray(0,8)));
  assert.equal(hevcGeometry(new Uint8Array(24)), null);
});
test('wrong decoded pixel rectangles are rejected rather than stretched', () => {
  const frame = { codedWidth:1280,codedHeight:736,visibleRect:{width:1280,height:720},displayWidth:1280,displayHeight:720 } as VideoFrame;
  assert.throws(()=>verifyHevcFrame(frame,parseHevcSpsGeometry(sps())), /期望 720×1280.*visible=1280×720/);
});
test('real portrait HEVC SPS supplies coded size, crop and SAR to WebCodecs', async () => {
  for (const sar of ['1','4/3']) {
    const reader = new FlvReader({file:new Blob([Uint8Array.from(await resolutionFlv('hevc',['244x436'],sar))])});
    try {
      const index = await demuxFlv(reader), geometry=hevcGeometry(index.description)!;
      assert.ok(geometry);assert.equal(geometry.width,244);assert.equal(geometry.height,436);
      assert.equal(geometry.sarNum/geometry.sarDen,sar==='1'?1:4/3);
      const config=flvDecoderConfig(index)!;
      assert.equal(config.codedWidth,geometry.codedWidth);assert.equal(config.codedHeight,geometry.codedHeight);
      assert.equal(config.displayAspectWidth!/config.displayAspectHeight!,244/436*geometry.sarNum/geometry.sarDen);
    } finally {reader.close();}
  }
});
