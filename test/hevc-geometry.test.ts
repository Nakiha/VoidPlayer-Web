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
  assert.throws(()=>verifyHevcFrame(frame,parseHevcSpsGeometry(sps())), /期望.*720×1280.*visible=1280×720/);
});
function installVideoFrameMock() {
  const Real = (globalThis as unknown as { VideoFrame?: unknown }).VideoFrame;
  class MockFrame {
    codedWidth: number; codedHeight: number;
    visibleRect: { x: number; y: number; width: number; height: number };
    displayWidth: number; displayHeight: number; closed = false;
    constructor(source: any, init?: any) {
      if (!source || typeof source.codedWidth !== 'number') throw new Error('mock supports clone only');
      this.codedWidth = source.codedWidth; this.codedHeight = source.codedHeight;
      const r = init?.visibleRect ?? source.visibleRect;
      this.visibleRect = { x: r.x ?? 0, y: r.y ?? 0, width: r.width, height: r.height };
      this.displayWidth = init?.displayWidth ?? source.displayWidth;
      this.displayHeight = init?.displayHeight ?? source.displayHeight;
      if (this.visibleRect.x < 0 || this.visibleRect.y < 0 ||
        this.visibleRect.x + this.visibleRect.width > this.codedWidth ||
        this.visibleRect.y + this.visibleRect.height > this.codedHeight) throw new Error('visible out of bounds');
    }
    close() { this.closed = true; }
  }
  (globalThis as unknown as { VideoFrame: unknown }).VideoFrame = MockFrame;
  return () => {
    if (Real === undefined) delete (globalThis as unknown as { VideoFrame?: unknown }).VideoFrame;
    else (globalThis as unknown as { VideoFrame: unknown }).VideoFrame = Real;
  };
}
function mockFrame(coded: [number, number], visible: [number, number, number, number], display: [number, number]) {
  let closed = false;
  const frame = { codedWidth: coded[0], codedHeight: coded[1],
    visibleRect: { x: visible[0], y: visible[1], width: visible[2], height: visible[3] },
    displayWidth: display[0], displayHeight: display[1], close() { closed = true; } } as unknown as VideoFrame & { close(): void };
  return { frame, wasClosed: () => closed };
}
test('browser conformance padding is narrowed with metadata, keeping WebCodecs', () => {
  const restore = installVideoFrameMock();
  try {
    const geometry = { codedWidth: 720, codedHeight: 1272, x: 0, y: 0, width: 720, height: 1270, sarNum: 1, sarDen: 1 };
    const { frame, wasClosed } = mockFrame([720, 1272], [0, 0, 720, 1272], [721, 1272]);
    const events: Record<string, unknown>[] = [];
    const out = verifyHevcFrame(frame, geometry, e => events.push(e)) as unknown as { visibleRect: { x: number; y: number; width: number; height: number }; displayWidth: number; displayHeight: number; closed: boolean };
    assert.equal(out.visibleRect.width, 720); assert.equal(out.visibleRect.height, 1270);
    assert.equal(out.visibleRect.x, 0); assert.equal(out.visibleRect.y, 0);
    assert.equal(out.displayWidth, 720); assert.equal(out.displayHeight, 1270);
    assert.equal(wasClosed(), true);
    assert.equal(events.length, 1); assert.equal(events[0].reason, 'hevc-visible-rect-repaired');
    assert.deepEqual(events[0].coded, [720, 1272]);
    assert.deepEqual(events[0].browserVisible, [0, 0, 720, 1272]);
    assert.deepEqual(events[0].spsVisible, [0, 0, 720, 1270]);
  } finally { restore(); }
});
test('exact SPS visible rect passes through untouched', () => {
  const restore = installVideoFrameMock();
  try {
    const geometry = { codedWidth: 720, codedHeight: 1272, x: 0, y: 0, width: 720, height: 1270, sarNum: 1, sarDen: 1 };
    const { frame, wasClosed } = mockFrame([720, 1272], [0, 0, 720, 1270], [720, 1270]);
    const events: Record<string, unknown>[] = [];
    assert.equal(verifyHevcFrame(frame, geometry, e => events.push(e)), frame as unknown as VideoFrame);
    assert.equal(wasClosed(), false); assert.equal(events.length, 0);
  } finally { restore(); }
});
test('offset conformance window is repaired with x/y', () => {
  const restore = installVideoFrameMock();
  try {
    const geometry = { codedWidth: 720, codedHeight: 1272, x: 2, y: 2, width: 716, height: 1268, sarNum: 1, sarDen: 1 };
    const { frame } = mockFrame([720, 1272], [0, 0, 720, 1272], [720, 1272]);
    const out = verifyHevcFrame(frame, geometry) as unknown as { visibleRect: { x: number; y: number; width: number; height: number } };
    assert.deepEqual([out.visibleRect.x, out.visibleRect.y, out.visibleRect.width, out.visibleRect.height], [2, 2, 716, 1268]);
  } finally { restore(); }
});
test('smaller browser visible rect cannot be expanded', () => {
  const { frame } = mockFrame([720, 1272], [0, 0, 720, 1268], [720, 1268]);
  assert.throws(() => verifyHevcFrame(frame, { codedWidth: 720, codedHeight: 1272, x: 0, y: 0, width: 720, height: 1270, sarNum: 1, sarDen: 1 }), /无法安全修正/);
});
test('shifted browser visible rect cannot be shifted back', () => {
  const { frame } = mockFrame([720, 1272], [0, 2, 720, 1270], [720, 1270]);
  assert.throws(() => verifyHevcFrame(frame, { codedWidth: 720, codedHeight: 1272, x: 0, y: 0, width: 720, height: 1270, sarNum: 1, sarDen: 1 }), /无法安全修正/);
});
test('coded mismatch still falls back instead of relabeling', () => {
  const { frame } = mockFrame([1280, 736], [0, 0, 1280, 720], [1280, 720]);
  assert.throws(() => verifyHevcFrame(frame, parseHevcSpsGeometry(sps())), /编码尺寸/);
});
test('correct visible rect with wrong display only fixes aspect', () => {
  const restore = installVideoFrameMock();
  try {
    const geometry = { codedWidth: 720, codedHeight: 1272, x: 0, y: 0, width: 720, height: 1270, sarNum: 1, sarDen: 1 };
    const { frame, wasClosed } = mockFrame([720, 1272], [0, 0, 720, 1270], [721, 1272]);
    const events: Record<string, unknown>[] = [];
    const out = verifyHevcFrame(frame, geometry, e => events.push(e)) as unknown as { visibleRect: { width: number; height: number }; displayWidth: number; displayHeight: number };
    assert.equal(out.visibleRect.width, 720); assert.equal(out.displayWidth, 720); assert.equal(out.displayHeight, 1270);
    assert.equal(wasClosed(), true); assert.equal(events.length, 0);
  } finally { restore(); }
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
