import test from 'node:test';
import assert from 'node:assert/strict';
import { isAnnexB, nalRanges } from '../../src/nal-framing.ts';
import { inspectPacketPicture } from '../../src/packet-picture.ts';
const annex=Uint8Array.of(0,0,0,1,0x40,1,0x80);

test('HEVC Annex-B and length-prefixed framing expose the same NAL bytes and preserve IDR-only anchor evidence',()=>{
  // Minimal header/first-slice evidence, not a complete decodable HEVC picture.
  for(const type of [19,20,21,8,9]){
    const nal=Uint8Array.of(type<<1,1,0x80);
    const stream=Uint8Array.from([0,0,1,...nal]);
    const hvcc=new Uint8Array(23);hvcc[0]=1;hvcc[21]=3;
    const prefixed=Uint8Array.from([0,0,0,nal.length,...nal]);
    const ranges=(description:Uint8Array,data:Uint8Array)=>nalRanges('hevc',description,data).map(n=>[...data.subarray(n.offset,n.offset+n.size)]);
    assert.deepEqual(ranges(annex,stream),ranges(hvcc,prefixed));
    assert.deepEqual(inspectPacketPicture('hevc',annex,stream),{singlePicture:true,closedRandomAccess:type===19||type===20},'CRA/RASL never become closed random-access anchors');
  }
});

test('HEVC Annex-B rejects short NALs, mixed picture evidence and nonzero layers',()=>{
  assert.throws(()=>nalRanges('hevc',annex,Uint8Array.of(0,0,1,0x42)),/NAL size/);
  assert.throws(()=>nalRanges('hevc',annex,Uint8Array.of(1,2,3)),/Annex-B prefix/);
  assert.equal(inspectPacketPicture('hevc',annex,Uint8Array.of(0,0,1,38,9,128)).reason,'unsupported-layer');
  assert.equal(inspectPacketPicture('hevc',annex,Uint8Array.of(0,0,1,38,1,128,0,0,1,38,1,128)).singlePicture,false);
});


test('legal leading_zero_8bits keep Annex-B framing and exact picture evidence',()=>{
  for(const codec of ['h264','hevc']){
    const nal=codec==='hevc'?[38,1,128]:[0x65,128];
    const ordinary=Uint8Array.from([0,0,0,1,...nal]);
    for(const zeros of [1,2,16]){
      const padded=Uint8Array.from([...new Uint8Array(zeros),...ordinary]);
      assert.equal(isAnnexB(padded),true);
      const ranges=nalRanges(codec,padded,padded);assert.equal(ranges.length,1);
      assert.deepEqual([...padded.subarray(ranges[0].offset,ranges[0].offset+ranges[0].size)],nal);
      assert.deepEqual(inspectPacketPicture(codec,padded,padded),inspectPacketPicture(codec,ordinary,ordinary));
    }
  }
  assert.equal(isAnnexB(new Uint8Array(32)),false);
  assert.equal(isAnnexB(Uint8Array.of(0,0,0,2,1)),false);
});
