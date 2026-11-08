import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveYuvColor, yuvToRgba, validateYuv } from '../../shared/color/yuv-color.ts';
import { yuvFixture } from '../helpers/yuv-fixture.ts';
import { uploadPixelBuffer } from '../../src/presentation/pixel-upload.ts';

test('GPU upload copies only alignment tails; truncated final padding preserves source samples', () => {
  for (const length of [1,2,3,4,7,8,9]) {
    const pixels = new Uint8Array(length + 3).fill(17).subarray(3), result = new Uint8Array(Math.ceil(length / 4) * 4);
    let borrowed = 0, copied = 0;
    uploadPixelBuffer({writeBuffer(_buffer:unknown,offset:number,data:ArrayBufferLike|Uint8Array,at=0,size?:number) {
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data,at,size);
      if (bytes.buffer === pixels.buffer) borrowed += bytes.byteLength; else copied += bytes.byteLength;
      result.set(bytes,offset);
    }}, {}, pixels);
    assert.deepEqual([...result.subarray(0,length)],[...pixels]);
    assert.ok(result.subarray(length).every(n => n === 0));
    assert.equal(borrowed,length - length % 4); assert.equal(copied,length % 4 ? 4 : 0);
  }
  const f = yuvFixture(8,false,false,'bt709',5,3), last = f.description.yuv!.planes.at(-1)!;
  const end = last.offset + (last.height - 1) * last.stride + last.width;
  const pixels = f.pixels.subarray(0,end), description = {...f.description,byteLength:end};
  assert.doesNotThrow(() => validateYuv(description,pixels.byteLength));
  assert.deepEqual(yuvToRgba(description,pixels),yuvToRgba(f.description,f.pixels));
});

test('SDR reference endpoints retain exact 8/10/12/16 bit ranges and neutral chroma',()=>{
  for(const depth of [8,10,12,16])for(const full of [false,true])for(const semi of [false,true]){
    const f=yuvFixture(depth,semi,full,'bt709',2,1);
    assert.deepEqual([...yuvToRgba(f.description,f.pixels)],[0,0,0,255,255,255,255,255]);
  }
});
test('independent BT.601/709 vectors distinguish matrix and range, without channel compensation',()=>{
  for(const [matrix,expected]of [['bt709',[255,24,0,255]],['smpte170m',[254,0,0,255]]] as const){
    const f=yuvFixture(8,false,false,matrix,2,1);f.write(0,0,0,81);f.write(1,0,0,90);f.write(2,0,0,240);
    assert.deepEqual([...yuvToRgba(f.description,f.pixels).slice(0,4)],expected);
  }
});
test('odd dimensions, padding, planar/NV12 and low/high aligned 10-bit are equivalent',()=>{
  const a=yuvFixture(10),b=yuvFixture(10,true),c=yuvFixture(10,true,false,'bt709',5,3,6);
  assert.deepEqual(yuvToRgba(a.description,a.pixels),yuvToRgba(b.description,b.pixels));
  assert.deepEqual(yuvToRgba(a.description,a.pixels),yuvToRgba(c.description,c.pixels));
  a.description.visibleRect={x:1,y:1,width:3,height:1};a.description.width=3;a.description.height=1;
  // This one-row crop uses only the chroma row intersecting it. The next
  // coded row (V=190) must not bleed into the crop through interpolation.
  assert.deepEqual([...yuvToRgba(a.description,a.pixels)], [64,66,38,255,128,135,51,255,191,201,90,255]);
  a.description.yuv!.planes[1].offset=a.pixels.length;
  assert.throws(()=>validateYuv(a.description,a.pixels.length));
});
test('color resolution records defaults separately and rejects unmanaged transfers',()=>{
  const f=yuvFixture();f.description.color={matrix:null,primaries:null,transfer:null,fullRange:null};
  const before=structuredClone(f.description.color);const plan=resolveYuvColor(f.description);
  assert.equal(plan.matrix,'smpte170m');assert.equal(plan.provenance.matrix,'fallback');assert.equal(plan.fullRange,false);
  assert.deepEqual(f.description.color,before);
  f.description.color.transfer='pq';assert.equal(resolveYuvColor(f.description).supported,false);
  f.description.color.transfer='hlg';assert.throws(()=>yuvToRgba(f.description,f.pixels));
});
