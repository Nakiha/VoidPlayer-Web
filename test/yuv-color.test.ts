import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveYuvColor, yuvToRgba, validateYuv } from '../src/yuv-color.ts';
import { yuvFixture } from './helpers/yuv-fixture.ts';

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
  const full=yuvToRgba(a.description,a.pixels);
  a.description.visibleRect={x:1,y:1,width:3,height:1};a.description.width=3;a.description.height=1;
  assert.deepEqual(yuvToRgba(a.description,a.pixels),full.slice(24,36));
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
